#!/usr/bin/env node
/**
 * cnb-exec.js — CNB 云开发空间 轻量任务执行器（运行在 CNB 端）
 *
 * 被 cnb-task.js（本机）投递任务后，经 ssh 以 nohup 方式拉起，单次执行一个任务文件。
 * 双模式（2026-08-12 智能体执行器升级）：
 *   1. 代码块模式：任务文件含 ```bash / ```sh 代码块 → 逐个用 bash -c 执行（现有）
 *   2. pi 模式（智能体执行）：无代码块 → 任务全文作 prompt 交给 CNB 端 pi
 *      （pi --mode rpc，按任务头 agent/provider/model/thinking 选择身份与渠道），
 *      pi 按任务指示写 .DONE 回传。agent 身份 = org 同步副本 agents/<id>/identity.json 的 persona。
 *
 * 用法（CNB 端）：node /data/cnb-org/cnb-exec.js <inbox/任务名.md>
 * 本机无需直接调用——由 scripts/cnb-task.js 投递后自动拉起。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CNB_ORG = '/data/cnb-org';
const TASKS = path.join(CNB_ORG, 'tasks');
const LOGS  = path.join(CNB_ORG, 'logs');
const ORG_WORKSPACE = '/workspace';   // org git 同步副本（agents/ 身份在此）
const DEFAULT_PROVIDER = 'deepseek';  // 可信渠道（本机已注入 auth.json/models.json）
const DEFAULT_MODEL = 'deepseek-v4-pro';
const DEFAULT_THINKING = 'medium';
const PI_TIMEOUT_MS = 1800 * 1000;    // pi 单任务默认 30min（任务头 timeout 可覆盖）
const PI_SEND_DELAY_MS = 3000;        // pi RPC 官方协议：3 秒后发 prompt（与 lib/spawn.js 一致）

function log(...a) {
  const line = `[${new Date().toLocaleTimeString()}] [cnb-exec] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(LOGS, 'cnb-exec.log'), line + '\n', 'utf8'); } catch (e) {}
}

function extractCodeBlocks(text) {
  // 支持三种可执行块：```bash / ```sh / 无语言标记的 ```（防止 0 代码块谎报成功）
  // 要求代码块内容非空（以非空白开头），避免 ``` 紧邻造成的空块/跨块误匹配
  // 非 bash 语言块（```json/```python 等）因语言标记后跟语言名而非换行，天然不被匹配
  const blocks = [];
  const re = /```(?:bash|sh)?[ \t]*\r?\n([ \t]*\S[\s\S]*?)\r?\n?```/gi;
  for (const m of text.matchAll(re)) {
    const content = m[1].trim();
    if (!content) continue;
    blocks.push(content);
  }
  return blocks;
}

function findDonePath(text) {
  // 任务文件可能含多个「创建标记文件」路径：HK 桥追加的（/data/agent-cluster/...）
  // 与 CNB 桥追加的（/data/cnb-org/...）。本执行器跑在 CNB 空间，必须取 CNB 本地路径。
  // 修复：收集全部候选，优先选含 cnb-org 的；若无则把 agent-cluster 前缀归一为 cnb-org。
  const all = [...text.matchAll(/创建标记文件（一行摘要）：\s*(\S+)/g)]
    .map(m => m[1].replace(/^['"`]+|['"`]+$/g, ''));
  if (all.length === 0) return null;
  const cnb = all.find(p => p.includes('/cnb-org/'));
  if (cnb) return cnb;
  // 兜底：首个含 agent-cluster 的候选 → 归一为 CNB 路径
  const hk = all.find(p => p.includes('/agent-cluster/'));
  if (hk) return hk.replace('/agent-cluster/', '/cnb-org/');
  return all[0];
}

/* ── pi 模式（智能体执行）2026-08-12 ─────────────────────── */
/** 提取任务头字段（agent/provider/model/thinking/timeout） */
function headerOf(text, key) {
  const m = text.match(new RegExp('^' + key + '\\s*:\\s*(\\S+)', 'im'));
  return m ? m[1] : null;
}

/** 读取 org 同步副本中 agent 身份的 persona（identity.json），无则返回 null */
function readPersona(agentId) {
  for (const base of [ORG_WORKSPACE, CNB_ORG]) {
    try {
      const p = path.join(base, 'agents', agentId, 'identity.json');
      if (fs.existsSync(p)) {
        const id = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (id && id.persona) return id.persona;
      }
    } catch (e) { /* 下一个候选 */ }
  }
  return null;
}

