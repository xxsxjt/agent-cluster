#!/usr/bin/env node
/**
 * lib/hermes-run.js — HK Hermes 任务执行器（org 框架 ↔ hermes 桥）
 *
 * 原理：
 *   butler 派发 spawnType=hermes 的任务时，本脚本在本地（Windows）运行：
 *   1. 从 stdin 读取任务 prompt
 *   2. SSH 到 HK（tailscale 100.97.18.59:43891，root）
 *   3. HK 端：prompt 落盘 → source /etc/xxsx-hermes/org.env（root 600，凭据不落本地）
 *      → su xxsx-hermes 执行 hermes chat --provider org-newapi -q "$prompt" -Q（单次执行）
 *   4. 结果经 SSH stdout 回传 → 本地写 .DONE（成功）或 .FAILED（失败）
 *
 * 上游：hermes config.yaml 追加的 org-newapi provider（default 组渠道，夜间健康）；
 *       模型默认 deepseek-v4-flash，可用 -m 覆盖。
 * 凭据：SSH key 用用户现有 ~/.ssh/id_ed25519_xxsx_hk；API token 只在 HK 本地 org.env。
 *
 * 用法（由 lib/spawn.js 调用，无需手动执行）：
 *   node lib/hermes-run.js --done <inbox/xx.DONE> --log <logs/xx.log> [--model M] [--timeout S]
 *   任务 prompt 经 stdin 传入。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// HK 连接配置（用户既有 SSH 资产；不用明文凭据文件，key 走 ~/.ssh）
const HK_HOST = process.env.HERMES_HK_HOST || '103.100.159.111';   // 2026-08-11 改：公网 IP
const HK_PORT = process.env.HERMES_HK_PORT || '43891';
const HK_KEY  = process.env.HERMES_HK_KEY  || path.join(process.env.USERPROFILE || 'C:/Users/du_ji', '.ssh', 'id_ed25519_xxsx_hk');
const MAX_TURNS = 24;   // hermes 最大执行轮数（工具调用也算轮）

// HK 端执行脚本（bash -c 接收）：stdin 收 prompt 落盘 → source org.env →
// heredoc 写内层脚本（无引号嵌套）→ su xxsx-hermes 执行 hermes chat 单次执行
// 占位符 HTM/HTN/HTS 在 JS 侧替换（避免 shell 展开歧义）
const HK_SCRIPT = `
set -u
umask 077
P=/tmp/org-hermes-prompt-$$.txt
cat > "$P" 2>/dev/null || exit 90
chmod 644 "$P" 2>/dev/null || true
set -a; . /etc/xxsx-hermes/org.env 2>/dev/null; set +a
if [ -z "\${ORG_OPENAI_API_KEY:-}" ]; then echo "FATAL: org.env missing ORG_OPENAI_API_KEY" >&2; rm -f "$P"; exit 91; fi
cat > /tmp/org-hermes-inner-$$.sh <<'INNER_EOF'
#!/bin/bash
export HOME=/var/lib/xxsx-hermes/home
export HERMES_HOME=/var/lib/xxsx-hermes/home
exec /opt/xxsx-hermes/current-venv/bin/python -m hermes_cli.main chat \\
  --provider org-newapi -m "HTM" -q "$(cat "$ORG_PROMPT")" -Q --max-turns "HTN"
INNER_EOF
chmod 755 /tmp/org-hermes-inner-$$.sh
cd /var/lib/xxsx-hermes/work
timeout "HTS" su -p -s /bin/bash xxsx-hermes -c "ORG_PROMPT=$P bash /tmp/org-hermes-inner-$$.sh"
RC=$?
rm -f "$P" /tmp/org-hermes-inner-$$.sh
exit $RC
`;

function main() {
  const argv = process.argv.slice(2);
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const donePath = get('--done');
  const logPath  = get('--log');
  const model    = get('--model') || process.env.HERMES_MODEL || 'deepseek-v4-flash';
  const timeoutS = parseInt(get('--timeout') || process.env.HERMES_TIMEOUT || '900', 10);

  if (!donePath) { console.error('usage: hermes-run.js --done <path> [--log path] [--model M]'); process.exit(2); }

  // 收集 stdin prompt
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { prompt += d; });
  process.stdin.on('end', () => run(prompt, donePath, logPath, model, timeoutS));
  process.stdin.resume();
}

function run(prompt, donePath, logPath, model, timeoutS) {
  const log = (line) => {
    const s = `[${new Date().toISOString()}] ${line}`;
    console.log(s);
    if (logPath) { try { fs.appendFileSync(logPath, s + '\n', 'utf8'); } catch (e) {} }
  };
  log(`hermes-run 启动 model=${model} timeout=${timeoutS}s prompt_len=${prompt.length}`);
  if (!prompt.trim()) { finish(donePath, '.FAILED: 空任务（stdin 无内容）', log); return; }

  // 任务要求注入到 prompt 末尾（hermes 侧按要求输出）
  const effective = prompt + '\n\n【执行要求】\n1. 直接执行任务，不要询问确认。\n2. 完成后在回答最后一行输出一行摘要（以 DONE: 开头）。\n3. 无法完成时输出 FAILED: 原因。';

  const script = HK_SCRIPT
    .replace(/HTM/g, model)
    .replace(/HTN/g, String(MAX_TURNS))
    .replace(/HTS/g, String(timeoutS));

  // 两段式（避免 ssh 远端对多行命令参数的重新解析破坏引号/换行）：
  // 1) cat > /tmp/org-hermes-run.sh 传入脚本内容（stdin）
  // 2) bash /tmp/org-hermes-run.sh 执行（stdin 传 prompt）
  const remote = `${process.env.HERMES_HK_USER || 'root'}@${HK_HOST}`;
  let out = '', err = '';
  const base = ['-p', HK_PORT, '-i', HK_KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
                '-o', 'StrictHostKeyChecking=accept-new'];
  log(`ssh ${HK_HOST}:${HK_PORT} 上传脚本`);
  const up = spawn('ssh', [...base, remote, 'cat', '>/tmp/org-hermes-run.sh'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  up.stdout.on('data', d => { out += d; });
  up.stderr.on('data', d => { err += d; });
  up.stdin.write(script + '\n');
  up.stdin.end();
  up.on('exit', (code) => {
    if (code !== 0) {
      finish(donePath, `.FAILED: 脚本上传失败 code=${code} ${err.slice(-200)}`, log);
      return;
    }
    log(`ssh ${HK_HOST}:${HK_PORT} 执行脚本`);
    const child = spawn('ssh', [...base, remote, 'bash', '/tmp/org-hermes-run.sh'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.stdin.write(effective + '\n');
    child.stdin.end();

    const timer = setTimeout(() => {
      log('⏰ hermes 执行超时，强制结束 ssh');
      try { child.kill(); } catch (e) {}
    }, (timeoutS + 60) * 1000);

    child.on('error', e => {
      clearTimeout(timer);
      finish(donePath, `.FAILED: ssh 启动失败 ${e.message}`, log);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      log(`ssh 退出 code=${code}`);
      // 提取 hermes 最终回答：优先取 session_id 之后的内容（-Q 模式输出），兜底最后一行
      const lines = out.split('\n');
      const result = extractResult(lines, out);
      if (code === 0 && result) {
        const summary = result.length > 600 ? result.slice(0, 600) + '…' : result;
        finish(donePath, summary, log);
      } else {
        const why = code === 124 ? 'HK 端执行超时' : (err.trim().slice(-300) || out.trim().slice(-300) || '未知错误');
        finish(donePath, `.FAILED: ssh code=${code} ${why}`, log);
      }
    });
  });
}

// 从 hermes -Q 输出提取最终回答
function extractResult(lines, out) {
  // -Q 模式 stdout 结构：┌─ Reasoning ─┐ 框线行 + reasoning 内容行 + 最终回答
  // （框线/推理不进结果；session_id 在 stderr，不可用）
  const ridx = lines.findIndex(l => l.includes('┌─ Reasoning'));
  if (ridx >= 0) {
    const after = lines.slice(ridx + 2).join('\n').trim();
    if (after) return after;
  }
  // 兜底：最后一行
  const nonEmpty = lines.map(l => l.trim()).filter(Boolean);
  return nonEmpty.length ? nonEmpty[nonEmpty.length - 1] : null;
}

function finish(donePath, content, log) {
  try {
    fs.writeFileSync(donePath, content, 'utf8');
    log(`✅ 已写完成标记: ${path.basename(donePath)} → ${content.slice(0, 80)}`);
  } catch (e) {
    log(`❌ 写完成标记失败: ${e.message}`);
    process.exitCode = 1;
  }
  process.exit(0);
}

if (require.main === module) main();
module.exports = { HK_SCRIPT, extractResult };
