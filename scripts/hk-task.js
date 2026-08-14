#!/usr/bin/env node
/**
 * hk-task.js — 本机 → HK 任务分发桥（分担 Windows 负载）
 *
 * 职责：本地任务文件投递到 HK org inbox → HK butler 捡起执行（pi/hk-exec）
 *       → 轮询 HK .DONE/.FAILED → 拉回本地 inbox + 拉回 HK 任务日志。
 *
 * 用法：
 *   node scripts/hk-task.js <taskfile.md> [--wait] [--timeout <秒>] [--poll <秒>]
 *
 *   <taskfile.md>   本地任务文件（绝对或相对路径，如 inbox/xxx.md 或任意 .md）
 *   --wait          等待完成并拉回结果（默认开启；传 --no-wait 只投递）
 *   --timeout <秒>  最大等待秒数（默认 7200 = 2h；任务文件头部 timeout: <秒> 可覆盖）
 *   --poll <秒>     轮询间隔（默认 5）
 *
 * 行为：
 *   1. 任务文件追加「执行要求」包装（HK hk-exec 需要从中提取 .DONE 路径）
 *   2. scp 到 HK /data/agent-cluster/inbox/<name>.md（幂等：HK 已有 .DONE 则直接拉回）
 *   3. 轮询 HK .DONE/.FAILED → scp 回本地 org/inbox/<name>.DONE（供本地 butler 收尾）
 *   4. 尽力拉回 HK logs/<name>.log → 本地 org/logs/<name>.hk.log（不存在则忽略）
 *   5. 超时/失败：写本地 .DONE 为 .FAILED: <原因>，退出码非 0
 *
 * SSH 凭据不落代码明文之外（key 路径来自 ~/.ssh，端口/主机为 HK 既有拓扑）。
 */
'use strict';
// Windows 下 ssh/scp 弹窗闪现修复：改走 win-spawn 兜底（默认 windowsHide:true），见 lib/win-spawn.js
const { execFile, execFileSync } = require('../lib/win-spawn');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 软超时（2026-08-11 soft-timeout）：到期先询问不杀，复用 task-watchdog 询问机制
const soft = require('../lib/soft-timeout');
const SOFT_AGENT = 'server-admin';      // HK 任务对应的本地看护智能体（管 HK 拓扑）
const SOFT_GRACE_SEC = 10 * 60;         // 软超时宽限期（超时后最多再等 10min 判定真卡死）
const SOFT_ACTIVE_LOOKBACK_MS = 180000; // 远端日志 mtime 距今 3min 内视为活跃（续期依据）

const ORG_ROOT = path.resolve(__dirname, '..');
const INBOX    = path.join(ORG_ROOT, 'inbox');
const LOGS     = path.join(ORG_ROOT, 'logs');

// ── HK 连接常量（与 work_record 拓扑一致：xxsx-main-hk = 100.97.18.59:43891） ──
// 2026-08-11 hk-exec-hub 改：Tailscale 链路挂，公网可达 103.100.159.111:43891；支持 HK_HOST 环境变量覆盖
const HK_HOST = process.env.HK_HOST || '103.100.159.111';
const HK_PORT = '43891';
const HK_USER = 'root';
const HK_KEY  = path.join(os.homedir(), '.ssh', 'id_ed25519_xxsx_hk');
const HK_ORG  = '/data/agent-cluster';
const HK_INBOX = `${HK_ORG}/inbox`;
const HK_LOGS  = `${HK_ORG}/logs`;

const SSH_BASE = ['-p', HK_PORT, '-i', HK_KEY, '-o', 'BatchMode=yes',
                  '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
                  '-o', 'StrictHostKeyChecking=accept-new'];
const SSH_DEST = `${HK_USER}@${HK_HOST}`;