/**
 * pi 模式：把任务全文作为 prompt 交给 CNB 端 pi（RPC 协议），
 * pi 按任务指示自行写 .DONE；此处兜底检查并补写完成标记。
 * @returns {Promise<number>} 退出码（0=成功）
 */
function runPiMode(taskFile, name, text, donePath) {
  return new Promise(resolve => {
    const agentId    = headerOf(text, 'agent') || 'coo';
    const provider   = headerOf(text, 'provider') || DEFAULT_PROVIDER;
    const model      = headerOf(text, 'model') || DEFAULT_MODEL;
    const thinking   = headerOf(text, 'thinking') || DEFAULT_THINKING;
    const timeoutSec = parseInt(headerOf(text, 'timeout') || '1800', 10);
    const persona    = readPersona(agentId);
    const timeoutMs  = Math.max(120, timeoutSec) * 1000;

    // 渠道就绪检查：缺 auth.json → 说明可信渠道未注入，直接失败（本机 cnb-task 自愈会注入）
    const agentDir = path.join(os.homedir(), '.pi', 'agent');
    if (!fs.existsSync(path.join(agentDir, 'auth.json'))) {
      fs.writeFileSync(donePath, `.FAILED: CNB pi 渠道未配置（缺 ${agentDir}/auth.json，需本机注入可信渠道）\n`, 'utf8');
      log(`[${name}] ❌ pi 渠道缺失 → 写 .FAILED`);
      resolve(1);
      return;
    }

    const sessionId = `cnb-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}`;
    const args = ['--mode', 'rpc', '--provider', provider, '--model', model,
                  '--thinking', thinking,
                  '--session-dir', path.join(CNB_ORG, 'sessions'),
                  '--session-id', sessionId, '--name', name];
    if (persona) { args.push('--append-system-prompt', persona); }
    log(`[${name}] 🧠 pi 模式: agent=${agentId} provider=${provider} model=${model} thinking=${thinking} timeout=${timeoutSec}s`);

    const child = spawn('pi', args, {
      cwd: ORG_WORKSPACE,          // org 同步副本为工作区（任务内容引用的 org 路径可解析）
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' }
    });
    // 收集 stdout 尾部（摘要用）+ 检测完成事件（agent_settled = 一轮处理完成）
    let stdoutTail = '';
    let settled = false;
    let promptFailed = false;
    child.stdout.on('data', d => {
      const s = String(d);
      stdoutTail = (stdoutTail + s).slice(-4000);
      // ⚠️ 2026-08-12 教训：pi RPC 的 stdin 'end' 事件会立即 shutdown（0.83/0.84 行为）——
      //    绝不能 end stdin！完成判定改为监听 stdout 的 agent_settled 事件。
      if (!settled && s.includes('"type":"agent_settled"')) {
        settled = true;
        log(`[${name}] ✅ 检测到 agent_settled（一轮完成），终止 pi 进程…`);
        try { child.kill('SIGINT'); } catch (e) {}
        // 给 pi 一点时间收尾；3s 后仍未退出则强杀
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 3000).unref();
      }
      // 模型调用失败（preflight 失败）→ 尽早标记，不等超时
      if (!promptFailed && s.includes('"success":false')) {
        promptFailed = true;
        log(`[${name}] ⚠️ pi prompt 失败响应，终止进程…`);
        try { child.kill('SIGINT'); } catch (e) {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 2000).unref();
      }
    });
    // pi RPC 官方协议：3 秒后发 prompt，但【不关 stdin】（stdin end 会导致 pi 立即退出）
    setTimeout(() => {
      try {
        child.stdin.write(JSON.stringify({
          type: 'prompt', message: text, id: 'p-' + Date.now(), streamingBehavior: 'steer'
        }) + '\n');
      } catch (e) {
        log(`[${name}] ⚠️ pi RPC 写入失败: ${e.message}`);
      }
    }, PI_SEND_DELAY_MS);

    const timer = setTimeout(() => {
      log(`[${name}] ⏰ pi 执行超时 ${timeoutSec}s → 终止`);
      try { child.kill('SIGKILL'); } catch (e) {}
      fs.writeFileSync(donePath, `.FAILED: pi 执行超时（${timeoutSec}s）\n`, 'utf8');
      resolve(1);
    }, timeoutMs);

    child.on('error', e => {
      clearTimeout(timer);
      fs.writeFileSync(donePath, `.FAILED: pi 启动失败: ${String(e.message).slice(0, 160)}\n`, 'utf8');
      log(`[${name}] ❌ pi 启动失败: ${e.message}`);
      resolve(1);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      log(`[${name}] pi 退出 code=${code}`);
      // prompt 失败响应（模型 preflight 失败）→ 写 .FAILED（即使退出码为 0）
      if (promptFailed) {
        const tail = stdoutTail.split('\n').filter(l => l.trim()).slice(-2).join(' / ');
        fs.writeFileSync(donePath, `.FAILED: pi prompt 失败（${tail.slice(0, 160)}）\n`, 'utf8');
        log(`[${name}] ❌ pi prompt 失败 → 写 .FAILED`);
        resolve(1);
        return;
      }
      // pi 已按任务指示写 .DONE → 保留；否则兜底补写（防 pi 忘记收尾）
      if (fs.existsSync(donePath) && !fs.readFileSync(donePath, 'utf8').includes('.FAILED')) {
        log(`[${name}] ✅ pi 已写 .DONE，保留`);
        resolve(0);
        return;
      }
      if (code === 0) {
        const tail = stdoutTail.split('\n').filter(l => l.trim()).slice(-3).join(' / ');
        fs.writeFileSync(donePath, `✅ CNB pi 任务 [${name}] 完成（agent=${agentId}）${tail ? '：' + tail.slice(0, 120) : ''}\n`, 'utf8');
        log(`[${name}] ✅ 兜底补写 .DONE`);
        resolve(0);
      } else {
        fs.writeFileSync(donePath, `.FAILED: pi 退出 code=${code}（${stdoutTail.split('\n').filter(l => l.trim()).slice(-2).join(' / ').slice(0, 160)}）\n`, 'utf8');
        log(`[${name}] ❌ pi 失败 code=${code} → 写 .FAILED`);
        resolve(1);
      }
    });
  });
}

function main() {
  const taskFile = process.argv[2];
  if (!taskFile) { console.error('用法: node cnb-exec.js <taskfile.md>'); process.exit(2); }
  const name = path.basename(taskFile, '.md');

  let text;
  try { text = fs.readFileSync(taskFile, 'utf8'); }
  catch (e) { console.error('读取任务文件失败:', taskFile, e.message); process.exit(2); }

  const donePath = findDonePath(text);
  if (!donePath) { console.error(`[${name}] 未找到 .DONE 路径（缺「创建标记文件（一行摘要）：」）`); process.exit(2); }

  const blocks = extractCodeBlocks(text);
  log(`任务 [${name}] 代码块=${blocks.length} 目标=${donePath}（${blocks.length > 0 ? '代码块模式' : 'pi 智能体模式'}）`);

  // pi 模式（2026-08-12）：无 bash/sh 代码块 → 智能体执行（任务全文作 prompt）
  if (blocks.length === 0) {
    runPiMode(taskFile, name, text, donePath).then(code => process.exit(code));
    return;
  }

  fs.mkdirSync(LOGS, { recursive: true });
  fs.mkdirSync(TASKS, { recursive: true });

  // 执行每个代码块（bash）
  let summary = '';
  try {
    for (let i = 0; i < blocks.length; i++) {
      log(`[${name}] 执行代码块 #${i + 1} (${blocks[i].length} chars)`);
      const r = spawnSync('bash', ['-c', blocks[i]], {
        cwd: TASKS, encoding: 'utf8', timeout: 1800000, maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PATH: process.env.PATH }
      });
      if (r.stdout) console.log(r.stdout.trim());
      if (r.stderr) console.error(r.stderr.trim());
      if (r.status !== 0) {
        log(`[${name}] 代码块 #${i + 1} 失败 code=${r.status}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
        fs.writeFileSync(donePath, `.FAILED: 代码块 #${i + 1} 失败 code=${r.status}\n`, 'utf8');
        process.exit(1);
      }
      if (r.stdout) summary = r.stdout.trim().split('\n').filter(l => l.trim()).slice(-3).join(' / ');
    }
  } catch (e) {
    log(`[${name}] 执行异常: ${e.message}`);
    fs.writeFileSync(donePath, `.FAILED: ${String(e.message).slice(0, 200)}\n`, 'utf8');
    process.exit(1);
  }

  // 成功：写 .DONE（若代码块自己写了 .DONE 则保留；否则写一行摘要）
  if (fs.existsSync(donePath) && !fs.readFileSync(donePath, 'utf8').includes('.FAILED')) {
    log(`[${name}] 代码块已写 .DONE，保留`);
  } else {
    fs.writeFileSync(donePath, `✅ CNB 任务 [${name}] 完成（${blocks.length} 代码块）${summary ? '：' + summary.slice(0, 100) : ''}\n`, 'utf8');
  }
  log(`✅ [${name}] 完成 → ${donePath}`);
  process.exit(0);
}

main();