/* ── 小工具 ─────────────────────────────────────────────── */
function log(...a) {
  const line = `[${new Date().toLocaleTimeString()}] [hk-task] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(LOGS, 'hk-task.log'), line + '\n', 'utf8'); } catch (e) {}
}

function ssh(cmd, timeoutMs) {
  return new Promise(resolve => {
    execFile('ssh', [...SSH_BASE, SSH_DEST, cmd], { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs || 60000 },
      (err, stdout, stderr) => {
        // HK sshd 较老：本机 OpenSSH 每次连接都打 post-quantum 警告到 stderr（无害），过滤掉；
        // 远端命令 exit code≠0（如 test 未命中）不代表 ssh 失败——以 stdout 内容为准。
        const cleanErr = String(stderr || '').split('\n').filter(l => !l.includes('post-quantum') && !l.includes('store now') && !l.includes('upgraded')).join('\n').trim();
        resolve({ ok: !err || !!cleanErr, code: err ? err.code : 0, out: (stdout || '').trim(), err: cleanErr });
      });
  });
}

function scp(from, to) {
  return new Promise(resolve => {
    // Windows OpenSSH scp 端口参数为大写 -P（ssh 才用 -p）
    const scpBase = ['-P', HK_PORT, '-i', HK_KEY, '-o', 'BatchMode=yes',
                     '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new'];
    execFile('scp', [...scpBase, from, to], { maxBuffer: 32 * 1024 * 1024, timeout: 120000 },
      (err) => resolve({ ok: !err, code: err ? err.code : 0, err: err ? String(err.message || err) : '' }));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 解析参数 ───────────────────────────────────────────── */
function parseArgs(argv) {
  const args = { file: null, wait: true, timeout: 7200, poll: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wait') args.wait = true;
    else if (a === '--no-wait') args.wait = false;
    else if (a === '--timeout') args.timeout = parseInt(argv[++i], 10) || args.timeout;
    else if (a === '--poll') args.poll = Math.max(2, parseInt(argv[++i], 10) || 5);
    else if (!a.startsWith('-') && !args.file) args.file = a;
  }
  return args;
}

// 任务头部可选 timeout: <秒> 覆盖
function headerTimeout(filePath, fallback) {
  try {
    const head = fs.readFileSync(filePath, 'utf8').slice(0, 800);
    const m = head.match(/^timeout\s*:\s*(\d+)/im);
    if (m) return Math.max(30, parseInt(m[1], 10));
  } catch (e) {}
  return fallback;
}

/* ── 主流程 ─────────────────────────────────────────────── */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('用法: node scripts/hk-task.js <taskfile.md> [--wait|--no-wait] [--timeout <秒>] [--poll <秒>]');
    process.exit(2);
  }

  const taskFile = path.resolve(process.cwd(), args.file);
  if (!fs.existsSync(taskFile)) { console.error('任务文件不存在:', taskFile); process.exit(2); }

  const name = path.basename(taskFile, '.md');
  const hkDone  = `${HK_INBOX}/${name}.DONE`;
  const hkFail  = `${HK_INBOX}/${name}.FAILED`;
  const localDone = path.join(INBOX, `${name}.DONE`);
  const timeoutSec = headerTimeout(taskFile, args.timeout);
  const baseDeadline = Date.now() + timeoutSec * 1000; // 原始超时点（软超时续期时重置）
  let deadline = baseDeadline;
  let softEnteredAt = null;   // null=未进入软超时；进入后=首次到期时刻(ms)
  let softDeadline = 0;       // 软超时宽限截止（进入软超时后 deadline + SOFT_GRACE_SEC）

  log(`任务 [${name}] 文件=${taskFile} 超时=${timeoutSec}s 轮询=${args.poll}s`);

  // 0) 可达性检查（快速失败，避免干等）
  const ping = await ssh(`echo __HK_OK__ && systemctl is-active org-butler || true`);
  if (!ping.out.includes('__HK_OK__')) {
    log(`❌ HK 不可达: ${ping.err || ping.out || 'ssh 失败'}`);
    fs.writeFileSync(localDone, `.FAILED: HK 不可达（${(ping.err || 'ssh fail').slice(0, 120)}）\n`, 'utf8');
    process.exit(1);
  }
  const butlerState = ping.out.replace('__HK_OK__', '').trim();
  log(`✅ HK 可达，org-butler=${butlerState || '?'}`);

  // 1) HK 是否已有完成标记（幂等：任务此前已跑过）→ 直接拉回
  const has = await ssh(`test -f ${hkDone} && echo DONE; test -f ${hkFail} && echo FAILED`);
  if (has.out.includes('DONE') || has.out.includes('FAILED')) {
    log('ℹ️ HK 已有完成标记，直接拉回（幂等跳过投递）');
    await pullBack(localDone, hkDone, hkFail, name);
    process.exit(fs.readFileSync(localDone, 'utf8').includes('.FAILED') ? 1 : 0);
  }

  // 2) 包装任务内容（追加执行要求，HK hk-exec 需要提取 .DONE 路径）
  const wrapped = [
    fs.readFileSync(taskFile, 'utf8').trimEnd(),
    '',
    '---',
    '执行要求（HK 桥自动追加）：',
    '1. 独立完成，不等待外部指令',
    `2. 完成后创建标记文件（一行摘要）：${hkDone}`,
    `3. 若无法完成，写 ${hkDone} 内容为 .FAILED: <原因>`,
    ''
  ].join('\n');
  const staging = path.join(LOGS, `.hk-staging-${name}.md`);
  fs.writeFileSync(staging, wrapped, 'utf8');

  // 3) scp 投递到 HK inbox
  const up = await scp(staging, `${SSH_DEST}:${HK_INBOX}/${name}.md`);
  try { fs.unlinkSync(staging); } catch (e) {}
  if (!up.ok) {
    log(`❌ scp 投递失败: ${up.err.slice(0, 200)}`);
    fs.writeFileSync(localDone, `.FAILED: scp 投递失败 ${up.err.slice(0, 120)}\n`, 'utf8');
    process.exit(1);
  }
  log(`🚀 已投递 → ${HK_INBOX}/${name}.md，等 HK butler 捡起执行`);

  if (!args.wait) {
    log('ℹ️ --no-wait 模式，投递完成即退出（结果稍后可用 node scripts/hk-task.js ' +
        path.basename(taskFile) + ' --wait 拉取）');
    process.exit(0);
  }

  // 4) 轮询 HK .DONE/.FAILED（软超时：到期先询问不杀，远端仍活跃则续期）
  while (true) {
    await sleep(args.poll * 1000);
    const r = await ssh(`test -f ${hkDone} && echo DONE; test -f ${hkFail} && echo FAILED`);
    if (r.out.includes('DONE') || r.out.includes('FAILED')) {
      await pullBack(localDone, hkDone, hkFail, name);
      const content = fs.readFileSync(localDone, 'utf8').trim();
      log(content.startsWith('.FAILED')
        ? `❌ HK 任务 [${name}] 失败 → ${content.slice(0, 160)}`
        : `✅ HK 任务 [${name}] 完成 → ${content.slice(0, 160)}`);
      process.exit(content.startsWith('.FAILED') ? 1 : 0);
    }

    // ── 到期后的软超时处理：首次到期 → 投 checkpoint 询问；随后查远端活跃 → 续期 / 宽限到 → 卡死 ──
    if (Date.now() >= deadline) {
      if (softEnteredAt === null) {
        softEnteredAt = Date.now();
        softDeadline = softEnteredAt + SOFT_GRACE_SEC * 1000;
        const q = soft.askSoftTimeout(name, SOFT_AGENT,
          `HK 任务超时（${timeoutSec}s）但可能仍在跑，请确认远端是否继续`);
        log(`⏰ [${name}] 超时 ${timeoutSec}s 未完成 → 软超时：已投 checkpoint 询问（${q || '已在队列'}），宽限 ${SOFT_GRACE_SEC / 60}min 观察远端活动`);
      }
      // 查远端任务日志 mtime：活跃窗口内仍有输出 = 还在跑 → 续期（不杀）
      const la = await ssh(`f=${HK_LOGS}/${name}.log; test -f $f && stat -c %Y $f || echo 0`);
      const logMtime = parseInt(la.out, 10) || 0;
      if (soft.isRemoteActive(logMtime)) {
        deadline = Date.now() + timeoutSec * 1000;
        softEnteredAt = null;
        log(`♻️ [${name}] 远端日志仍活跃（mtime=${logMtime}）→ 软超时续期，再等 ${timeoutSec}s`);
        continue;
      }
      if (Date.now() >= softDeadline) {
        log(`❌ [${name}] 软超时宽限 ${SOFT_GRACE_SEC / 60}min 已过且远端日志停滞（mtime=${logMtime}）→ 判定真卡死，结束`);
        fs.writeFileSync(localDone, `.FAILED: HK 任务超时（${timeoutSec}s）且软超时宽限后远端仍无活动，判定卡死\n`, 'utf8');
        process.exit(1);
      }
    }

    const elapsed = Math.round((Date.now() - (deadline - timeoutSec * 1000)) / 1000);
    if (elapsed % 60 < args.poll) log(`⏳ [${name}] HK 执行中… ${elapsed}s/${timeoutSec}s`);
  }
}

/* ── 拉回结果 + HK 日志 ─────────────────────────────────── */
async function pullBack(localDone, hkDone, hkFail, name) {
  // .DONE / .FAILED 谁存在拉谁
  const dl = await scp(`${SSH_DEST}:${hkDone}`, localDone);
  if (!dl.ok) {
    const dl2 = await scp(`${SSH_DEST}:${hkFail}`, localDone);
    if (!dl2.ok) {
      log(`⚠️ 拉回完成标记失败: ${dl.err.slice(0, 120)}`);
      fs.writeFileSync(localDone, '.FAILED: 拉回 HK 完成标记失败\n', 'utf8');
      return;
    }
  }
  // 尽力拉回 HK 任务日志（不存在则忽略）
  const localLog = path.join(LOGS, `${name}.hk.log`);
  const ll = await scp(`${SSH_DEST}:${HK_LOGS}/${name}.log`, localLog);
  if (ll.ok) log(`📄 已拉回 HK 日志 → ${path.relative(ORG_ROOT, localLog)}`);
  // 尽力拉回 HK 结构化结果（约定：任务代码块可写 /data/agent-cluster/logs/<name>.result）
  const localResult = path.join(LOGS, `${name}.hk.result`);
  const lr = await scp(`${SSH_DEST}:${HK_LOGS}/${name}.result`, localResult);
  if (lr.ok) log(`📄 已拉回 HK 结果 → ${path.relative(ORG_ROOT, localResult)}`);
}

main().catch(e => {
  console.error('hk-task.js 异常:', e);
  try {
    fs.writeFileSync(path.join(INBOX, 'hk-task-fatal.DONE'), '.FAILED: ' + String(e.message).slice(0, 200) + '\n', 'utf8');
  } catch (_) {}
  process.exit(1);
});
