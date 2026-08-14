#!/usr/bin/env node
/**
 * butler.js — v5 管家（COO）智能体
 *
 * 职责：
 *   接收 inbox/ 任务 → 按 org.json 路由 → 派发子智能体 → 监控完成 → 更新状态 → 定期摘要
 *
 * 用法：
 *   node butler.js                      # 常驻模式（单实例锁）
 *   node butler.js --once               # 单轮处理
 *   node butler.js --spawn <group-id>   # 派生分身，专管某组
 *   node butler.js --summary            # 输出当前各组摘要
 *
 * 单实例锁：org/butler.pid（双开时第二个进程退出）
 * 任务文件：org/inbox/<name>.md → 完成后写 org/inbox/<name>.DONE
 * 日志：     org/logs/butler.log
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const registry = require('./lib/registry');
const { spawnAgent, sendRPC } = require('./lib/spawn');
const { pickSide } = require('./lib/route-auto');   // auto 侧路由：构建→本机，服务/重活→HK
const cf = require('./lib/channel-fallback');       // 渠道 fallback 控制器（含空回复检测，2026-08-09）
const rl = require('./lib/resource-lock');           // 共享资源锁校验（2026-08-10 promise-audit P0）
const cpuGate = require('./lib/cpu-gate');           // CPU 负载门禁（2026-08-11）：构建任务高负载暂缓/转CNB
const nodeLoad = require('./lib/node-load');           // 全节点负载（2026-08-11 load-quota-fix）：本机/HK/CNB 负载保护
const fullscanGuard = require('./lib/fullscan-guard'); // 全盘 find/grep 检测看护（2026-08-11 fullscan-guard）：防全盘扫描卡死
const anomaly = require('./lib/anomaly-fallback'); // 进程异常退出兜底（2026-08-12 失败判定体系化加固）：补DONE/已闭环跳过/自动重派

const ORG_ROOT = __dirname;
const INBOX   = path.join(ORG_ROOT, 'inbox');
const LOGS    = path.join(ORG_ROOT, 'logs');
/* 插嘴通道（2026-08-07）：
 * - ACTIVE_TABLE = 共享表：butler 把 active 子进程表落盘，web server.js 可查（跨进程无法直接传 stdin 句柄）
 * - INTERJECT_DIR = 请求队列：server.js 写 <task>.json（{message}）→ butler fs.watch 秒级捡起
 *   → sendRPC 送入 pi rpc 子进程 stdin（{type:'prompt', streamingBehavior:'steer'}）→ 写 <task>.ack 回执 */
const ACTIVE_TABLE   = path.join(LOGS, 'active-tasks.json');
/* 任务并发限制 + 类型路由（2026-08-11 concurrency-routing）：config/butler.json 控制 */
const BUTLER_CFG_FILE  = path.join(ORG_ROOT, 'config', 'butler.json');
const WAITING_TABLE    = path.join(LOGS, 'waiting-tasks.json');   // 排队任务登记（并发限制用）
const butlerCfg = () => readJsonSafe(BUTLER_CFG_FILE) || {};
const maxConcurrent = () => {
  const c = butlerCfg().maxConcurrent;
  return (typeof c === 'number' && c >= 1) ? c : 3;   // 默认 3
};
// 本机当前活动任务数（只统计跑在本机的任务；hk/cnb 属远程，不计入本机并发）
const localActiveCount = () => {
  let n = 0;
  for (const [, e] of active.entries()) {
    if (e.agentId === 'hk' || e.agentId === 'cnb-dev') continue;  // 远程桥不计本机并发
    n++;
  }
  return n;
};
// 紧急任务判定（2026-08-11）：用户直投/异常恢复优先于自动派发
const URGENT_MARKERS = [/^checkpoint-/, /^review-/, /^复盘/, /^巡检/, /^daily-meeting/, /^intel-collect/, /auto-schedule/, /^auto-opt/, /^meeting-card-/, /^meeting-plan-/, /^meeting-anomaly-/, /^meeting-learn-/, /^meeting-peer-/];
const isAutoDispatch = name => URGENT_MARKERS.some(re => re.test(name));
const isUrgentTask = task => {
  if (!task || !task.name) return false;
  if (isAutoDispatch(task.name)) return false;       // 自动派发（checkpoint/复盘/巡检）→ 低优先可排队
  return true;                                        // 其余（用户直投/异常恢复）→ 优先
};
const readWaiting = () => readJsonSafe(WAITING_TABLE) || {};
const writeWaiting = w => writeJsonSafe(WAITING_TABLE, w);
const INTERJECT_DIR  = path.join(INBOX, 'interject');
const PID_FILE = path.join(ORG_ROOT, 'butler.pid');
const LOG_FILE = path.join(LOGS, 'butler.log');
const DISC_DIR    = path.join(INBOX, 'discussion');          // 分身↔管家讨论通道（2026-08-08）
const MEETINGS_DIR = path.join(ORG_ROOT, 'knowledge', 'meetings');
const DEC_DIR     = path.join(INBOX, 'decisions');          // 决策委托通道（2026-08-08）：分身决策结果 .decision.md
const RECOVERY_FLAG_DIR = path.join(INBOX, '.recovery');   // 异常重跑标记（2026-08-08）：recovery 重跑完成时据此跳过用户通知
const SLEEP_FLAG  = path.join(ORG_ROOT, 'sleep-mode.flag');   // 睡前/关机模式标记（2026-08-08）
const SLEEP_SHUTDOWN_NOTE = path.join(ORG_ROOT, 'LAST_SHUTDOWN_NOTE.txt');   // 睡前自动关机快照（2026-08-11）
const SLEEP_SHUTDOWN_CFG  = path.join(ORG_ROOT, 'config', 'sleep-shutdown.json');   // 睡前关机联动配置（可改即生效）
const PLANS_DIR   = path.join(ORG_ROOT, 'plans');            // 计划文档目录
const PLANS_NEXT  = path.join(PLANS_DIR, 'next-boot');       // 待启动派发的计划
const PLANS_DONE  = path.join(PLANS_DIR, 'done');            // 已恢复/归档的计划

const POLL_MS   = 15000;   // 轮询间隔
const SUMMARY_EVERY = 10;  // 每 N 轮输出一次摘要
const MAX_RETRIES = 3;     // 任务最大重试次数
/* 异常中断自动恢复（2026-08-08 巡查增强）：
 * - 进程死检测：active 任务 pid 不存在（ESRCH）→ 立即标记失败，不等日志停滞/90 分钟
 * - 日志停滞检测：任务日志 20 分钟无更新 + 无 .DONE → 标记疑似卡死
 * - 标记后写恢复决策请求 inbox/decisions/ → 分身决策（重跑/归档）→ 按决策执行
 * - 重跑防循环：同任务重跑超过 MAX_RERUN 次 → 强制归档 + 升级用户，不再自动重跑 */
const LOG_STALL_MS   = 20 * 60 * 1000;   // 日志停滞阈值（20 分钟）
const STALL_GRACE_MS = 2 * 60 * 1000;    // 新任务宽松期（避免误杀刚启动、日志尚未写入的任务）
const SETTLED_GRACE_MS = 60 * 1000;      // agent_settled 后进程未退出的宽限期（2026-08-09：settled 是完成标志，宽限后仍不退 → 标记成功而非失败）
const MAX_RERUN      = 2;                // 异常重跑上限
const RETRY_DELAY_MS = 3000;             // 渠道重试间隔（2026-08-11 load-quota-fix：多给几次重试，偶尔不稳定）
const RECOVERY_COUNT = path.join(LOGS, 'recovery-count.json');  // 各任务异常重跑计数

const readIf  = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const readJsonSafe = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const writeJsonSafe = (p, o) => { try { fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8'); } catch (e) {} };
const isAlive = pid => {
  if (!pid || Number.isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
};
/* 子进程优雅收尾（2026-08-10「agent_settled 进程不退出」根因修复）：
 *  pi RPC 子进程是长驻会话：发完 agent_settled 后不会自行退出（等 stdin 下一条 RPC）。
 *  butler 为 interject/steer 一直开着 stdin，任务完成后若不主动关闭，进程会永久残留（实测一堆孤儿 node.exe）。
 *  收尾顺序：① 关 stdin 让 pi 自然退出 → ② SIGTERM → ③ win32 taskkill /t /f 兜底强杀。 */
function terminateChild(entry, label) {
  if (!entry || !entry.child) return false;
  const c = entry.child;
  const pid = c.pid;
  if (!pid) return false;
  const alive = isAlive(pid);
  if (!alive) return false;
  log(`${label || 'ℹ️'} 终止子进程 pid=${pid}（stdin.end → SIGTERM → taskkill 兜底）`);
  try { c.stdin.end(); } catch (e) {}
  try { c.kill('SIGTERM'); } catch (e) {}
  if (process.platform === 'win32') {
    try { require('child_process').spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
  }
  return true;
}
/* 统一任务收尾（2026-08-11 孤儿进程根治）：
 * 所有【终态】任务结束路径（成功/失败完成、看护判定完成）统一走此函数，一次做齐三件事：
 *   ① terminateChild 终止子进程（stdin.end→SIGTERM→taskkill，幂等）
 *   ② 同步删除 inbox/<task>.PID 标记文件——不依赖异步 exit 回调
 *      （此前只 terminateChild+active.delete、漏删 PID；被杀进程 exit 未触发就永远残留）
 *   ③ 从 active map 移除 + 落盘
 * ⚠️ 异常重跑路径（failTaskAnomaly→autoRerunTask）会重派同名任务、重写同名 PID，
 *      绝不能在此调 finalizeTask（否则误删重跑任务刚写入的 PID）——那类路径已由 autoRerunTask 自清 PID。 */
function finalizeTask(name, entry, reason) {
  if (!entry) return false;
  terminateChild(entry, reason ? `🧹 [${reason}]` : '🧹 [收尾]');
  try { if (entry.pidPath && fs.existsSync(entry.pidPath)) fs.unlinkSync(entry.pidPath); } catch (e) {}
  if (active.has(name)) { active.delete(name); persistActive(); }
  return true;
}

/* 孤儿进程清扫（2026-08-11 孤儿进程根治）：
 * 扫描 inbox/*.PID，清理三类残留：
 *   ① PID 对应进程已死 → 删残留 PID 文件
 *   ② PID 对应进程存活但不在 active map（= butler 重启后 active 丢失的孤儿子进程）→ 强杀 + 删文件
 *   ③ 已有 .DONE 但 PID 文件没清（任务完成漏删）→ 杀残留（若活）+ 删文件
 * 安全护栏：PID 存活且在 active = 正常在跑任务 → 绝不动。
 * 幂等；仅在主管家（!spawnGroupId）执行——分身 active 表不全，可能误杀主管家正在跑的任务。
 * @returns {number} 清理的残留数量 */
function sweepOrphans() {
  if (!fs.existsSync(INBOX)) return 0;
  let cleaned = 0;
  const files = fs.readdirSync(INBOX).filter(f => f.endsWith('.PID'));
  for (const f of files) {
    try {
      const name    = f.slice(0, -'.PID'.length);
      const pid     = parseInt(readIf(path.join(INBOX, f)) || '', 10);
      const alive   = isAlive(pid);
      const inActive = active.has(name);
      const hasDone = readIf(path.join(INBOX, name + '.DONE')) != null;
      if (alive && inActive) continue;   // 正常在跑，绝不动
      // 构造最小 entry 仅用于 terminateChild 杀进程（stdin/kill 内部均有 try/catch）
      const orphanEntry = { child: { pid, stdin: { end() {} }, kill() {} }, pidPath: path.join(INBOX, f) };
      if (alive && !inActive) {
        log(`🧹 [孤儿清扫] ${name}: 孤儿子进程 pid=${pid} 不在 active（重启残留）→ 强杀 + 删 PID`);
        terminateChild(orphanEntry, '🧹 [孤儿清扫]');
      } else if (hasDone) {
        log(`🧹 [孤儿清扫] ${name}: 已完成(.DONE)但 PID 未清 → ${alive ? '杀残留进程 ' : ''}删 PID`);
        if (alive) terminateChild(orphanEntry, '🧹 [孤儿清扫]');
      } else {
        log(`🧹 [孤儿清扫] ${name}: PID 文件进程已死(pid=${pid}) → 删残留标记`);
      }
      try { fs.unlinkSync(path.join(INBOX, f)); } catch (e) {}
      cleaned++;
    } catch (e) { log(`⚠️ [孤儿清扫] ${f} 异常: ${e.message}`); }
  }
  if (cleaned) log(`🧹 [孤儿清扫] 共清理 ${cleaned} 个残留 PID 文件`);
  return cleaned;
}

/* RPC 孤儿进程清扫（2026-08-11 load-quota-fix）：
 * 覆盖 sweepOrphans 扫不到的游离 pi RPC 子进程。
 * 背景：pi RPC 子进程是 cmd.exe 的孙进程（cmd → pi.cmd → node），inbox/*.PID 记录的是 cmd 的 pid，
 *   sweepOrphans 按 PID 文件只能清 cmd 层的残留；孙级 node --mode rpc 进程若不随任务收尾会永久游离（实测 35 个）。
 * 方法：枚举全进程，筛出命令行含 '--mode rpc' 的 node 进程，沿父链上溯看是否挂到某个 active 任务子进程；
 *   不在任何 active 任务进程树内 → 游离 → taskkill /t /f 强杀整棵树。
 * 安全护栏：挂在 active 任务进程树下（对照 active-tasks）→ 绝不动（不误杀活任务）。
 * 仅 Windows 有效（pi RPC 本机跑）；非 Windows 跳过。幂等。仅主管家执行。
 * @returns {number} 清理的游离 RPC 进程数 */
function sweepRpcOrphans() {
  if (process.platform !== 'win32') return 0;
  const { execFileSync } = require('child_process');
  let procs = [];
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
    const arr = JSON.parse(out);
    procs = (Array.isArray(arr) ? arr : [arr]).map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId, cmd: p.CommandLine || '' }));
  } catch (e) { log(`⚠️ [RPC孤儿清扫] 进程枚举失败: ${e.message}`); return 0; }
  if (!procs.length) return 0;
  const parent = new Map(procs.map(p => [p.pid, p.ppid]));
  // live roots = 活跃任务子进程 pid（其整棵进程树是合法任务进程）
  const liveRoots = new Set();
  for (const [, e] of active.entries()) if (e.child && e.child.pid) liveRoots.add(e.child.pid);
  let cleaned = 0;
  for (const p of procs) {
    if (!/--mode\s+rpc/.test(p.cmd)) continue;   // 只扫 pi RPC 子进程
    // 沿父链上溯（最多 12 层），看是否挂到某个 active 任务子进程
    let cur = p.pid, depth = 0, rooted = false;
    while (cur && depth < 12) {
      if (liveRoots.has(cur)) { rooted = true; break; }
      const pp = parent.get(cur);
      if (pp == null || pp === cur) break;   // 无父或自环
      cur = pp; depth++;
    }
    if (rooted) continue;   // 属于活跃任务进程树 → 不动
    const sid = (p.cmd.match(/--session-id\s+"?([^\s"]+)/) || [, ''])[1];
    log(`🧹 [RPC孤儿清扫] 游离 pi RPC 进程 pid=${p.pid} (${sid || p.cmd.slice(0, 50)}) → taskkill /t /f`);
    try { execFileSync('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); cleaned++; } catch (e) {}
  }
  if (cleaned) log(`🧹 [RPC孤儿清扫] 共清理 ${cleaned} 个游离 RPC 进程`);
  return cleaned;
}

const recCount = name => (readJsonSafe(RECOVERY_COUNT) || {})[name] || 0;
const bumpRecCount = name => { const st = readJsonSafe(RECOVERY_COUNT) || {}; st[name] = (st[name] || 0) + 1; writeJsonSafe(RECOVERY_COUNT, st); return st[name]; };
/* 异常重跑标记辅助（2026-08-08 分级通知）：
 *  - 分身决策「重跑」时打标 markRecoveryRerun → 重跑完成时查 isRecoveryRerun 决定是否跳过用户通知
 *  - 重跑完成（成功或失败）后 clearRecoveryRerun 清理，恢复正常任务语义 */
const RECOVERY_FLAG = name => path.join(RECOVERY_FLAG_DIR, `${name}.flag`);
const isRecoveryRerun = name => { try { return fs.existsSync(RECOVERY_FLAG(name)); } catch (e) { return false; } };
const markRecoveryRerun = name => { try { ensure(RECOVERY_FLAG_DIR); fs.writeFileSync(RECOVERY_FLAG(name), new Date().toISOString(), 'utf8'); } catch (e) {} };
const clearRecoveryRerun = name => { try { fs.unlinkSync(RECOVERY_FLAG(name)); } catch (e) {} };
/* 分级通知配置（2026-08-08）：cluster-notify.json 的 notifyAnomalyAutoRecovered（默认 false）
 *  - false = 异常自动恢复成功（重跑完成）不打扰用户，只记 [自动恢复] 日志
 *  - true  = 即便自动恢复成功也通知用户（显式可配） */
const NOTIFY_CFG_FILE = path.join(ORG_ROOT, 'config', 'cluster-notify.json');
const notifyAnomalyAutoRecovered = () => {
  try {
    const c = JSON.parse(fs.readFileSync(NOTIFY_CFG_FILE, 'utf8'));
    return c.notifyAnomalyAutoRecovered !== undefined ? !!c.notifyAnomalyAutoRecovered : false;
  } catch (e) { return false; }
};
/** 睡前/关机模式是否开启（存在 sleep-mode.flag） */
const sleepModeOn = () => { try { return fs.existsSync(SLEEP_FLAG); } catch (e) { return false; } };
/* ── 睡前模式自动关机联动（2026-08-11） ──────────────────────────
 * sleep-mode.flag 存在时：主循环检测「任务队列清空 + 连续 idleMin 分钟无新活动」→ 触发
 * shutdown /s /t delay。防误关：flag 清除即取消；有新任务（active 非空）即取消/重置；
 * dryRun 时只打日志不真关机（验证安全）。
 * 配置 config/sleep-shutdown.json：{dryRun, idleMin, shutdownDelaySec}，改即生效；
 * 环境变量 SLEEP_SHUTDOWN_DRY_RUN=1 强制进入 dry-run（验证用）。 */
const sleepShutdownCfg = () => {
  const dflt = { dryRun: true, idleMin: 5, shutdownDelaySec: 60 };
  try { return Object.assign({}, dflt, readJsonSafe(SLEEP_SHUTDOWN_CFG) || {}); }
  catch (e) { return dflt; }
};
const lastTaskName = { value: null };   // 最近一次任务名（写关机快照用）
function writeShutdownNote(reason) {
  const cfg = sleepShutdownCfg();
  try {
    const txt = [
      '# LAST_SHUTDOWN_NOTE（睡前模式自动关机快照）',
      `时间: ${tsISO()}`,
      `触发: ${reason}`,
      `最后任务: ${lastTaskName.value || '无'}`,
      `关机: shutdown /s /t ${cfg.shutdownDelaySec}（${cfg.shutdownDelaySec} 秒后执行）`,
      ''
    ].join('\n');
    fs.writeFileSync(SLEEP_SHUTDOWN_NOTE, txt, 'utf8');
    log('[睡前模式] 已写关机快照 →', SLEEP_SHUTDOWN_NOTE);
  } catch (e) { log('[睡前模式] 写关机快照失败:', e.message); }
}
function runShutdown(delaySec) {
  const cfg = sleepShutdownCfg();
  const dry = process.env.SLEEP_SHUTDOWN_DRY_RUN === '1' || cfg.dryRun === true;
  if (dry) { log(`[睡前模式] [DRY-RUN] 将执行: shutdown /s /t ${delaySec}（验证模式，不真关机）`); return false; }
  try {
    require('child_process').execSync(`shutdown /s /t ${delaySec}`, { windowsHide: true });
    log(`[睡前模式] ✅ 已执行 shutdown /s /t ${delaySec}（${delaySec} 秒后关机）`);
    return true;
  } catch (e) { log('[睡前模式] 关机命令执行失败:', e.message); return false; }
}
const mtime   = p => { try { return fs.statSync(p).mtimeMs; } catch (e) { return 0; } };
const ensure  = d => fs.mkdirSync(d, { recursive: true });
const tsISO   = () => new Date().toISOString();

function log(...a) {
  const line = `[${new Date().toLocaleTimeString()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) {}
}

/* ── 单实例锁 ──────────────────────────────────────────── */
function acquireLock() {
  try {
    const existing = readIf(PID_FILE);
    if (existing) {
      const pid = parseInt(existing.trim(), 10);
      // 检查进程是否仍在运行
      try { process.kill(pid, 0); return false; } catch (e) { /* 进程已死，锁过期 */ }
    }
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
    return true;
  } catch (e) { return false; }
}

function releaseLock() {
  try { fs.unlinkSync(PID_FILE); } catch (e) {}
}

/* ── 任务解析 ──────────────────────────────────────────── */
/**
 * 解析任务文件，返回 { name, content, agentId, groupId, keywords }
 * 任务文件头部可声明 `agent: <id>` 或 `group: <id>`
 */
function parseTask(filePath) {
  const name = path.basename(filePath, '.md');
  const content = readIf(filePath) || '(空)';
  const lines = content.split('\n');
  let agentId = null, groupId = null;
  let provider = null, model = null, thinking = null;   // pi 模型显式覆盖（可选）
  let target = null, timeout = null;                    // 软超时（2026-08-11）：timeout 到期不杀，先询问/续期，见 lib/soft-timeout.js
  let space = null;                                     // CNB 空间：space: 1|2|3（默认 1）
  let type = null;                                      // 任务类型：meeting = 圆桌会议
  let loadSensitive = false;                            // CPU 负载门禁：load-sensitive: true → 高负载暂缓（2026-08-11）
  let side = "remote";                                    // 2026-08-12：默认 CNB（执行器已落地）——显式 local 才本机|auto（2026-08-11 并发路由）
  let priority = null;                                  // 优先级：priority: urgent → 紧急（不排队，优先补位）
  let related = null;                                   // 相关智能体（显式声明，逗号分隔；2026-08-12 agent-collab）
  let session = null;                                   // 会话策略：session: reuse|new|<id>（2026-08-12 会话复用）
  for (const line of lines.slice(0, 15)) {
    const m = line.match(/^agent\s*:\s*(\S+)/i);
    if (m) { agentId = m[1]; continue; }
    const g = line.match(/^group\s*:\s*(\S+)/i);
    if (g) { groupId = g[1]; continue; }
    const t = line.match(/^type\s*:\s*(\S+)/i);
    if (t) { type = t[1].toLowerCase(); continue; }
    const mp = line.match(/^provider\s*:\s*(\S+)/i);
    if (mp) { provider = mp[1]; continue; }
    const mm = line.match(/^model\s*:\s*(\S+)/i);
    if (mm) { model = mm[1]; continue; }
    const mt = line.match(/^thinking\s*:\s*(\S+)/i);
    if (mt) { thinking = mt[1]; continue; }
    const tt = line.match(/^target\s*:\s*(\S+)/i);
    if (tt) { target = tt[1]; continue; }
    const tm = line.match(/^timeout\s*:\s*(\d+)/i);
    if (tm) { timeout = parseInt(tm[1], 10); continue; }   // 软超时：到期投 checkpoint 询问，远端活跃则续期（不强杀）
    const st = line.match(/^space\s*:\s*(\d+)/i);
    if (st) { space = st[1]; continue; }
    const ls = line.match(/^load-sensitive\s*:\s*(true|1|yes)/i);
    if (ls) { loadSensitive = true; continue; }
    const sd = line.match(/^side\s*:\s*(\S+)/i);
    if (sd) { side = sd[1].toLowerCase(); continue; }
    const pr = line.match(/^priority\s*:\s*(\S+)/i);
    if (pr) { priority = pr[1].toLowerCase(); continue; }
    const rd = line.match(/^related\s*:\s*(.+)/i);
    if (rd) { related = rd[1].split(/[,，\s]+/).filter(Boolean); continue; }
    const ss = line.match(/^session\s*:\s*(\S+)/i);
    if (ss) { session = ss[1].toLowerCase(); continue; }
  }
  // 关键词：取内容前 500 字符，分词
  const keywords = content.slice(0, 500).toLowerCase().split(/[\s，。！？、,。\n]+/).filter(k => k.length > 1);
  return { name, content, filePath, agentId, groupId, keywords, provider, model, thinking, target, timeout, space, type, loadSensitive, side, priority, related, session };
}

/* ── 路由 ──────────────────────────────────────────────── */
/**
 * 决定任务应交给哪个智能体（或创建新智能体）
 * 优先级：task 文件 agent: 声明 > group: 声明找主智能体 > 关键词匹配组的主智能体 > coo 兜底
 */
/** 域路由（2026-08-10 分工铁律落地 + 2026-08-11 调度约束）：按任务关键词路由到正确业务域的智能体，
 *  纠正 night-worker 任务垄断；对"查服务器/节点状态/版本/日志/验证"类任务强制归 server-admin。
 *  单一来源在 lib/domain-route.js（含 server-admin 查询增强，防 cnb-node-test-resume-verify / hk-hub-e2e 类违反）。 */
const { routeDomain } = require('./lib/domain-route');
function domainPick(task) {
  return routeDomain(task);
}

/* 远程节点可用性检测（2026-08-11 并发路由）：CNB/HK 是否可达（复用 node-load SSH 探测 + 缓存） */
function nodeReachable(key) {
  try {
    const snap = nodeLoad.getNode(key);
    return !snap.unknown;   // unknown=true → 探测失败（不可达）
  } catch (e) { return false; }
}
// remote 侧降级链：CNB 优先 → HK → 本机兜底（2026-08-11 并发路由）
function pickRemoteFallback() {
  if (nodeReachable('cnb1')) return 'cnb';
  if (nodeReachable('hk')) return 'hk';
  return 'local';   // 都不可达 → 本机兜底（不丢任务）
}

function routeTask(task, spawnGroupId) {
  const data = registry.load();
  // 过滤：分身管家只处理自己组的任务
  if (spawnGroupId) {
    const grp = data.nodes[spawnGroupId];
    if (!grp) return grp ? grp.mainAgent : 'coo';
  }
  // 0. side 优先（2026-08-12 全服务器化）：side: remote → CNB（不管显式 agent——agent 身份在 CNB 侧）
  //    本机只留：显式 local / 本机必需（工程文件在本机的）
  if (task.side === 'remote') return 'cnb';
  // 0. 侧路由（target: hk→HK；cnb→CNB 开发节点；local→强制本机；auto/默认→按能力表判定）
  if (task.target === 'hk') return 'hk';
  if (task.target === 'cnb') return 'cnb';
  if (task.target !== 'local') {   // auto 或未指定
    // 未显式绑定 agent/group 时才自动判侧，避免覆盖显式指定（显式绑定=本机路由）
    if (!task.agentId && !task.groupId) {
      const side = pickSide(task);
      if (side === 'hk') return 'hk';
      if (side === 'cnb') return 'cnb';
      if (side === 'remote') return pickRemoteFallback();   // remote → CNB优先→HK→本机
    }
  }
  // 1. 显式 agent
  if (task.agentId && data.nodes[task.agentId]) return task.agentId;
  // 2. 显式 group → 取主智能体
  if (task.groupId && data.nodes[task.groupId]) {
    const grp = data.nodes[task.groupId];
    return grp.mainAgent || task.groupId;
  }
  // 2.5 域路由（2026-08-10 分工铁律）：未显式绑定 → 按关键词路由到正确业务域智能体
  const dAgent = domainPick(task);
  if (dAgent) return dAgent;
  // 3. 关键词匹配组 → 取组内合适智能体（2026-08-10 修复：不再返回组 ID 动态创建"组名智能体"）
  const matchedGroupId = registry.matchGroup(task.keywords);
  if (matchedGroupId) {
    const grp = data.nodes[matchedGroupId];
    if (grp.mainAgent) return grp.mainAgent;
    // 组无 mainAgent → 从组 children 里选第一个业务智能体（spawnType=pi 且非测试/系统执行器）
    const kids = (grp.children || []).map(cid => data.nodes[cid]).filter(n => n && n.type === 'agent');
    const biz = kids.find(n => (n.spawnType || 'claude') === 'pi' && !/sync-test|coo$/.test(n.id));
    if (biz) return biz.id;
    return matchedGroupId;
  }
  return 'coo'; // 兜底：交回管家自身（COO 处理）
}

/* ── 创建新智能体（如果不存在） ────────────────────────── */
function ensureAgent(agentId, parent) {
  const existing = registry.getNode(agentId);
  if (existing) return existing;
  // 动态创建（2026-08-05 重构：默认挂管家域 grp-coo 下）
  const agentDir = `agents/${agentId}`;
  const fullDir = path.join(ORG_ROOT, agentDir);
  ensure(path.join(fullDir, 'memory'));
  ensure(path.join(fullDir, 'tasks'));
  const identity = {
    id: agentId, label: agentId, role: 'worker', status: 'sleeping',
    onlinePolicy: 'lazy', parent: parent || 'grp-coo',
    createdAt: tsISO(), persona: `智能体 ${agentId}`, permissions: [], capabilities: []
  };
  fs.writeFileSync(path.join(fullDir, 'identity.json'), JSON.stringify(identity, null, 2), 'utf8');
  const node = {
    id: agentId, type: 'agent', label: agentId, role: 'worker', status: 'sleeping',
    onlinePolicy: 'lazy', parent: parent || 'grp-coo', agentDir, spawnType: 'claude', children: []
  };
  registry.setNode(agentId, node);
  registry.addChild(parent || 'grp-coo', agentId);
  log(`✨ 动态创建智能体: ${agentId}`);
  return node;
}

/* ── 派发（spawn 子智能体） ────────────────────────────── */
// active: Map<taskName, { child, agentId, startedAt, retries, doneMarker, logPath, interjectable }>
const active = new Map();

/* 共享表落盘：server.js 经 logs/active-tasks.json 查询运行中任务（含插嘴能力标记） */
function persistActive() {
  const table = {};
  for (const [name, e] of active.entries()) {
    table[name] = {
      agentId: e.agentId || null,
      pid: (e.child && e.child.pid) || null,
      startedAt: new Date(e.startedAt || Date.now()).toISOString(),
      interjectable: !!e.interjectable,
      channel: e.interjectable ? 'pi-rpc' : null
    };
  }
  try {
    fs.mkdirSync(LOGS, { recursive: true });
    fs.writeFileSync(ACTIVE_TABLE, JSON.stringify(table, null, 2), 'utf8');
  } catch (e) { /* 写失败不影响任务流程 */ }
}

/* ── HK 远程投递（target: hk） ───────────────────────────── */
// 本地任务经 scripts/hk-task.js 投到 HK inbox → HK butler 执行 → .DONE 拉回本地。
// 完成标记/日志/active 管理完全复用主 dispatch 的收尾逻辑（checkActive 无感知差异）。
function dispatchToHk(task) {
  const logPath  = path.join(LOGS, `${task.name}.hk.log`);
  const donePath = path.join(INBOX, `${task.name}.DONE`);
  const pidPath  = path.join(INBOX, `${task.name}.PID`);
  const script   = path.join(ORG_ROOT, 'scripts', 'hk-task.js');
  const timeoutSec = task.timeout || 7200;

  const child = spawn(process.execPath || 'node', [script, task.filePath, '--wait', '--timeout', String(timeoutSec)], {
    cwd: ORG_ROOT, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  // 流式日志（桥输出 → logs/<name>.hk.log）
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  const entry = { child, agentId: 'hk', startedAt: Date.now(), doneMarker: donePath, logPath, pidPath, logOffset: 0, interjectable: false };
  active.set(task.name, entry);
  persistActive();
  try { fs.writeFileSync(pidPath, String(child.pid || ''), 'utf8'); } catch (e) {}

  child.on('exit', code => {
    log(`HK 桥进程 [${task.name}] 退出 code=${code}`);
    try { fs.unlinkSync(pidPath); } catch (e) {}
    const doneTxt = readIf(donePath);
    if (!doneTxt) {
      fs.writeFileSync(donePath, `.FAILED: HK 桥进程退出 code=${code}`, 'utf8');
      // 统一失败恢复（2026-08-12 auto-rerun-strengthen）：HK 不可达→降级本机；业务失败→记录；异常→自动重跑
      recoverFromFailure(task.name, active.get(task.name), `HK 桥进程退出 code=${code}`, { agentId: 'hk', node: 'hk' });
    } else if (doneTxt.includes('.FAILED')) {
      // 远端拉回的业务失败 / 桥写失败标记 → 统一恢复入口判别（业务=记录，不可达=降级，异常=重跑）
      recoverFromFailure(task.name, active.get(task.name), doneTxt, { agentId: 'hk', node: 'hk' });
    }
    const nd = registry.getNode('server-admin');
    if (nd) { nd.status = 'sleeping'; nd.lastDoneAt = tsISO(); registry.setNode('server-admin', nd); }
  });

  log(`🚀 HK 投递 [${task.name}] → scripts/hk-task.js (PID=${child.pid || '?'})`);
}

/* ── CNB 开发节点 SSH 桥（分担本机构建负载，2026-08-09） ── */
function dispatchToCnb(task) {
  const logPath  = path.join(LOGS, `${task.name}.cnb.log`);
  const donePath = path.join(INBOX, `${task.name}.DONE`);
  const pidPath  = path.join(INBOX, `${task.name}.PID`);
  const script   = path.join(ORG_ROOT, 'scripts', 'cnb-task.js');
  const timeoutSec = task.timeout || 7200;
  const space    = task.space || '1';

  const child = spawn(process.execPath || 'node', [script, task.filePath, '--wait', '--timeout', String(timeoutSec), '--space', String(space)], {
    cwd: ORG_ROOT, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  // 流式日志（桥输出 → logs/<name>.cnb.log）
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  const entry = { child, agentId: 'cnb-dev', startedAt: Date.now(), doneMarker: donePath, logPath, pidPath, logOffset: 0, interjectable: false };
  active.set(task.name, entry);
  persistActive();
  try { fs.writeFileSync(pidPath, String(child.pid || ''), 'utf8'); } catch (e) {}

  child.on('exit', code => {
    log(`CNB 桥进程 [${task.name}] 退出 code=${code}`);
    try { fs.unlinkSync(pidPath); } catch (e) {}
    const doneTxt = readIf(donePath);
    if (!doneTxt) {
      fs.writeFileSync(donePath, `.FAILED: CNB 桥进程退出 code=${code}`, 'utf8');
      // 统一失败恢复（2026-08-12 auto-rerun-strengthen）：CNB 不可达→降级本机；业务失败→记录；异常→自动重跑
      recoverFromFailure(task.name, active.get(task.name), `CNB 桥进程退出 code=${code}`, { agentId: 'cnb-dev', node: 'cnb' });
    } else if (doneTxt.includes('.FAILED')) {
      // 远端拉回的业务失败 / 桥写失败标记 → 统一恢复入口判别（业务=记录，不可达=降级，异常=重跑）
      recoverFromFailure(task.name, active.get(task.name), doneTxt, { agentId: 'cnb-dev', node: 'cnb' });
    }
    const nd = registry.getNode('cnb-dev');
    if (nd) { nd.status = 'sleeping'; nd.lastDoneAt = tsISO(); registry.setNode('cnb-dev', nd); }
  });

  log(`🚀 CNB 投递 [${task.name}] → scripts/cnb-task.js (space=${space}, PID=${child.pid || '?'})`);
}

/* ── 圆桌会议（type: meeting） ──────────────────────────── */
// 任务头 `type: meeting` + `topic:`（议题）+ `participants: a, b`（参会智能体，别名 attendees:）
// → spawn lib/meeting.js 独立协调进程：并行派发言 → 收集 → 总结智能体汇总纪要
// → 纪要 knowledge/meetings/<议题slug>-<日期>.md，会议 .DONE 含纪要路径。
function dispatchMeeting(task) {
  const logPath  = path.join(LOGS, `${task.name}.meeting.log`);
  const donePath = path.join(INBOX, `${task.name}.DONE`);
  const pidPath  = path.join(INBOX, `${task.name}.PID`);
  const script   = path.join(ORG_ROOT, 'lib', 'meeting.js');

  const child = spawn(process.execPath || 'node', [script, task.filePath], {
    cwd: ORG_ROOT, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  // 流式日志（meeting.js 输出 → logs/<name>.meeting.log）
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  const entry = { child, agentId: 'coo', startedAt: Date.now(), doneMarker: donePath, logPath, pidPath, logOffset: 0, interjectable: false };
  active.set(task.name, entry);
  persistActive();
  try { fs.writeFileSync(pidPath, String(child.pid || ''), 'utf8'); } catch (e) {}

  child.on('exit', code => {
    log(`会议协调进程 [${task.name}] 退出 code=${code}`);
    try { fs.unlinkSync(pidPath); } catch (e) {}
    if (!readIf(donePath)) {
      fs.writeFileSync(donePath, `.FAILED: 会议协调进程退出 code=${code}`, 'utf8');
    }
    // 协调器失败（2026-08-12 auto-rerun-strengthen）：不自动重跑（防重复开会/重复收集发言），记录 + 升级用户
    if (readIf(donePath) && readIf(donePath).includes('.FAILED')) {
      recoverFromFailure(task.name, active.get(task.name), `会议协调进程退出 code=${code}`, { agentId: 'coo', coordinator: true });
    }
  });

  log(`🗣️ 会议启动 [${task.name}] → lib/meeting.js (PID=${child.pid || '?'})`);
}

function dispatchDailyMeeting(task) {
  const logPath  = path.join(LOGS, `${task.name}.daily-meeting.log`);
  const donePath = path.join(INBOX, `${task.name}.DONE`);
  const pidPath  = path.join(INBOX, `${task.name}.PID`);
  const script   = path.join(ORG_ROOT, 'lib', 'daily-meeting.js');

  const child = spawn(process.execPath || 'node', [script, task.filePath], {
    cwd: ORG_ROOT, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  const entry = { child, agentId: 'coo', startedAt: Date.now(), doneMarker: donePath, logPath, pidPath, logOffset: 0, interjectable: false };
  active.set(task.name, entry);
  persistActive();
  try { fs.writeFileSync(pidPath, String(child.pid || ''), 'utf8'); } catch (e) {}

  child.on('exit', code => {
    log(`每日例会协调进程 [${task.name}] 退出 code=${code}`);
    try { fs.unlinkSync(pidPath); } catch (e) {}
    if (!readIf(donePath)) {
      fs.writeFileSync(donePath, `.FAILED: 每日例会协调进程退出 code=${code}`, 'utf8');
    }
    // 协调器失败（2026-08-12 auto-rerun-strengthen）：不自动重跑（防重复协调），记录 + 升级用户
    if (readIf(donePath) && readIf(donePath).includes('.FAILED')) {
      recoverFromFailure(task.name, active.get(task.name), `每日例会协调进程退出 code=${code}`, { agentId: 'coo', coordinator: true });
    }
  });

  log(`🌙 每日例会启动 [${task.name}] → lib/daily-meeting.js (PID=${child.pid || '?'})`);
}

function dispatch(task, agentId) {
  // type: meeting → 圆桌会议（lib/meeting.js 独立协调）
  if (task.type === 'meeting') { dispatchMeeting(task); return; }
  // type: daily-meeting → 每日例会（lib/daily-meeting.js 独立协调：大会→小会→文档→派发）
  // 防递归误判（2026-08-09 修复）：例会子任务（发言/管理组）文件名形如 daily-meeting-<date>-<agent>，
  //   但头部若被污染含 type: daily-meeting 会被误判为主协调器 → 并发启动多个协调器写同一发言文件 → 污染卡死。
  //   真正的每日例会主任务名是 daily-meeting-<date>（无后缀），故只有无后缀名才允许进协调器。
  if (task.type === 'daily-meeting') {
    const isSubTask = /^daily-meeting-\d{4}-\d{2}-\d{2}-[^-]+/.test(task.name);
    if (isSubTask) {
      log(`⚠️ [${task.name}] 例会子任务被误判为 daily-meeting，按普通任务派发（防递归协调器）`);
    } else {
      dispatchDailyMeeting(task);
      return;
    }
  }
  // 解析为 hk（显式 target: hk，或 auto 判侧命中）→ 走 HK 远程执行桥（本机只跑轻量轮询）
  if (agentId === 'hk' || task.target === 'hk') { dispatchToHk(task); return; }
  // 解析为 cnb（显式 target: cnb，或 auto 判侧命中构建）→ 走 CNB SSH 桥（分担本机构建负载）
  if (agentId === 'cnb' || task.target === 'cnb') { dispatchToCnb(task); return; }
  const node = ensureAgent(agentId, null);
  const agentDir = path.join(ORG_ROOT, node.agentDir || `agents/${agentId}`);
  const logPath  = path.join(LOGS, `${task.name}.log`);
  const donePath = path.join(INBOX, `${task.name}.DONE`);
  const pidPath  = path.join(INBOX, `${task.name}.PID`);

  // 共享资源锁校验（warn-only，不硬阻塞）：解析任务 writes:/reads:，比对登记表 owner 与活跃写集
  try {
    const rchk = rl.preDispatch(task.name, task.content || '', agentId);
    if (rchk.issues.length) log(`🔒 [${task.name}] 资源锁 ${rchk.issues.join(' | ')}`);
  } catch (e) { log(`🔒 [${task.name}] 资源锁校验异常: ${e.message}`); }

  /* ── 智能体协作（2026-08-12 agent-collab）：相关智能体检索 + ask 待响应附加 ── */
  let collabBlock = '';
  try {
    const ra = require('./lib/related-agents');
    const related = task.related && task.related.length ? task.related : null;
    const parts = [];
    if (related) {
      parts.push(`【相关智能体（任务声明）】${related.join('、')} —— 需要时走 ask 通道交流协作；同文件/同域改动先与对方确认。`);
    } else {
      const res = ra.findRelated(task, agentId);
      const fmt = ra.formatRelated(agentId, res);
      if (fmt) parts.push(fmt);
    }
    // ask 待响应（inbox/ask-<agentId>.md 存在且无响应段落 → 附加到本次任务）
    const askPath = path.join(INBOX, `ask-${agentId}.md`);
    if (fs.existsSync(askPath)) {
      const askContent = readIf(askPath) || '';
      if (askContent && !/^##\s*响应\s*\(by\s+\S+\)/m.test(askContent)) {
        parts.push([
          `【待响应问询（ask）】${askPath} 有未响应问询，请在任务中抽空响应：`,
          '```',
          askContent.slice(0, 1500),
          '```',
          `响应方式：在 ${askPath} 末尾追加 "## 响应 (by ${agentId} @时间)" 段落，并写入你的任务 DONE 摘要。`,
        ].join('\n'));
      }
    }
    // 交流通道说明（每次任务附上，鼓励不闷头干）
    parts.push([
      '【智能体交流通道】',
      `- 需要与别的智能体交流：写 inbox/ask-<对方id>.md（# 问询 → <对方id>；- 来自: ${agentId}；- 问题: ...）。对方下次任务执行时会收到并响应写回。`,
      '- 你自己被 ask（inbox/ask-<你的id>.md 存在）→ 在本任务中抽空响应写回。',
      '- 执行中发现属于别的智能体的活/信息 → 主动投递共享或 ask，不闷头干。',
    ].join('\n'));
    if (parts.length) collabBlock = '\n' + parts.join('\n\n');
  } catch (e) { log(`⚠️ [${task.name}] 协作检索异常（跳过）: ${e.message}`); }

  /* ── 知识注入（2026-08-12 乱码根治：执行智能体自动获得最新规范，实时读 task-inject.md）── */
  let knowledgeBlock = '';
  try {
    const ki = require('./lib/knowledge-inject');
    knowledgeBlock = ki.buildKnowledgeBlock(agentId);
  } catch (e) { log(`⚠️ [${task.name}] 知识注入异常（跳过）: ${e.message}`); }

  const prompt = [
    `你是智能体 ${agentId}，负责执行下方任务。`,
    `任务名: ${task.name}`,
    `工作目录: ${agentDir}`,
    `---`,
    task.content,
    (collabBlock ? collabBlock : ''),
    (knowledgeBlock ? knowledgeBlock : ''),
    `---`,
    `执行要求：`,
    `1. 独立完成，不等待外部指令`,
    `2. 完成后创建标记文件（一行摘要）：${donePath}`,
    `3. 若无法完成，写 ${donePath} 内容为 .FAILED: <原因>`,
    ``,
    `【交付前自查（2026-08-12 强制执行，通过后才写 DONE）】`,
    `- 自查四项：① 编码——产物文本文件 UTF-8 无乱码（无 U+FFFD 替换符/问号块），DONE 摘要可读；`,
    `  ② UI/布局（凡涉及前端/面板/按钮/文本展示）——文本是否放得下、不溢出不截断、不同尺寸窗口不挤爆，`,
    `  ③ 内容完整性——需求逐条对照覆盖，产物文件存在且非空，关键数据齐全；`,
    `  ④ 需求覆盖——任务目标逐条打勾，未覆盖项必须说明理由`,
    `- 自查不通过 → 自己修 → 再自查，全过才写 DONE；不要交付后等用户来挑`,
    ``,
    `【上下文管理铁律（2026-08-10 强制执行）】`,
    `- 禁止全量 cat/读取大文件（如 *.jsonl / history.jsonl / 日志 / 数据库导出）——会撑爆上下文导致被杀。`,
    `- 需要了解大文件内容时：用 grep/head -20/tail -50/wc -l 精准取片段；按需分页读取（每次最多几十行）。`,
    `- 读大文件前先 wc -l 看行数，>500 行必须限量读取，绝不一次读入全文件。`,
    `- 先判断文件大小/行数再决定读法；宁可多查几次小片段，也不全文灌入。`,
  ].join('\n');

  const isPi = (node.spawnType || 'claude') === 'pi';

  // 非 pi 类型（claude/hermes/node 分身）无渠道切换概念：单次 spawn，尊重显式渠道，无 fallback
  if (!isPi) {
    const child = spawnAgent({
      type: node.spawnType || 'claude',
      prompt, cwd: agentDir, name: agentId, log: logPath, donePath,
      provider: task.provider, model: task.model, thinking: task.thinking
    });
    const interjectable = false;
    const entry = { child, agentId, startedAt: Date.now(), doneMarker: donePath, logPath, pidPath, logOffset: 0, interjectable };
    active.set(task.name, entry);
    // 任务结束时释放其声明的资源写集（子进程 close 回调里兜底）
    child.on('close', () => { try { rl.release(task.name); } catch (e) {} });
    persistActive();
    try { if (fs.existsSync(logPath)) entry.logOffset = fs.statSync(logPath).size; } catch (e) {}
    try { fs.writeFileSync(pidPath, String(child.pid || ''), 'utf8'); } catch (e) {}
    const nodeData = registry.getNode(agentId);
    if (nodeData) { nodeData.status = 'active'; nodeData.lastTaskAt = tsISO(); registry.setNode(agentId, nodeData); }
    child.on('exit', code => {
      log(`子智能体 [${agentId}] 任务 [${task.name}] 进程退出 code=${code}`);
      try { fs.unlinkSync(pidPath); } catch (e) {}
      if (!readIf(donePath)) {
        fs.writeFileSync(donePath, `.FAILED: 进程退出 code=${code}`, 'utf8');
        // 异常退出自动恢复（2026-08-12 auto-rerun-strengthen）：进程异常退出 → 自动重跑，不等用户追查
        recoverFromFailure(task.name, active.get(task.name), `进程退出 code=${code}`, { agentId });
      } else if (readIf(donePath).includes('.FAILED')) {
        // agent 已写失败标记但未收尾 → 统一恢复入口判别（业务=记录，异常=自动重跑）
        recoverFromFailure(task.name, active.get(task.name), readIf(donePath), { agentId });
      }
      const nd = registry.getNode(agentId);
      if (nd) { nd.status = 'sleeping'; nd.lastDoneAt = tsISO(); registry.setNode(agentId, nd); }
    });
    log(`🚀 派发 [${task.name}] → ${agentId} (PID=${child.pid || '?'})`);
    return;
  }

  /* ── pi 任务：渠道自动 fallback 控制器（2026-08-08） ───── */
  // 链：默认任务用 FALLBACK_CHAIN（opencode-go→aliyun-0731→xxsx→deepseek官方）；
  //     显式 provider 任务尊重显式渠道（固定单元素链，失败按同一渠道重试 N 次后终止，不跨渠道）。
  const chain = task.provider
    ? [{ provider: task.provider, model: task.model || 'deepseek-v4-flash', thinking: task.thinking || 'off', label: task.provider }]
    : cf.FALLBACK_CHAIN.map(c => ({ ...c, thinking: task.thinking || c.thinking }));
  let attempt = 0;
  const maxAttempts = chain.length * cf.RETRY_THRESHOLD + 1;

  const setSleeping = () => {
    const nd = registry.getNode(agentId);
    if (nd) { nd.status = 'sleeping'; nd.lastDoneAt = tsISO(); registry.setNode(agentId, nd); }
  };
  const launchOne = (pick, label) => {
    const child = spawnAgent({
      type: 'pi', prompt, cwd: agentDir, name: agentId, log: logPath, donePath,
      provider: pick.provider, model: pick.model, thinking: pick.thinking,
      taskName: task.name, sessionPolicy: task.session || 'auto'   // 会话复用（2026-08-12）
    });
    const entry = { child, agentId, startedAt: Date.now(), doneMarker: donePath, logPath, pidPath,
      logOffset: 0, interjectable: true, channel: pick.provider };
    active.set(task.name, entry);
    persistActive();
    try { if (fs.existsSync(logPath)) entry.logOffset = fs.statSync(logPath).size; } catch (e) {}
    try { fs.writeFileSync(pidPath, String(child.pid || ''), 'utf8'); } catch (e) {}
    const nd = registry.getNode(agentId);
    if (nd) { nd.status = 'active'; nd.lastTaskAt = tsISO(); registry.setNode(agentId, nd); }
    log(`🚀 派发 [${task.name}] → ${agentId} 渠道=${pick.provider}/${pick.model} (PID=${child.pid || '?'})${label ? ' [' + label + ']' : ''}`);
    return child;
  };

  const tryNext = () => {
    if (attempt >= maxAttempts) {
      // 全部渠道多次重试仍失败（2026-08-11 不轻易判限额）：
      //   recordOutage 只对【已确认限额】渠道（quotaFails>=QUOTA_CONFIRM_THRESHOLD 连续 5 次）标记 needNotify
      //   → 通知用户（重置卡）；否则按不稳定处理（已自动重试多次），不打扰用户。
      const outage = cf.recordOutage(task, chain, attempt);
      const confirmed = outage && outage.quota && Array.isArray(outage.quota.confirmed) ? outage.quota.confirmed : [];
      if (!readIf(donePath)) {
        fs.writeFileSync(donePath, confirmed.length
          ? `.FAILED: 渠道疑似限额（${confirmed.join('、')}连续${cf.QUOTA_CONFIRM_THRESHOLD}次）已通知用户可重置`
          : `.FAILED: 渠道全部不稳定（重试 ${attempt} 次仍失败，未判定限额）`,
          'utf8');
      }
      setSleeping();
      // 统一收尾（2026-08-11 孤儿根治）：杀残留子进程 + 删 PID + 移出 active（失败路径也 finalize）
      const cur = active.get(task.name);
      if (cur) finalizeTask(task.name, cur, '全部渠道失败收尾');
      log(`🚨 [${task.name}] 全部渠道失败（${chain.map(c => c.provider).join(' → ')}）` +
        (confirmed.length ? `，疑似限额：${confirmed.join('、')}（已通知）` : '，按不稳定处理（未打扰）'));
      // 自动恢复（2026-08-12 auto-rerun-strengthen）：渠道类失败也自动重跑（限 MAX_RERUN 次），
      // 避免任务静默死亡等用户追查；重跑仍失败 → 升级用户带原因链（autoRerunTask 内部处理）
      recoverFromFailure(task.name, null, readIf(donePath) || `渠道全部失败（重试 ${attempt} 次）`, { agentId });
      return;
    }
    // 选渠道：显式任务固定该渠道；默认任务跳过冷却渠道（连续失败 N 次后自然切下一个）
    const picked = task.provider ? chain[0] : cf.pickProvider(chain);
    attempt++;
    const delay = attempt > 1 ? RETRY_DELAY_MS : 0;   // 重试间隔（首次立即，之后每次隔 3s 再重试）
    const launch = () => {
      const child = launchOne(picked, attempt > 1 ? `fallback#${attempt}` : null);
      child.on('exit', code => {
        const done = readIf(donePath);
        if (done) {
          if (done.includes('.FAILED')) {
            // 空回复失败标记（settled 但无产出、渠道空回）→ 属渠道问题：清标记 + markFailure + 走 fallback 切换
            if (done.includes('渠道空回复')) {
              try { fs.unlinkSync(donePath); } catch (e) {}
              cf.markFailure(picked.provider, cf.EMPTY_REPLY_REASON);
              const rec = cf.readHealth()[picked.provider] || { fails: 1 };
              log(`⚠️ [${task.name}] 渠道 ${picked.provider} 空回复失败，累计 ${rec.fails} 次` +
                  (cf.isCooling(rec) ? ' → 进入冷却，切换下一渠道' : ' → 重试本渠道'));
              tryNext();
              return;
            }
            // agent 明确业务失败（非渠道问题）→ 终止，不触发渠道切换
            log(`❌ [${task.name}] agent 业务失败（${done.trim().slice(0, 60)}），不触发渠道切换`);
            setSleeping();
            const bz = active.get(task.name);
            if (bz) finalizeTask(task.name, bz, '业务失败收尾');
            return;
          }
          cf.markSuccess(picked.provider);
          setSleeping();
          const ok = active.get(task.name);
          if (ok) finalizeTask(task.name, ok, '完成收尾');
          return;
        }
        // 无 DONE → 进程退出但未产出成果 → 检测渠道空回复（200 content 空/0 token，403/5xx/连接错同等处理）
        // 修复 2026-08-10：entry 从 active 表取（不依赖 launchOne 闭包变量——曾致 ReferenceError 崩溃）
        const en = active.get(task.name) || {};
        const empty = cf.detectEmptyReply(logPath, en.logOffset || 0);
        // 额度类错误识别（重置卡机制，2026-08-11）：非空回复时扫描日志里的 403/quota/insufficient → 写入健康表 lastError，
        //   供 recordOutage 识别「额度用尽」→ 通知用户可重置（区别于普通网络错误，不静默）。
        const quota = empty.empty ? { found: false } : cf.detectQuotaError(logPath, en.logOffset || 0);
        const reason = empty.empty ? cf.EMPTY_REPLY_REASON
          : (quota.found ? `渠道额度用尽（${quota.text}）` : `exit code=${code}`);
        cf.markFailure(picked.provider, reason);
        const rec = cf.readHealth()[picked.provider] || { fails: 1 };
        log(`⚠️ [${task.name}] 渠道 ${picked.provider} 失败（${reason}），累计 ${rec.fails} 次` +
            (cf.isCooling(rec) ? ' → 进入冷却，切换下一渠道' : ' → 重试本渠道') +
            (cf.isQuotaError(reason) ? `（额度类${rec.quotaFails || 1}/${cf.QUOTA_CONFIRM_THRESHOLD}次）` : ''));
        tryNext();
      });
    };
    if (delay) setTimeout(launch, delay); else launch();
  };
  tryNext();
}

/* ── 插嘴（控制台任务会话干预，2026-08-07） ────────────── */
/* server.js POST /api/task/<name>/interject → 写 inbox/interject/<name>.json
 * → butler 捡起 → sendRPC 送入 pi 子进程（复用 lib/spawn.js 的 RPC 协议）→ <name>.ack 回执 */
function handleInterjectFile(filePath) {
  const name = path.basename(filePath, '.json');
  const reply = payload => {
    try { fs.writeFileSync(filePath.replace(/\.json$/, '.ack'), JSON.stringify({ name, ts: tsISO(), ...payload }, null, 2), 'utf8'); } catch (e) {}
    try { fs.unlinkSync(filePath); } catch (e) {}   // 删请求防重复处理
  };
  let message = null;
  try { message = (JSON.parse(readIf(filePath) || '{}') || {}).message; } catch (e) {}
  if (!message || !String(message).trim()) return reply({ ok: false, error: '消息为空' });

  const entry = active.get(name);
  if (!entry) {
    const done = readIf(path.join(INBOX, name + '.DONE')) || readIf(path.join(INBOX, name + '.FAILED'));
    return reply({ ok: false, error: done ? '任务已结束' : '任务不在运行' });
  }
  if (!entry.interjectable || !entry.child || entry.child.killed || entry.child.stdin.destroyed) {
    return reply({ ok: false, error: '该任务进程不支持插嘴（仅 pi RPC 会话可插嘴）' });
  }
  const text = String(message).trim();
  const ok = sendRPC(entry.child, {
    type: 'prompt', message: text, id: 'interject-' + Date.now(), streamingBehavior: 'steer'
  });
  log(`💬 插嘴 [${name}] → ${entry.agentId} ${ok ? '已送入 agent 上下文' : '写入失败'}（${text.slice(0, 60)}）`);
  reply({ ok, delivered: ok, message: text.slice(0, 200) });
}

function watchInterject() {
  ensure(INTERJECT_DIR);
  try {
    fs.watch(INTERJECT_DIR, { persistent: true }, (_, fname) => {
      if (fname && fname.endsWith('.json')) setTimeout(() => handleInterjectFile(path.join(INTERJECT_DIR, fname)), 100);
    });
  } catch (e) { log('插嘴 watch 不可用:', e.message); }
  // 兜底轮询（Windows fs.watch 偶发丢事件）
  setInterval(() => {
    let f = null;
    try { f = fs.readdirSync(INTERJECT_DIR).find(n => n.endsWith('.json')); } catch (e) { return; }
    if (f) handleInterjectFile(path.join(INTERJECT_DIR, f));
  }, 2000);
}

/* ── 误杀残留标记自动归档（2026-08-09 misjudged-cleanup） ────── */
// 历史空转超时误杀产生的 .FAILED 标记（内容含误杀特征）已判定为误报
// （原版/improve 版实际已完成），自动归档：
//   .DONE → <name>.DONE.misjudged-<stamp>（保留证据，不参与统计）
//   同时归档对应 .md / .PID 到 inbox/archive，彻底移出失败/待处理统计。
// 幂等：只处理仍为 .DONE 命名且内容含误杀特征的标记；真失败（不含特征）不动。
const MISJUDGED_STAMP = '20260809';
const MISJUDGED_PATTERNS = [/agent_settled\s*后\s*进程未退出/, /空转超时，已强制结束/];
const isMisjudgedMarker = txt => !txt ? false : MISJUDGED_PATTERNS.some(re => re.test(txt));
/* 误杀归档白名单（2026-08-10 修复）：机制/自动派发类任务即使标记内容含误杀特征词也【不归档】，
 * 避免把正常机制文件（task-auto-recovery 等）误移入 archive 导致恢复链断。
 * 这些任务名是框架机制本身，其 .md 是恢复重跑的依据，绝不能移走。 */
const MISJUDGED_WHITELIST_PREFIXES = [
  'task-auto-recovery', 'task-watchdog', 'auto-schedule', 'daily-meeting', 'dual-sync',
  'cnb-ctl', 'checkpoint-', 'review-', 'intel-collect-', 'nextday-', 'interconnect',
  'disaster-recovery', 'butler-stability', 'cluster-twin-chat', 'windows-hide-fix',
  'agent-backlog', 'chatroom-topic-source', 'ask-app-nextstep', 'full-audit'
];
const isWhitelistedMechanism = name => MISJUDGED_WHITELIST_PREFIXES.some(p => name.startsWith(p));
/* 幂等游标（2026-08-10 优化）：记录已处理的 .DONE 文件名 → mtimeMs，只处理新增/变化的文件，
 * 避免每分钟重复扫描并对同一批白名单文件反复打「命中机制白名单」日志（刷屏）。
 * 文件 mtime 变化（内容被重写）才会重新处理，幂等安全。 */
const MISJUDGED_CURSOR = path.join(LOGS, 'misjudged-cursor.json');
const statOf = p => { try { return fs.statSync(p); } catch (e) { return null; } };
function cleanupMisjudged() {
  const ARCHIVE = path.join(INBOX, 'archive');
  const cursor = readJsonSafe(MISJUDGED_CURSOR) || {};
  let files = [];
  try { files = fs.readdirSync(INBOX); } catch (e) { return 0; }
  let moved = 0;
  let cursorDirty = false;
  const seen = new Set();
  for (const f of files) {
    if (!f.endsWith('.DONE')) continue;
    const name = f.slice(0, -'.DONE'.length);
    if (seen.has(name)) continue;
    seen.add(name);
    const donePath = path.join(INBOX, f);
    const sig = (statOf(donePath) || {}).mtimeMs || 0;
    // 幂等游标：该文件已处理且未变化 → 跳过，不打日志（消除白名单刷屏）
    if (cursor[f] === sig) continue;
    cursor[f] = sig;
    cursorDirty = true;
    const txt = readIf(donePath) || '';
    if (!isMisjudgedMarker(txt)) continue;          // 真失败不动
    if (isWhitelistedMechanism(name)) {             // 机制文件白名单（2026-08-10 防误伤）：保留原样，不动 .md
      log(`🛡️ [误杀归档] ${name} 命中机制白名单，跳过归档（保留恢复链依据）`);
      continue;
    }
    const archivedDone = path.join(INBOX, `${name}.DONE.misjudged-${MISJUDGED_STAMP}`);
    try {
      ensure(ARCHIVE);
      // 1) 失败标记留在 inbox 改名（证据 + 不参与统计）
      //    目标已存在（重复轮次）时追加内容后删除原文件，避免原 .DONE 残留导致每分钟重复命中
      if (!fs.existsSync(archivedDone)) {
        fs.renameSync(donePath, archivedDone);
      } else {
        try { fs.appendFileSync(archivedDone, '\n--- duplicate ---\n' + txt); } catch (e) {}
        fs.unlinkSync(donePath);
      }
      // 2) 任务文件与 PID 移入 archive，避免残留 pending/stale
      //    （2026-08-10：仅白名单外的普通任务才移 .md；机制/白名单任务已在上层 continue 跳过）
      for (const ext of ['.md', '.PID']) {
        const src = path.join(INBOX, name + ext);
        if (fs.existsSync(src)) {
          const dst = path.join(ARCHIVE, name + ext);
          if (!fs.existsSync(dst)) fs.renameSync(src, dst);
        }
      }
      moved++;
      log(`🧹 [误杀归档] ${name} → ${name}.DONE.misjudged-${MISJUDGED_STAMP}（${txt.trim().slice(0, 40)}）`);
      try {
        require('./lib/twin-log.js').logActivity(`[清理] 误杀标记归档 ${name}`,
          `内容特征: ${txt.trim().slice(0, 60)}`, '清理');
      } catch (e) {}
    } catch (e) {
      log(`🧹 [误杀归档] ${name} 归档失败: ${e.message}`);
    }
  }
  if (cursorDirty) writeJsonSafe(MISJUDGED_CURSOR, cursor);   // 幂等游标持久化
  return moved;
}

/* ── 分身↔管家讨论通道（2026-08-08 监督闭环） ─────────────── */
// 管家负责"接+执行"：读 inbox/discussion/*.md 议题 → 响应(同意/调整/驳回+理由)
// → 同意则自动派发完善任务 <task>-improve → 纪要归档 knowledge/meetings/<date>-<topic>.md
function scanDiscussion() {
  if (!fs.existsSync(DISC_DIR)) return;
  const topics = fs.readdirSync(DISC_DIR)
    .filter(f => f.endsWith('.md') && !f.endsWith('.reply.md'));
  for (const f of topics) {
    const topicPath = path.join(DISC_DIR, f);
    const base = f.replace(/\.md$/, '');
    const replyPath = path.join(DISC_DIR, base + '.reply.md');
    if (readIf(replyPath)) continue;                       // 已响应过
    const content = readIf(topicPath) || '';
    const srcTask  = (content.match(/- 源任务\s*:\s*(\S+)/) || [])[1] || base.replace(/^[\d-]+-/, '');
    const agent    = (content.match(/- 建议执行者\s*:\s*(\S+)/) || [])[1] || null;
    const judgment = (content.match(/- 分身判断\s*:\s*(.+)/) || [])[1] || '';
    const direction= (content.match(/- 建议方向\s*:\s*(.+)/) || [])[1] || '';
    const isFailure= /失败需重派/.test(content) || /\.FAILED/.test(content);
    const noAction = /无需行动|无需|驳回/.test(direction) && !isFailure;

    const decision = noAction ? '驳回' : (agent ? '同意' : '调整');
    const reason = noAction ? '建议方向为无需行动，不派发'
      : (agent ? `按分身建议，派发完善任务给 ${agent}` : '建议执行者未指定，交回管家路由');
    // 睡前/关机模式：派发转计划文档（讨论照常，但不 spawn）
    const sleepMode = sleepModeOn();
    const treat = sleepMode ? '已转计划文档，待启动派发' : (noAction ? '无需行动' : (decision === '同意' ? `已派发完善任务 ${srcTask}-improve` : '交回路由'));
    const reply = [
      `# 管家响应：${srcTask} 讨论议题`,
      `- 响应时间: ${new Date().toLocaleString()}`,
      `- 决策: ${decision}`,
      `- 理由: ${reason}`,
      `- 源任务: ${srcTask}`,
      `- 分身判断: ${judgment}`,
      `- 处理: ${treat}${sleepMode ? '（睡眠模式：讨论照常，派发转计划文档）' : ''}`,
    ].join('\n');
    fs.writeFileSync(replyPath, reply + '\n', 'utf8');
    log(`🗣️ 管家响应讨论 [${srcTask}]: ${decision}（${sleepMode ? '睡眠模式→写计划文档' : reason}）`);

    // 同意/调整 → 派发完善任务（下轮扫描由 scanInbox 捡起）
    // 睡眠模式下不派发，改写成计划文档 org/plans/next-boot/<ts>-<topic>.md（下次启动恢复派发）
    if (!noAction) {
      const improveName = `${srcTask}-improve`;
      const improveDone = path.join(INBOX, `${improveName}.DONE`);
      if (!readIf(improveDone)) {
        const improveTask = [
          `agent: ${agent || 'coo'}`,
          ``,
          `# 任务：完善 ${srcTask}（由分身-管家讨论派发）`,
          ``,
          `## 背景`,
          `源任务 ${srcTask} 验收发现完善空间，分身与管家讨论决定完善：`,
          `- 分身判断: ${judgment || '(无)'}`,
          `- 管家决策: ${decision}`,
          ``,
          `## 目标`,
          direction || `针对源任务 ${srcTask} 的验收完善点，补齐或补验。`,
          ``,
          `## 要求`,
          `1. 先查看源任务 ${srcTask} 的原始目标与当前完成标记，理解遗留点`,
          `2. 按上述目标完成完善/补验`,
          `3. 完成后创建标记文件（一行摘要）：${improveDone}`,
          `4. 无法完成则写 ${improveDone} 为 .FAILED: <原因>`,
        ].join('\n');
        if (sleepMode) {
          writePlanDoc(srcTask, improveName, { content, judgment, decision, direction, agent, reply });
        } else {
          fs.writeFileSync(path.join(INBOX, `${improveName}.md`), improveTask, 'utf8');
          log(`📨 已投递完善任务 ${improveName} → ${agent || 'coo'}（下轮扫描派发）`);
        }
      }
    }

    // 纪要归档（对齐 meeting-feature 格式）
    try {
      ensure(MEETINGS_DIR);
      const d = new Date();
      const dateStr = d.toISOString().slice(0, 10);
      const minutesFile = path.join(MEETINGS_DIR, `${dateStr}-${srcTask}.md`);
      const minutes = [
        `# 讨论纪要：${srcTask}`,
        ``,
        `- 会议 ID: ${base}`,
        `- 时间: ${dateStr} ${d.toTimeString().slice(0, 8)}`,
        `- 主持人: twin`,
        `- 参会: twin、butler`,
        `- 状态: 1 议题 · 管家已响应（${decision}）`,
        ``,
        `## 议题`,
        '```',
        content.trim(),
        '```',
        ``,
        `## 管家响应`,
        '```',
        reply.trim(),
        '```',
        ``,
      ].join('\n');
      fs.writeFileSync(minutesFile, minutes, 'utf8');
      log(`📄 讨论纪要已归档 → knowledge/meetings/${path.basename(minutesFile)}`);
    } catch (e) { log('归档讨论纪要失败:', e.message); }

    // 归档 topic（保留 reply 供分身读取闭环）
    try {
      ensure(path.join(DISC_DIR, 'archive'));
      fs.renameSync(topicPath, path.join(DISC_DIR, 'archive', f));
    } catch (e) { log('归档讨论议题失败:', e.message); }
  }
}

/* ── 睡眠模式：派发转计划文档 + 启动恢复派发（2026-08-08） ── */
// 睡前/关机模式下，分身巡查/验收/讨论照常，但管家不 spawn 新任务，
// 而是把讨论结论 + 建议任务文件（预写任务，含 agent/provider 头部）写成计划文档
// → 下次启动 butler 时扫描 org/plans/next-boot/*.md 自动转 inbox 派发。
function writePlanDoc(srcTask, improveName, info) {
  try {
    ensure(PLANS_NEXT);
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const topic = improveName || srcTask;
    const file = path.join(PLANS_NEXT, `${ts}-${topic}.md`);
    const taskFile = [
      `agent: ${info.agent || 'coo'}`,
      ``,
      `# 任务：完善 ${srcTask}（由分身-管家讨论派发，睡眠模式计划）`,
      ``,
      `## 背景`,
      `源任务 ${srcTask} 验收发现完善空间，分身与管家讨论决定完善：`,
      `- 分身判断: ${info.judgment || '(无)'}`,
      `- 管家决策: ${info.decision}`,
      ``,
      `## 目标`,
      info.direction || `针对源任务 ${srcTask} 的验收完善点，补齐或补验。`,
      ``,
      `## 要求`,
      `1. 先查看源任务 ${srcTask} 的原始目标与当前完成标记，理解遗留点`,
      `2. 按上述目标完成完善/补验`,
      `3. 完成后创建标记文件（一行摘要）：${path.join(INBOX, `${improveName}.DONE`)}`,
      `4. 无法完成则写 ${path.join(INBOX, `${improveName}.DONE`)} 为 .FAILED: <原因>`,
    ].join('\n');
    const plan = [
      `# 计划文档：${topic}`,
      `> 类型：睡前/关机模式派发转计划（讨论照常，待下次启动派发）`,
      `> 生成: ${new Date().toLocaleString()}`,
      ``,
      `## 议题（分身验收结论）`,
      '```',
      (info.content || '').trim(),
      '```',
      ``,
      `## 分身判断`,
      info.judgment || '(无)',
      ``,
      `## 管家响应`,
      '```',
      (info.reply || '').trim(),
      '```',
      ``,
      `## 建议任务文件全文（下次启动直接转 inbox 派发）`,
      '```',
      taskFile,
      '```',
      ``,
    ].join('\n');
    fs.writeFileSync(file, plan + '\n', 'utf8');
    log(`📄 睡眠模式：已写计划文档 ${path.basename(file)}（待启动恢复派发 ${topic}）`);
    return file;
  } catch (e) { log('写计划文档失败:', e.message); return null; }
}

// butler 启动（或首次巡查）时扫描 next-boot 计划 → 转 inbox 派发 → 归档 done
function restorePlans() {
  if (!fs.existsSync(PLANS_NEXT)) return;
  ensure(PLANS_DONE);
  const files = fs.readdirSync(PLANS_NEXT).filter(f => f.endsWith('.md'));
  let restored = 0;
  for (const f of files) {
    try {
      const src = path.join(PLANS_NEXT, f);
      const content = readIf(src) || '';
      // 提取建议任务文件全文（``` 代码块里的预写任务）
      const m = content.match(/## 建议任务文件全文（下次启动直接转 inbox 派发）\r?\n```\r?\n([\s\S]*?)\r?\n```/);
      const taskText = m ? m[1] : null;
      // 任务名：取计划文件名里的 <topic>（去掉时间戳前缀），即源任务名-improve（如 terraria-world2-seed-improve）
      const targetName = f.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-/, '');
      const targetMd = path.join(INBOX, `${targetName}.md`);
      if (!taskText || readIf(targetMd)) {  // 去重：已存在同 inbox 任务则跳过
        fs.renameSync(src, path.join(PLANS_DONE, f));
        log(`计划 ${f} 跳过恢复（${taskText ? '目标任务已存在' : '未提取到任务全文'}）→ 归档 done`);
        continue;
      }
      fs.writeFileSync(targetMd, taskText + '\n', 'utf8');
      fs.renameSync(src, path.join(PLANS_DONE, f));
      restored++;
      log(`🔄 恢复计划文档 → 转派发任务 ${targetName}.md（原计划 ${f} 已归档 done）`);
    } catch (e) { log('恢复计划失败 ' + f + ': ' + e.message); }
  }
  if (restored) log(`📨 启动恢复派发完成：${restored} 个计划文档转任务`);
}

/* ── 决策委托结果读取（2026-08-08 决策委托分身） ────────── */
// 分身已写 decisions/*.decision.md：管家读取 → 恢复任务执行。
//   - 决策点 → 若源任务仍在运行且可插嘴则直接 steer；否则重派 <src>-resume 任务（注入决策继续）
//   - 红线/超时 → 升级用户待确认，不自动恢复（等待用户）
function scanDecisionResults() {
  if (!fs.existsSync(DEC_DIR)) return;
  const files = fs.readdirSync(DEC_DIR)
    .filter(f => f.endsWith('.decision.md'));
  for (const f of files) {
    const decPath = path.join(DEC_DIR, f);
    const content = readIf(decPath) || '';
    const srcTask = (content.match(/- 源任务\s*:\s*(\S+)/) || [])[1] || '';
    const decision = (content.match(/- 决策\s*:\s*(.+)/) || [])[1] || '';
    const type = (content.match(/- 类型\s*:\s*(.+)/) || [])[1] || '决策点';
    const isEscalate = /红线|超时|升级用户|待用户/.test(type);
    // 恢复决策检测：源任务的失败标记含「进程异常中断/疑似卡死」= 异常恢复决策（2026-08-08）
    const srcFailed = readIf(path.join(INBOX, `${srcTask}.DONE`)) || readIf(path.join(INBOX, `${srcTask}.FAILED`)) || '';
    const isRecovery = /进程异常中断|疑似卡死/.test(srcFailed);

    if (isRecovery) {
      log(`🚨 恢复决策[${srcTask}] 分身已决策：${decision.trim().slice(0, 60)} — 按决策自动处理`);
      handleRecoveryDecision(srcTask, decision);
    } else if (isEscalate) {
      log(`🚨 决策[${srcTask}] ${type}：${decision.trim().slice(0, 60)} — 升级用户待确认，不自动恢复`);
    } else {
      log(`🧭 决策[${srcTask}] 分身已决策：${decision.trim().slice(0, 80)} — 恢复执行`);
      resumeTaskWithDecision(srcTask, decision, content);
    }
    // 归档决策文件（留 archive 供审计）
    try {
      ensure(path.join(DEC_DIR, 'archive'));
      fs.renameSync(decPath, path.join(DEC_DIR, 'archive', f));
    } catch (e) { log('归档决策结果失败:', e.message); }
  }
}

/** 异常恢复决策自动执行（2026-08-08）：分身决策「重跑」→ 重新派发；「归档」→ 保留失败标记不再重派。
 *  重跑防循环：同任务重跑超过 MAX_RERUN 次 → 强制归档 + 升级用户，不再自动重跑。 */
function handleRecoveryDecision(srcTask, decision) {
  const d = (decision || '').toLowerCase();
  const wantRerun  = /重跑|重新派发|重新执行|重试|选\s*a/.test(d);
  const wantArchive = /归档|不再重派|放弃|保留失败|选\s*b/.test(d);
  const donePath  = path.join(INBOX, `${srcTask}.DONE`);
  const failedPath = path.join(INBOX, `${srcTask}.FAILED`);
  const mdPath    = path.join(INBOX, `${srcTask}.md`);

  if (wantRerun && fs.existsSync(mdPath)) {
    const rerun = recCount(srcTask);
    if (rerun >= MAX_RERUN) {
      log(`🚫 [${srcTask}] 异常重跑次数已达上限 ${MAX_RERUN}，强制归档 + 升级用户，不再自动重跑`);
      try { ensure(path.join(INBOX, 'archive')); fs.renameSync(mdPath, path.join(INBOX, 'archive', `${srcTask}.md`)); } catch (e) {}
      fs.writeFileSync(donePath, `.FAILED: 异常重跑超过 ${MAX_RERUN} 次，强制归档，需人工介入`, 'utf8');
      // 分级通知（2026-08-08）：自动恢复失败（重跑超限）→ 升级用户带说明
      notifyTaskEvent(srcTask, false, `已尝试自动恢复 ${MAX_RERUN} 次仍失败（进程异常/疑似卡死），已强制归档，需人工处理`);
      return;
    }
    bumpRecCount(srcTask);
    // 打异常重跑标记：重跑完成时据此跳过用户通知（仅记 [自动恢复] 日志）
    markRecoveryRerun(srcTask);
    // 清除失败标记，让任务文件重新进入派发队列
    try { fs.unlinkSync(donePath); } catch (e) {}
    try { fs.unlinkSync(failedPath); } catch (e) {}
    try { fs.unlinkSync(path.join(INBOX, `${srcTask}.PID`)); } catch (e) {}
    try {
      const task = parseTask(mdPath);
      const agentId = detectSourceAgent(srcTask) || routeTask(task, null) || 'coo';
      dispatch(task, agentId);
      log(`♻️ 恢复决策「重跑」→ 已重新派发 ${srcTask}（第 ${rerun + 1}/${MAX_RERUN} 次）→ ${agentId}`);
    } catch (e) { log('重跑派发失败:', e.message); }
  } else if (wantArchive || !wantRerun) {
    log(`🗄 恢复决策「归档」→ 保留 ${srcTask} 失败标记，不再重派`);
    try { if (fs.existsSync(mdPath)) { ensure(path.join(INBOX, 'archive')); fs.renameSync(mdPath, path.join(INBOX, 'archive', `${srcTask}.md`)); } } catch (e) {}
    fs.writeFileSync(donePath, `.FAILED: 分身决策归档，不再重派`, 'utf8');
    // 分级通知（2026-08-08）：分身决策=归档/放弃 = 自动恢复失败 → 升级用户带说明
    notifyTaskEvent(srcTask, false, `自动恢复失败：分身决策归档不再自动重派，需人工处理`);
  }
}

/* ── 失败自动重跑强化（2026-08-12 auto-rerun-strengthen）──
 * 用户批评（2026-08-12 20:1x）："没修就修啊……那全死完了咋办，又要等到我追查任务进度再修？"
 * 背景：清理脚本误杀 3 个活任务（写 .FAILED: 孤儿残留（并发名额释放））→ exit handler 当业务失败
 *       处理 → 不重跑、任务静默死亡 → 用户追查才发现。
 * 教训：任何任务失败（非明确业务失败）→ 自动重跑（限 MAX_RERUN 次）→ 不等用户追查。
 * 判别：
 *   - 明确业务失败（agent 自主放弃，如"任务文件未包含代码块"）→ 不盲目重跑：记录 + 通知用户
 *   - 异常失败（进程退出/卡死/渠道/不可达/误杀标记/超时等）→ 自动重跑 → 仍失败升级用户（带原因链）
 * 节点降级：HK/CNB 不可达 → 任务自动转本机执行（记录降级原因，不静默） */
const FAIL_TEXT_ANOMALY_RE = [
  /进程异常中断/, /疑似卡死/, /渠道/, /空回复/, /不可达/, /桥进程退出/, /exit code/,
  /进程退出/, /孤儿残留/, /并发名额/, /超时/, /scp 投递失败/, /执行器拉起失败/, /拉回.*失败/,
  /连接失败/, /ssh fail/, /卡死/, /网络错误/, /中断/, /被杀/, /限额/
];
const SILENT_FAIL_MAX_AGE_MS = 24 * 60 * 60 * 1000;   // 静默失败兑底只处理近 24h 标记（防历史失败洪峰重跑）
function isAnomalyFailure(text) {
  if (!text) return true;   // 无内容标记 → 按异常处理（自动重跑兜底，不静默）
  return FAIL_TEXT_ANOMALY_RE.some(re => re.test(text));
}
// 失败标记判别（2026-08-12 收紧 v2）：成功任务的 DONE 是文章/摘要（可能提到 .FAILED/卡死/失败等词），
// 绝不能当失败重跑。只认三类：① .FAILED 前缀（agent/系统权威标记）② butler 内部固定失败前缀
// ③ ≤80 字短文本且以明确失败声明开头（防成功摘要含“失败”词误判）。
const isFailMarker = content => {
  const c = String(content || '').trim();
  if (!c) return false;
  if (/^\.FAILED/.test(c)) return true;              // ① agent/系统写 .FAILED: <原因>
  if (/^(进程异常中断|疑似卡死|渠道空回复|渠道全部失败|渠道疑似限额)/.test(c)) return true;   // ② 系统级失败前缀
  if (c.length <= 80 && /^(失败|无法完成|任务失败)/.test(c)) return true;   // ③ 短文本明确失败声明
  return false;
};
// 失败原因链：logs/failure-chain/<name>.jsonl 每次失败追加；升级用户时带全链（不静默）
const FAILURE_CHAIN_DIR = path.join(LOGS, 'failure-chain');function appendFailureChain(name, reason) {
  try {
    ensure(FAILURE_CHAIN_DIR);
    const rec = { ts: tsISO(), reason: String(reason || '').trim().slice(0, 300) };
    fs.appendFileSync(path.join(FAILURE_CHAIN_DIR, `${name}.jsonl`), JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {}
}
function failureChainText(name) {
  try {
    const lines = (readIf(path.join(FAILURE_CHAIN_DIR, `${name}.jsonl`)) || '').trim().split('\n').filter(Boolean);
    if (!lines.length) return '';
    return lines.map((l, i) => { try { return `#${i + 1}:${JSON.parse(l).reason}`; } catch (e) { return ''; } }).filter(Boolean).join(' → ');
  } catch (e) { return ''; }
}
// 业务失败记录（logs/business-failures.jsonl）：明确业务失败不盲跑，留痕供复盘/人工排查
const BIZ_FAILURES_LOG = path.join(LOGS, 'business-failures.jsonl');
function logBusinessFailure(name, text, agentId) {
  try {
    const rec = { ts: tsISO(), task: name, agentId: agentId || null, failText: String(text || '').trim().slice(0, 300) };
    fs.appendFileSync(BIZ_FAILURES_LOG, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {}
}

/** 节点不可达降级（2026-08-12 目标3）：HK/CNB 桥失败且原因含「不可达」→ 任务文件 target 改 local
 *  转本机执行（记录降级原因，不静默）。已降级过（文件含降级标记）→ 不再降级，走 autoRerunTask。 */
function degradeNodeTask(task, fromNode, reason) {
  const mdPath = task.filePath;
  let content = readIf(mdPath) || '';
  if (content.includes('## 降级记录')) {
    log(`⏭️ [${task.name}] 已降级过一次（${fromNode} 仍不可达）→ 改走自动重跑（限 ${MAX_RERUN} 次）`);
    return autoRerunTask(task.name, reason);
  }
  const bumped = bumpRecCount(task.name);       // 降级也算一次恢复尝试（防无限降级）
  markRecoveryRerun(task.name);
  // 改写任务文件：target/side 强制 local（不再路由远端）
  content = content.replace(/^target\s*:\s*\S+/m, 'target: local')
                   .replace(/^side\s*:\s*\S+/m, 'side: local');
  content += `\n## 降级记录\n- 节点 ${fromNode} 不可达（${reason}）→ 自动转本机执行\n- 时间: ${tsISO()}\n`;
  fs.writeFileSync(mdPath, content, 'utf8');
  try { fs.unlinkSync(path.join(INBOX, `${task.name}.DONE`)); } catch (e) {}
  try { fs.unlinkSync(path.join(INBOX, `${task.name}.FAILED`)); } catch (e) {}
  try { fs.unlinkSync(path.join(INBOX, `${task.name}.PID`)); } catch (e) {}
  const task2 = parseTask(mdPath);
  const agentId = detectSourceAgent(task.name) || routeTask(task2, null) || 'coo';
  try {
    dispatch(task2, agentId);
    log(`🌐 [${task.name}] 节点 ${fromNode} 不可达 → 已降级转本机执行（${agentId}，第 ${bumped}/${MAX_RERUN} 次恢复）`);
    return true;
  } catch (e) {
    log(`🌐 [${task.name}] 降级转本机派发失败: ${e.message}`);
    requestRecoveryDecision(task.name, reason + '（降级派发异常）');
    notifyTaskEvent(task.name, false, `自动恢复失败（降级派发异常）：${reason}`);
    return false;
  }
}

/** 统一失败恢复入口（2026-08-12 auto-rerun-strengthen）：
 * 所有失败路径（exit handler / checkActive 检测 / 兜底巡检）统一走这里：
 *   1. 明确业务失败 → 记录（business-failures.jsonl）+ 正常通知，不盲目重跑
 *   2. 协调器类（meeting/daily-meeting）→ 记录 + 升级用户（重开会风险，不自动重跑）
 *   3. 节点不可达（HK/CNB）→ 降级转本机（限 1 次，之后 autoRerunTask）
 *   4. 其余异常失败 → autoRerunTask（限 MAX_RERUN 次）→ 仍失败升级用户（带原因链）
 * @returns {boolean} 是否已接管（重跑/降级） */
function recoverFromFailure(name, entry, failText, opts) {
  opts = opts || {};
  const text = String(failText || '').replace(/^\.FAILED:\s*/, '');
  appendFailureChain(name, text);
  const mdPath = path.join(INBOX, `${name}.md`);
  // 0) 源任务文件缺失（无法重派）→ 记录 + 升级
  if (!fs.existsSync(mdPath)) {
    log(`🚨 [${name}] 失败但源任务文件缺失（无法自动重跑）→ 升级用户`);
    notifyTaskEvent(name, false, `自动恢复失败（源任务文件缺失）：${text.slice(0, 120)}`);
    return false;
  }
  // 1) 协调器类：不自动重跑（重复开会/发言收集风险），记录 + 升级用户
  if (opts.coordinator) {
    log(`🗂 [${name}] 协调器进程异常退出（${text.slice(0, 60)}）→ 不自动重跑（防重复协调），记录 + 升级用户`);
    logBusinessFailure(name, `协调器异常退出: ${text}`, opts.agentId);
    notifyTaskEvent(name, false, `协调器进程异常退出（${text.slice(0, 100)}），需人工检查会议完整性`);
    return false;
  }
  // 2) 明确业务失败（agent 自主放弃）→ 不盲跑：记录（通知由 checkActive 正常路径发）
  if (!isAnomalyFailure(text)) {
    log(`📝 [${name}] 业务失败（${text.slice(0, 60)}）→ 不盲目重跑，记录 + 正常通知`);
    logBusinessFailure(name, text, opts.agentId);
    return false;
  }
  // 3) 节点不可达 → 降级转本机
  if (opts.node && /不可达|ssh fail|连接失败/.test(text)) {
    log(`🌐 [${name}] ${opts.node} 不可达（${text.slice(0, 60)}）→ 尝试降级转本机执行`);
    try {
      const task = parseTask(mdPath);
      return degradeNodeTask(task, opts.node, text);
    } catch (e) { log(`🌐 [${name}] 降级准备失败: ${e.message}`); }
  }
  // 4) 其余异常失败 → 自动重跑（autoRerunTask 内部限 MAX_RERUN + 超限升级带原因链）
  //    若 entry 还在 active（未 finalize）→ 先收尾移出，避免与重跑新 entry 冲突
  if (entry && active.has(name)) {
    try { terminateChild(entry, '🧹 [异常失败重跑收尾]'); } catch (e) {}
    active.delete(name);
    persistActive();
  }
  return autoRerunTask(name, text);
}

/** 静默失败兜底巡检（2026-08-12 auto-rerun-strengthen）：扫描 inbox/*.DONE 中内容含 .FAILED 的任务
 *  — 未重跑过（recCount==0）且异常失败 → 自动重跑（防外部脚本误杀/管家重启丢 active/任何漏网路径）
 *  — 业务失败 → 记录（不重跑）；已重跑过 → 跳过（重跑中或已升级）
 * 仅主管家；与 sweepOrphans 同频（10min）。幂等。
 * @returns {number} 本轮自动恢复数 */
function sweepSilentFailures() {
  if (!fs.existsSync(INBOX)) return 0;
  let reran = 0;
  const files = fs.readdirSync(INBOX).filter(f => f.endsWith('.DONE'));
  for (const f of files) {
    try {
      const name = f.slice(0, -'.DONE'.length);
      const content = readIf(path.join(INBOX, f)) || '';
      if (!isFailMarker(content)) continue;            // 非失败标记（成功文章/摘要）不碰
      // 时间窗口（2026-08-12 防洪峰）：只处理近 24h 写入的失败标记——历史老失败
      // 已由 -improve/人工处置过，一次性全量重跑会与真实任务抢并发/渠道额度。
      const st = fs.statSync(path.join(INBOX, f));
      if (Date.now() - st.mtimeMs > SILENT_FAIL_MAX_AGE_MS) continue;
      if (isProgressSnapshotTask(name)) continue;              // checkpoint 进度快照不重跑
      if (recCount(name) > 0) continue;                        // 已重跑过/已升级（不再碰）
      if (active.has(name)) continue;                          // 还在跑 → 由 checkActive 处理
      if (!fs.existsSync(path.join(INBOX, `${name}.md`))) continue;  // 源文件缺失无法重派
      if (!isAnomalyFailure(content)) { logBusinessFailure(name, content); continue; }
      log(`🧹 [静默失败兜底] ${name}: 发现未恢复的异常失败标记（${content.trim().slice(0, 60)}）→ 自动重跑`);
      if (autoRerunTask(name, content.trim().slice(0, 150))) reran++;
    } catch (e) { log(`⚠️ [静默失败兜底] ${f} 异常: ${e.message}`); }
  }
  if (reran) log(`🧹 [静默失败兜底] 本轮自动恢复 ${reran} 个任务`);
  return reran;
}

/** 自动重跑（2026-08-10 并入主循环）：卡死/PID死检测直接触发，不依赖独立 decisions 文件。
 *  PID 死 + 无 DONE → 自动重跑（限 MAX_RERUN 次）→ 仍失败才升级用户/请求分身决策。
 *  复用 handleRecoveryDecision 的重跑分支逻辑，但调用时机由 checkActive/failTaskAnomaly 主动驱动。
 *  @returns {boolean} 是否已触发重跑 */
function autoRerunTask(srcTask, reason) {
  const mdPath = path.join(INBOX, `${srcTask}.md`);
  if (!fs.existsSync(mdPath)) {
    log(`🚨 [${srcTask}] 自动重跑跳过：源任务文件 ${srcTask}.md 不存在（无法重跑）`);
    requestRecoveryDecision(srcTask, reason + '（源任务文件缺失，无法自动重跑）');
    notifyTaskEvent(srcTask, false, `自动恢复失败（源任务文件缺失）：${reason}`);
    return false;
  }
  // 已闭环跳过（2026-08-12 anomaly-fallback 失败判定体系化加固）：源任务已由 -improve
  // 覆盖/源已 .DONE → 不再重复自动重跑（避免重复补验同一次已定结果的验证）
  if (anomaly.isClosed(srcTask, INBOX)) {
    log(`⏭️ [${srcTask}] 源任务已由 -improve 闭环 → 跳过自动重跑（重复补验已停）`);
    return false;
  }
  const rerun = recCount(srcTask);
  if (rerun >= MAX_RERUN) {
    // 互救机制（2026-08-12 agent-rescue-core）：重跑达上限 → 先派救援者（同域/管理组）诊断+修复+接管，
    // 不再直接升级用户——救援链耗尽才升级。与 requestRecoveryDecision（分身决策通道）并行：
    // 救援任务是主动互救，decisions 文件是分身决策兜底，两者幂等不冲突。
    log(`🚫 [${srcTask}] 自动重跑次数已达上限 ${MAX_RERUN}，转入互救链（不再直接升级用户）`);
    try {
      const rescue = require('./lib/agent-rescue');
      const launched = rescue.launchRescue(srcTask, reason, detectSourceAgent(srcTask) || undefined);
      if (launched) {
        log(`🚑 [${srcTask}] 互救链已启动 → 救援者 ${launched.rescuer}（${launched.taskFile}）`);
        return true;
      }
    } catch (e) { log('互救链启动异常: ' + e.message); }
    // 救援未启动（无救援者/被禁用）→ 退回原升级路径
    requestRecoveryDecision(srcTask, reason);
    // 升级通知带失败原因链（2026-08-12 auto-rerun-strengthen）：重跑仍失败 → 通知用户带完整失败链，不静默
    const chain = failureChainText(srcTask);
    notifyTaskEvent(srcTask, false, `已尝试自动恢复 ${MAX_RERUN} 次仍失败。失败原因链：${chain || reason}`);
    return false;
  }
  bumpRecCount(srcTask);
  markRecoveryRerun(srcTask);
  // 清除失败/完成/PID 标记，让任务文件重新进入派发队列
  try { fs.unlinkSync(path.join(INBOX, `${srcTask}.DONE`)); } catch (e) {}
  try { fs.unlinkSync(path.join(INBOX, `${srcTask}.FAILED`)); } catch (e) {}
  try { fs.unlinkSync(path.join(INBOX, `${srcTask}.PID`)); } catch (e) {}
  try {
    const task = parseTask(mdPath);
    let agentId = detectSourceAgent(srcTask) || routeTask(task, null) || 'coo';
    // 自动优化闭环（2026-08-10 auto-optimize）：连续失败≥阈值 → 换执行者/拆步/环境自查
    try {
      const ao = require('./lib/auto-optimize');
      const opt = ao.prepareRerun(srcTask, reason, agentId);
      if (opt.changed && opt.agent && opt.agent !== agentId) {
        log(`🔧 [${srcTask}] auto-optimize 换执行者 ${agentId} → ${opt.agent}（失败 ${opt.failCount || '?'} 次）`);
        agentId = opt.agent;
        task.agentId = opt.agent;   // 同步到 task，确保 dispatch 走新执行者
      }
      if (opt.notes && opt.notes.length) log(`🔧 [${srcTask}] auto-optimize: ${opt.notes.join(' | ')}`);
    } catch (e) { log('auto-optimize 集成异常: ' + e.message); }
    dispatch(task, agentId);
    log(`♻️ 自动重跑已触发 [${srcTask}]（第 ${rerun + 1}/${MAX_RERUN} 次）→ ${agentId}，原因: ${reason}`);
    return true;
  } catch (e) {
    log('自动重跑派发失败: ' + e.message);
    requestRecoveryDecision(srcTask, reason + '（重跑派发异常）');
    notifyTaskEvent(srcTask, false, `自动恢复失败（重跑派发异常）：${e.message}`);
    return false;
  }
}

/** 按分身决策恢复任务：源任务仍在跑且可插嘴 → 直接 steer；否则重派 <src>-resume 任务注入决策继续 */
function resumeTaskWithDecision(srcTask, decision, decisionContent) {
  // 1) 源任务仍在运行且可插嘴 → 直接把决策送入 agent 上下文（steer 继续）
  const entry = active.get(srcTask);
  if (entry && entry.interjectable && entry.child && !entry.child.killed && !entry.child.stdin.destroyed) {
    const ok = sendRPC(entry.child, {
      type: 'prompt', message: `【分身决策】任务决策已定：${decision.trim().slice(0, 200)}。请据此继续完成任务。`, id: 'dec-' + Date.now(), streamingBehavior: 'steer'
    });
    log(`💡 决策[${srcTask}] → 已直接 steer 运行中的 agent ${entry.agentId} ${ok ? '（决策已送入）' : '（写入失败）'}`);
    return;
  }
  // 2) 源任务已结束（写了部分 DONE/FAILED）→ 重派 <src>-resume 任务注入决策继续
  const resumeName = `${srcTask}-resume`;
  const resumeDone = path.join(INBOX, `${resumeName}.DONE`);
  if (readIf(resumeDone)) return;                        // 已恢复过
  const agent = detectSourceAgent(srcTask) || 'coo';
  const srcContent = readIf(path.join(INBOX, `${srcTask}.md`)) || '(源任务已归档)';
  const task = [
    `agent: ${agent}`,
    ``,
    `# 任务：恢复执行 ${srcTask}（按分身决策继续）`,
    ``,
    `## 背景`,
    `任务 ${srcTask} 执行中遇到决策点，已委托分身（user-twin）代为决策，现按决策恢复执行。`,
    ``,
    `## 分身决策`,
    '```',
    (decisionContent || decision).trim(),
    '```',
    ``,
    `## 源任务原始目标`,
    '```',
    srcContent.slice(0, 3000),
    '```',
    ``,
    `## 要求`,
    `1. 先按分身决策继续任务 ${srcTask} 未完成的部分`,
    `2. 若决策已使源任务完成，则验证并收尾`,
    `3. 完成后创建标记文件（一行摘要）：${resumeDone}`,
    `4. 无法完成则写 ${resumeDone} 为 .FAILED: <原因>`,
  ].join('\n');
  fs.writeFileSync(path.join(INBOX, `${resumeName}.md`), task + '\n', 'utf8');
  log(`📨 决策[${srcTask}] → 已投递恢复任务 ${resumeName} → ${agent}（下轮扫描派发）`);
}

/** 从源任务文件读 agent: 头（若未归档） */
function detectSourceAgent(srcTask) {
  const m = (readIf(path.join(INBOX, `${srcTask}.md`)) || '').match(/^agent\s*:\s*(\S+)/m);
  return m ? m[1] : null;
}


/* ── 任务完成/失败通知 → HK new-api 告警（2026-08-08）───── */
// 任务 .DONE/.FAILED 时经 scripts/hk-alert.js 注入 admin_mobile_alerts → APP 弹通知。
// 只报离散的完成/失败事件（失败必报、完成按配置可选），不会每轮巡查刷屏。
const CLUSTER_ALERT_SCRIPT = path.join(ORG_ROOT, 'scripts', 'hk-alert.js');
/* checkpoint 进度快照前缀：进度快照不是离散任务事件，不应推用户通知（2026-08-11 app-notify-detail-fix）。
 * 用户原话：checkpoint 每 30 分钟快照全推（progress.jsonl 路径等技术细节）看不懂、点击不跳转。
 * 现在只写内部日志（logs/<task>.progress.jsonl），完成/失败/异常恢复失败/渠道限额才推用户。 */
const CHECKPOINT_PREFIX = 'checkpoint-';
function isProgressSnapshotTask(name) {
  return String(name || '').startsWith(CHECKPOINT_PREFIX);
}
function notifyTaskEvent(name, ok, doneText, agentId) {
  // 进度快照（checkpoint-*）不推用户通知 —— 只写内部日志，用户不被打扰
  if (isProgressSnapshotTask(name)) {
    log(`🔇 [${name}] checkpoint 进度快照完成 → 跳过用户通知（只写内部日志）`);
    return;
  }
  try {
    const status = ok ? 'done' : 'failed';
    const summary = (doneText || '').trim().slice(0, 200);
    const agent = (agentId || '').trim();
    // hk-alert 参数顺序: <任务名> <done|failed> [智能体名] [完成摘要]
    const args = agent ? [CLUSTER_ALERT_SCRIPT, name, status, agent, summary]
                       : [CLUSTER_ALERT_SCRIPT, name, status, summary];
    const child = spawn(process.execPath || 'node', args, {
      cwd: ORG_ROOT, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, detached: true
    });
    child.unref();
    log(`🔔 任务${ok ? '完成' : '失败'}通知已触发 [${name}]${agent ? ' · ' + agent : ''} → HK new-api 告警注入`);
  } catch (e) { log('任务通知触发失败:', e.message); }
}

/* ── 渠道额度全挂通知（重置卡机制，2026-08-11） ────────── */
// 用户有渠道额度重置卡：额度类失败（403/402/quota/insufficient）不是普通网络错，不能默默 fallback/等用户发现。
// 链路全挂且含额度类失败 → 通知用户「XX 渠道限额，你有重置卡，是否重置？」。
// 节流：同一渠道 30 分钟一次（channel-fallback QUOTA_NOTIFY_COOLDOWN_MS）。
function notifyChannelQuota(ev) {
  try {
    if (!ev || !ev.quota || !ev.quota.needNotify) return;   // 无非额度全挂 or 已在节流内 → 不打扰
    const list = ev.quota.detail || [];
    for (const c of list) {
      if (!cf.shouldNotifyQuota(c.provider)) continue;      // 30min 节流双保险
      cf.markQuotaNotified(c.provider);
      const child = spawn(process.execPath || 'node',
        [CLUSTER_ALERT_SCRIPT, '--quota', c.provider, c.error || '额度用尽（403）'],
        { cwd: ORG_ROOT, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, detached: true });
      child.unref();
      log(`💳 渠道额度通知已触发 [${c.provider}] → HK 告警（重置卡提示）`);
    }
  } catch (e) { log('渠道额度通知触发失败:', e.message); }
}
// 注册渠道全挂通知钩子（2026-08-11）：此前 setNotifier 从未注册，全挂只写日志不真正通知用户
cf.setNotifier(notifyChannelQuota);

/* ── 监控 + 巡查 ────────────────────────────────────────── */
function scanInbox(spawnGroupId) {
  if (!fs.existsSync(INBOX)) return;
  const files = fs.readdirSync(INBOX)
    .filter(f => f.endsWith('.md') && !active.has(f.replace(/\.md$/, '')))
    .filter(f => !fs.existsSync(path.join(INBOX, f.replace(/\.md$/, '.DONE'))))
    .filter(f => {
      // ask-<agentId>.md = 智能体交流问询文件（2026-08-12 agent-collab）→ 不当作任务派发，
      // 由 dispatch 附加给该智能体下次任务（避免占任务槽位/被路由错对象）
      const m = f.match(/^ask-([A-Za-z0-9_-]+)\.md$/);
      if (m) {
        try { const d = registry.load(); if (d.nodes && d.nodes[m[1]]) return false; } catch (e) {}
      }
      return true;
    })
    .filter(f => {
      // .PID 进程存活 = 任务正在跑（可能是 butler 重启前的遗留），不重复派发
      const pid = parseInt(readIf(path.join(INBOX, f.replace(/\.md$/, '.PID'))) || '', 10);
      if (!pid || Number.isNaN(pid)) return true;
      try { process.kill(pid, 0); return false; }
      catch (e) { return e.code === 'EPERM' ? false : true; }
    });
  // 并发限制（2026-08-11 concurrency-routing）：本机同时最多 maxConcurrent 个任务，其余排队
  //   - 远程任务（agentId=hk/cnb）不占本机并发；
  //   - 紧急任务（priority: urgent / 异常恢复 / 用户直投非自动派发）排队时优先补位：
  //     本循环内先评估紧急任务（有空位即先派），不因文件排序被自动派发插队；
  //   - 排队任务写 waiting 表，活动数下降后下一轮 scanInbox 自动补派（文件仍留 inbox）。
  const waiting = readWaiting();
  const maxConc = maxConcurrent();
  const localNow = () => localActiveCount();
  // 紧急任务排序：显式 urgent > 用户直投（非自动派发）> 自动派发。先处理紧急 → 有空位先派紧急。
  const prioOf = task => {
    if (task.priority === 'urgent') return 0;
    if (!isAutoDispatch(task.name)) return 1;   // 用户直投/异常恢复
    return 2;                                    // 自动派发
  };
  // 按优先级排序 files：紧急（用户直投）先评估、先占并发名额
  files.sort((a, b) => {
    const pa = isAutoDispatch(a.replace(/\.md$/, '')) ? 1 : 0;
    const pb = isAutoDispatch(b.replace(/\.md$/, '')) ? 1 : 0;
    return pa - pb;
  });
  // 排队登记（只记一次，避免每轮重复刷日志）
  const enqueue = (task, agentId) => {
    if (waiting[task.name]) return;
    waiting[task.name] = { ts: tsISO(), agentId, prio: prioOf(task), reason: `本机并发达上限 ${maxConc}` };
    writeWaiting(waiting);
    log(`⏳ [并发排队] ${task.name} → 本机活动 ${localNow()}/${maxConc}，排队等待（agentId=${agentId}，prio=${prioOf(task)}）`);
  };
  const dequeue = name => {
    if (waiting[name]) { delete waiting[name]; writeWaiting(waiting); }
  };
  for (const f of files) {
    const taskPath = path.join(INBOX, f);
    const task = parseTask(taskPath);
    const agentId = routeTask(task, spawnGroupId || null);
    const isRemote = (agentId === 'hk' || agentId === 'cnb' || task.side === 'remote');  // 2026-08-12 �޸���side: remote ��ռ��������û���ȫ��������������
    // 并发限制：本机任务满额 → 排队（远程任务不占本机并发，照派）
    if (!isRemote && localNow() >= maxConc) { enqueue(task, agentId); continue; }
    dequeue(task.name);
    // CPU 负载门禁（2026-08-11）：构建类任务高负载暂缓 / 暂缓超限转 CNB
    try {
      const ev = cpuGate.evaluate(task);
      if (ev.action === 'defer') {
        log(`⏸ [负载门禁] ${ev.reason}（任务 ${task.name} 已留待负载回落）`);
        continue;
      }
      if (ev.action === 'escalate') {
        log(`🌐 [负载门禁] ${ev.reason} → 转 CNB 云环境 ${task.name}`);
        dispatchToCnb(task);
        continue;
      }
    } catch (e) { log(`⚠️ [负载门禁] 评估异常（放行）: ${e.message}`); }
    // 全节点负载保护（2026-08-11 load-quota-fix）：构建任务检查目标节点（HK/CNB）负载，超阈值暂缓防卡死
    try {
      const nl = nodeLoad.evaluateForTask(task);
      if (nl.action === 'defer') {
        log(`⏸ [节点负载] ${nl.reason}（任务 ${task.name} 已留待负载回落）`);
        continue;
      }
    } catch (e) { log(`⚠️ [节点负载] 评估异常（放行）: ${e.message}`); }
    dispatch(task, agentId);
  }
}

/** 写恢复决策请求：inbox/decisions/<ts>-<name>.md（分身决策：重跑/归档/换方案） */
function requestRecoveryDecision(name, reason) {
  try {
    ensure(DEC_DIR);
    const ts = new Date().toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, '');
    const base = `${ts}-${name}`;
    const reqPath = path.join(DEC_DIR, `${base}.md`);
    if (readIf(reqPath)) return;   // 已请求过（幂等）
    const rerun = recCount(name);
    const content = [
      `# 决策请求：任务 ${name} 异常中断，如何恢复？`,
      `- 源任务: ${name}`,
      `- 类型: 恢复`,
      `- 问题: 任务 ${name} 异常中断（${reason}），请决定如何恢复。`,
      `- 上下文: 已自动标记失败。重跑计数 ${rerun}/${MAX_RERUN}。`,
      `- 选项: A. 重跑（但管家重新派发原任务文件） B. 归档（保留失败标记，不再重派） C. 换方案（重新评估）`,
      `- 重跑计数: ${rerun}`
    ].join('\n');
    fs.writeFileSync(reqPath, content + '\n', 'utf8');
    log(`🚨 [${name}] 已写恢复决策请求 inbox/decisions/${base}.md（重跑计数 ${rerun}/${MAX_RERUN}）`);
  } catch (e) { log('写恢复决策请求失败:', e.message); }
}

/** 标记任务异常失败并统一收尾（写失败标记 + 记忆 + 自动重跑）
 *  2026-08-10 重构：不再依赖独立 decisions 文件（分身未及时决策就无人接管）。
 *  写失败标记后【立即自动重跑】（限 MAX_RERUN 次）——重跑成功不打扰、重跑失败才升级用户。 */
function failTaskAnomaly(name, entry, reason) {
  // 终态兜底（2026-08-12 anomaly-fallback 失败判定体系化加固）：异常退出前先判定
  // 应"补 DONE"还是"已闭环跳过"，避免对已完成/已闭环任务重复自动重跑（重复补验）。
  const fb = anomaly.decideFallback(name, entry, { inboxDir: INBOX });
  if (fb.action === 'supplement-done') {
    // 补 DONE：日志有完成证据（agent_settled），工作已完成只是收尾崩了 → 补标记，跳过重跑
    log(`✅ [${name}] 异常退出但检测到完成证据（${fb.evidence}）→ 补写 .DONE，跳过自动重跑（${reason}）`);
    const content = anomaly.supplementDone(name, INBOX, fb.evidence);
    try { terminateChild(entry, '🧹 [补DONE收尾]'); } catch (e) {}
    try {
      const memory = require('./lib/memory');
      memory.appendDiary(entry.agentId || 'coo', { task: name, result: content || '补 DONE', lessons: ['任务异常退出但完成，已补 DONE'] });
    } catch (e) {}
    active.delete(name); persistActive();
    return;
  }
  if (fb.action === 'skip-closed') {
    // 已闭环跳过：源任务已由 -improve 覆盖/源已 .DONE → 不再重复补验
    log(`⏭️ [${name}] 异常退出但源任务已由 -improve 闭环 → 跳过自动重跑（${reason}）`);
    anomaly.markClosedSkipped(name, INBOX, reason);
    try { terminateChild(entry, '🧹 [闭环跳过收尾]'); } catch (e) {}
    try {
      const memory = require('./lib/memory');
      memory.appendDiary(entry.agentId || 'coo', { task: name, result: '源任务已闭环，跳过重复补验', lessons: ['源任务已由 -improve 闭环，不再重复补验'] });
    } catch (e) {}
    active.delete(name); persistActive();
    return;
  }
  log(`🚨 [${name}] 异常中断自动恢复：${reason}`);
  try { fs.writeFileSync(entry.doneMarker, `.FAILED: ${reason}`, 'utf8'); } catch (e) {}
  // 杀残留子进程（2026-08-11 load-quota-fix 孤儿根治）：失败路径也必须收尾子进程，
  //   否则 pi RPC 子进程随失败任务残留成孤儿（实测失败任务留 35 个孤儿）。
  try { terminateChild(entry, '🧹 [异常中断收尾]'); } catch (e) {}
  try {
    const memory = require('./lib/memory');
    memory.appendDiary(entry.agentId || 'coo', { task: name, result: reason.slice(0, 120), lessons: ['任务异常中断: ' + reason.slice(0, 60)] });
  } catch (e) {}
  active.delete(name);
  persistActive();
  // 自动重跑并入主循环（2026-08-10）：PID 死/卡死 → 直接自动重跑，不等分身决策
  autoRerunTask(name, reason);
}

/* 目标节点是否高负载（看护放大阈值用，2026-08-11 load-quota-fix）：
 * 任务要求「高负载节点上的任务：看护检查也考虑负载（高负载=允许更慢——不误杀）」。
 * 高负载节点上任务可能运行得更慢——卡死/静默判定阈值应放大，避免把"负载高导致慢"误判为"卡死"强杀。
 * 判定：
 *   - CNB agent（cnb-dev/cnb-build/cnb-test）→ 查对应空间负载（SSH，未知=false 不放大）
 *   - HK agent（hk/hk-*）→ 查 HK 负载（SSH，未知=不放大）
 *   - 本机 agent → 查本机负载（cpu-gate guardian/psutil）
 * 采集失败/未知 → 返回 false（宁按原阈值，不因采集问题误伤或漏杀）。 */
function taskNodeHighLoad(entry) {
  try {
    const agentId = entry && entry.agentId || '';
    if (nodeLoad.CNB_AGENT_SPACE[agentId]) {
      const snap = nodeLoad.getNode('cnb' + nodeLoad.CNB_AGENT_SPACE[agentId]);
      if (snap && snap.load != null) return snap.load >= 70 || (snap.memPct || 0) >= 90;
      return false;
    }
    if (agentId === 'hk' || /^hk-/.test(agentId)) {
      const snap = nodeLoad.getHk();
      if (snap && snap.load != null) return snap.load >= 70 || (snap.memPct || 0) >= 90;
      return false;
    }
    const st = cpuGate.status();
    return st.level === 'high' || st.level === 'critical';
  } catch (e) { return false; }
}

function checkActive() {
  for (const [name, entry] of active.entries()) {
    // 完成标记：.DONE 或 .FAILED 任一存在即算结束（修复：单独写 .FAILED 不识别导致假活跃）
    const done = readIf(entry.doneMarker) || readIf(entry.doneMarker.replace(/\.DONE$/, '.FAILED'));
    if (done) {
      const ok = !done.includes('.FAILED');
      log(`${ok ? '✅' : '❌'} 任务完成: [${name}] → ${done.trim().slice(0, 80)}`);
      // 异常失败标记自动重跑（2026-08-12 auto-rerun-strengthen）：非 recovery rerun 且属异常失败
      // （误杀标记/外部写入/漏网路径，如 .FAILED: 孤儿残留（并发名额释放））→ 自动重跑，不等用户追查。
      // 注意 failTaskAnomaly（PID 死/卡死）已自调 autoRerunTask；这里兑底其他写入者。
      // 仅处理【真失败标记】（isFailMarker）——成功摘要提到 .FAILED/卡死等词不触发重跑。
      if (!ok && !isRecoveryRerun(name) && isFailMarker(done) && isAnomalyFailure(done)) {
        log(`♻️ [${name}] 检测到异常失败标记（${done.trim().slice(0, 80)}）→ 自动重跑（限 ${MAX_RERUN} 次）`);
        try { terminateChild(entry, '🧹 [异常失败标记重跑收尾]'); } catch (e) {}
        active.delete(name);
        persistActive();
        if (!autoRerunTask(name, done.trim().slice(0, 150))) {
          finalizeTask(name, entry, '异常重跑未触发收尾');   // 超限/闭环/源缺失 → 补收尾（删 PID）
        }
        continue;
      }
      // 分级通知（2026-08-08）：异常重跑（recovery rerun）完成
      //  - 成功 → 不通知用户（用户原话：重启成功发我干嘛），只记 [自动恢复] 日志
      //  - 失败 → 自动恢复失败，升级用户带说明
      if (isRecoveryRerun(name)) {
        clearRecoveryRerun(name);
        if (ok) {
          log(`♻️ [${name}] 异常自动恢复成功（重跑完成）→ 已跳过用户通知，记 [自动恢复]`);
          if (notifyAnomalyAutoRecovered()) notifyTaskEvent(name, true, done);  // 显式开启时才通知
        } else {
          log(`🚨 [${name}] 异常自动恢复失败（重跑仍失败）→ 升级用户`);
          const chain = failureChainText(name);
          notifyTaskEvent(name, false, `自动恢复失败（异常重跑仍失败）。失败原因链：${chain || done.trim().slice(0, 120)}`);
        }
      } else {
        // 正常任务完成/失败 → 照常通知（完成按 notifyDone 配置，失败必报）
        // 带 agentId 让人话标题显示 `任务名 · 智能体名 状态`（2026-08-11 app-notify-detail-fix）
        if (!ok) logBusinessFailure(name, done, entry.agentId);   // 业务失败留痕（2026-08-12，不盲跑但记录）
        notifyTaskEvent(name, ok, done, entry.agentId);
      }
      // 记忆沉淀：任务完成自动写日记（lib/memory.js）
      try {
        const memory = require('./lib/memory');
        memory.appendDiary(entry.agentId || 'coo', {
          task: name,
          result: done.trim().slice(0, 120),
          lessons: ok ? [] : ['任务失败: ' + done.trim().slice(0, 60)]
        });
        memory.extractEntities(entry.agentId || 'coo', name + ' ' + done.trim().slice(0, 200));
      } catch (e) { /* 记忆写入失败不阻塞任务流程 */ }
      // 任务终态统一收尾（2026-08-11 根治）：杀子进程 + 删 PID 文件 + 移出 active，一次做齐。
      // 此前只 terminateChild+active.delete、漏删 PID 文件（依赖异步 exit 回调，进程被杀但 exit 未触发即漏）
      // → 完成路径集中用 finalizeTask，PID 同步删，不再依赖 exit 回调。
      finalizeTask(name, entry, '完成收尾');
    } else if (entry.child && entry.child.pid && !isAlive(entry.child.pid)) {
      // 进程死检测（2026-08-08）：pid 已不存在（ESRCH）→ 立即标记失败，不等日志停滞/90 分钟
      // 但若 agent 已 settled（完成声明）后进程自然退出 → 视为正常完成，标记成功（2026-08-09 误杀修复）
      // 仅写标记，不移除 active —— 下一轮由完成分支统一通知+沉淀+清理
      if (entry.settledAt) {
        // settled 后进程退出，但若检测到「渠道空回复」→ 属渠道失效，标空回复失败（走 fallback），非成功
        const empty = cf.detectEmptyReply(entry.logPath, entry.logOffset);
        if (empty.empty) {
          log(`⚠️ [${name}] agent settled 后进程退出但检测到渠道空回复 → 标空回复失败（走 fallback）`);
          try { fs.writeFileSync(entry.doneMarker, `.FAILED: ${cf.EMPTY_REPLY_REASON}`, 'utf8'); } catch (e) {}
        } else {
          log(`✅ [${name}] agent 已 settled 后进程正常退出 → 标记成功`);
          try { fs.writeFileSync(entry.doneMarker, 'agent_settled 后进程正常退出（完成）', 'utf8'); } catch (e) {}
        }
      } else {
        failTaskAnomaly(name, entry, '进程异常中断（pid 已死）');
      }
      // 本分支处理完（settled 成功标记 / 进程中断标记）后终止残留子进程，避免孤儿
      terminateChild(entry, '🧹 [pid死分支收尾]');
    } else if (entry.logPath && fs.existsSync(entry.logPath)) {
      // 日志停滞检测（2026-08-08）：日志 20 分钟无更新 + 无完成标记 → 疑似卡死
      // 防误杀：任务运行不足宽松期、或进程仍活跃且日志最近有更新 → 不触发
      const st = fs.statSync(entry.logPath);
      const runningMs = Date.now() - (entry.startedAt || Date.now());
      const idleMs = Date.now() - st.mtimeMs;
      const procAlive = entry.child && entry.child.pid && isAlive(entry.child.pid);
      // 看护负载感知（2026-08-11 load-quota-fix）：高负载节点允许更慢——卡死阈值放大 2 倍，不误杀
      const highLoad = taskNodeHighLoad(entry);
      const stallMs = highLoad ? LOG_STALL_MS * 2 : LOG_STALL_MS;
      if (runningMs > STALL_GRACE_MS && idleMs > stallMs && procAlive) {
        log(`⚠️ [${name}] 疑似卡死（日志 ${Math.round(idleMs / 60000)} 分钟未更新${highLoad ? '，节点高负载阈值已放大×2' : ''}），强制结束 + 恢复`);
        try { process.kill(entry.child.pid); } catch (e) {}
        try { entry.child.kill(); } catch (e) {}
        failTaskAnomaly(name, entry, `疑似卡死（日志 ${Math.round(idleMs / 60000)} 分钟未更新）`);
      } else if (procAlive) {
        // 空转检测：只读【本次派发后新增】的日志（避免旧日志的 agent_settled 残留误杀新进程）
        try {
          const start = Math.min(entry.logOffset || 0, st.size);
          const fd = fs.openSync(entry.logPath, 'r');
          const buf = Buffer.alloc(st.size - start);
          fs.readSync(fd, buf, 0, buf.length, start);
          fs.closeSync(fd);
          const tail = buf.toString('utf8').slice(-2000);
          // 只匹配 JSON 事件格式的 agent_settled（防任务描述/正文里出现该词误判——2026-08-09 实测教训）
          const settledRe = /"type"\s*:\s*"agent_settled"/;
          if (settledRe.test(tail)) {
            // agent_settled 是完成标志（2026-08-09 误杀修复）：默认不标失败。
            // 但若检测到「渠道空回复」（message_end content 空 + 0 token）→ 属渠道失效：
            //   标 .FAILED: 渠道空回复 + 强制结束 → 由 exit 处理器清标记 + 走 fallback 切换下一渠道（2026-08-09）
            const empty = cf.detectEmptyReply(entry.logPath, entry.logOffset);
            if (empty.empty && !readIf(entry.doneMarker)) {
              log(`⚠️ [${name}] agent settled 但检测到渠道空回复（content 空/0 token）→ 标空回复失败 + 强制结束（走 fallback）`);
              try { process.kill(entry.child.pid); } catch (e) {}
              try { entry.child.kill(); } catch (e) {}
              try { fs.writeFileSync(entry.doneMarker, `.FAILED: ${cf.EMPTY_REPLY_REASON}`, 'utf8'); } catch (e) {}
              continue;   // 本轮不再走 settled 成功分支（exit 处理器负责 fallback 切换）
            }
            // 宽限期（60s）内等待进程自行退出；仍不退 → 标记【成功】+ 强制结束（不走 failTaskAnomaly）
            const now = Date.now();
            if (!entry.settledAt) {
              entry.settledAt = now;
              persistActive();
              log(`⏳ [${name}] agent 已 settled，等待进程退出（宽限 ${SETTLED_GRACE_MS / 1000}s）`);
            } else if (now - entry.settledAt > SETTLED_GRACE_MS) {
              log(`✅ [${name}] agent 已 settled 但 ${SETTLED_GRACE_MS / 1000}s 未退出 → 标记成功 + 强制结束`);
              try { process.kill(entry.child.pid); } catch (e) {}
              try { entry.child.kill(); } catch (e) {}
              // 只写成功标记，不移除 active —— 下一轮完成分支统一通知+沉淀+清理
              try { fs.writeFileSync(entry.doneMarker, 'agent_settled 后进程退出（宽限已过，判定完成）', 'utf8'); } catch (e) {}
            }
            // 宽限期内：等待，进程中途退出由 pid 死分支接手标记成功
          }
        } catch (e) { /* 读日志失败不阻塞 */ }
      }
    }
  }
}

/* ── 摘要 ────────────────────────────────────────────────── */
function printSummary() {
  const data = registry.load();
  const lines = ['', '=== 管家摘要 ==='];
  registry.traverse('root', (node, depth) => {
    if (node.type === 'root') return;
    const indent = '  '.repeat(depth - 1);
    const icon = node.type === 'group' ? '📁' : '🤖';
    const status = node.status ? `[${node.status}]` : '';
    const lastTask = node.lastTaskAt ? ` 最后任务: ${node.lastTaskAt.slice(0, 16)}` : '';
    lines.push(`${indent}${icon} ${node.label} ${status}${lastTask}`);
  });
  lines.push(`活动任务: ${active.size} 个`);
  for (const [name, e] of active.entries()) {
    lines.push(`  ▸ [${name}] → ${e.agentId} (运行 ${Math.round((Date.now()-e.startedAt)/60000)} 分钟)`);
  }
  lines.push('');
  lines.forEach(l => log(l));
}

/* ── 主程序 ─────────────────────────────────────────────── */
/* ── opencode 每日探活（余额故障恢复探测，2026-08-05 加） ───── */
// 背景：opencode Go 订阅余额故障（billing 页 wrk_01KWP7NXZSWX5NVV7J20QQ71A9），
// 恢复前 go 渠道不可用。每天 09:00 后探一次：GET /models + 一次最小 chat，
// 结果写 logs/opencode-health.log；一旦 chat 通了说明已恢复，日志里会标 ✅。
const HEALTH_STATE = path.join(LOGS, 'opencode-health-state.json');
const HEALTH_LOG   = path.join(LOGS, 'opencode-health.log');

function httpReq(method, urlStr, headers, body, timeoutMs) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve({ ok: false, error: 'bad url' }); }
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request({
      method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, headers, timeout: timeoutMs || 15000
    }, res => {
      let buf = '';
      res.on('data', d => { buf += d; if (buf.length > 200000) req.destroy(); });
      res.on('end', () => resolve({ ok: res.statusCode < 400, code: res.statusCode, body: buf.slice(0, 2000) }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

function readGoApiKey() {
  // 从 pi models.json 取 opencode-go 系 key，不硬编码
  // 2026-08-11 mgmt-pm improve：跨平台——本机 Windows 用 USERPROFILE，
  // HK/CNB Linux 用 HOME（org-runner home=/data/agent-cluster），消除 Windows 硬编码
  try {
    const home = process.env.USERPROFILE || process.env.HOME ||
      (process.platform === 'win32' ? 'C:/Users/du_ji' : '/data/agent-cluster');
    const mm = JSON.parse(fs.readFileSync(path.join(home,
      '.pi/agent/models.json'), 'utf8'));
    const p = mm && mm.providers;
    if (!p) return null;
    for (const k of ['opencode-go-anthropic', 'opencode-go']) {
      if (p[k] && p[k].apiKey) return { key: p[k].apiKey, baseUrl: (p[k].baseUrl || 'https://opencode.ai/zen/go').replace(/\/$/, '') };
    }
  } catch (e) {}
  return null;
}

async function opencodeHealthCheck() {
  try {
    const st = JSON.parse(readIf(HEALTH_STATE) || '{}');
    const today = new Date().toISOString().slice(0, 10);
    if (st.lastCheckDate === today) return;          // 今天已查过
    if (new Date().getHours() < 9) return;            // 白天再查，不占夜间窗口
    st.lastCheckDate = today;
    fs.writeFileSync(HEALTH_STATE, JSON.stringify(st), 'utf8');

    const lines = [`[${tsISO()}] opencode 每日探活`];
    // 1) zen free 端点（无 key，应该一直通）
    const freeModels = await httpReq('GET', 'https://opencode.ai/zen/v1/models', { accept: 'application/json' });
    lines.push(`  zen free /models → ${freeModels.ok ? 'OK ' + freeModels.code : 'FAIL ' + (freeModels.code || freeModels.error)}`);
    // 2) go 端点 /models + 最小 chat（余额故障探测点）
    const go = readGoApiKey();
    if (!go) {
      lines.push('  go key 读不到（models.json 无 opencode-go* provider），跳过 go 探测');
    } else {
      const auth = { accept: 'application/json', authorization: 'Bearer ' + go.key };
      const goModels = await httpReq('GET', go.baseUrl + '/v1/models', auth);
      lines.push(`  go /models → ${goModels.ok ? 'OK ' + goModels.code : 'FAIL ' + (goModels.code || goModels.error)}` +
                 (goModels.ok ? '' : '（' + (goModels.body || '').slice(0, 120).replace(/\n/g, ' ') + '）'));
      const chat = await httpReq('POST', go.baseUrl + '/v1/chat/completions',
        { ...auth, 'content-type': 'application/json' },
        JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }));
      if (chat.ok) {
        lines.push(`  go chat ping → ✅ OK ${chat.code} —— 余额故障已恢复！可解除 model-routing SKILL.md 的"待恢复"标注`);
      } else {
        lines.push(`  go chat ping → ❌ FAIL ${chat.code || chat.error}（未恢复）` +
                   '（' + (chat.body || '').slice(0, 120).replace(/\n/g, ' ') + '）');
      }
    }
    const txt = lines.join('\n');
    console.log(txt);
    fs.appendFileSync(HEALTH_LOG, txt + '\n', 'utf8');
  } catch (e) {
    try { fs.appendFileSync(HEALTH_LOG, `[${tsISO()}] 探活异常: ${e.message}\n`, 'utf8'); } catch (_) {}
  }
}

function main() {
  const argv = process.argv.slice(2);

  // --summary：输出摘要后退出
  if (argv.includes('--summary')) { printSummary(); return; }

  // --cpu-gate：输出 CPU 负载门禁状态后退出（2026-08-11）
  if (argv.includes('--cpu-gate')) {
    const st = cpuGate.status();
    console.log('=== CPU 负载门禁状态 ===');
    console.log(JSON.stringify(st, null, 2));
    return;
  }

  // --fullscan-guard：输出全盘扫描看护状态后退出（2026-08-11 fullscan-guard）
  if (argv.includes('--fullscan-guard')) {
    const cfg = fullscanGuard.loadConfig();
    const res = fullscanGuard.scan();
    console.log('=== 全盘扫描看护状态 ===');
    console.log(JSON.stringify({ enabled: cfg.enabled, checkIntervalMin: cfg.checkIntervalMin, maxSimultaneous: cfg.maxSimultaneous, result: res }, null, 2));
    return;
  }

  // --node-load：输出全节点负载状态后退出（2026-08-11 load-quota-fix）
  if (argv.includes('--node-load')) {
    console.log('=== 全节点负载状态 ===');
    console.log(JSON.stringify(nodeLoad.status(), null, 2));
    return;
  }

  // --spawn <group>：派生分管某组的分身
  const spawnIdx = argv.indexOf('--spawn');
  const spawnGroupId = spawnIdx >= 0 ? argv[spawnIdx + 1] : null;
  const butlerLabel = spawnGroupId ? `管家分身[${spawnGroupId}]` : '管家(COO)';

  // 单实例锁（--spawn 分身不需要锁，各组一把）
  const lockFile = spawnGroupId ? path.join(ORG_ROOT, `butler-${spawnGroupId}.pid`) : PID_FILE;
  try {
    const existing = readIf(lockFile);
    if (existing) {
      const pid = parseInt(existing.trim(), 10);
      try { process.kill(pid, 0); console.error(`${butlerLabel} 已在运行（PID=${pid}），退出`); process.exit(1); }
      catch (e) { /* 锁过期，继续 */ }
    }
    fs.writeFileSync(lockFile, String(process.pid), 'utf8');
  } catch (e) { console.error('锁文件写入失败:', e.message); }

  // 在 org.json 中注册分身
  if (spawnGroupId) {
    const spawnId = `butler-${spawnGroupId}`;
    const existing = registry.getNode(spawnId);
    if (!existing) {
      registry.setNode(spawnId, {
        id: spawnId, type: 'agent', label: `管家分身[${spawnGroupId}]`, role: 'sub-butler',
        status: 'active', parent: 'grp-coo', agentDir: `agents/${spawnId}`, spawnType: 'node',
        spawnGroup: spawnGroupId, pid: process.pid, children: []
      });
      registry.addChild('grp-coo', spawnId);
    }
  }

  ensure(INBOX); ensure(LOGS);
  log(`=== ${butlerLabel} 启动 (PID=${process.pid}) ===`);

  // 孤儿进程清扫（2026-08-11 根治）：启动即扫 inbox/*.PID——清历史残留（重启丢失的孤儿子进程 + 漏删的 PID 文件）
  // 仅主管家执行（分身 active 表不全会误杀主管家正在跑的任务）
  if (!spawnGroupId) sweepOrphans();
  if (!spawnGroupId) sweepRpcOrphans();   // 扫游离 pi RPC 孙进程（2026-08-11 load-quota-fix）：睡眠模式下不转任务（避免同睡眠会话内立即派发），退出睡眠后下次启动再派
  if (!spawnGroupId) sweepSilentFailures();   // 静默失败兑底（2026-08-12）：启动即恢复未重跑的异常失败标记
  if (!spawnGroupId && !sleepModeOn()) restorePlans();
  else if (sleepModeOn()) log('😴 睡眠模式开启：启动不恢复派发计划（退出睡眠并重启 butler 后自动派发）');

  if (argv.includes('--once')) {
    if (!spawnGroupId) sweepOrphans();   // --once 也扫（手动清理残留）
    if (!spawnGroupId) sweepRpcOrphans();
    if (!spawnGroupId) sweepSilentFailures();   // --once 也跑静默失败兑底（2026-08-12）
    // 调度层兜底（2026-08-12 故障族加固）：DONE 写入前死亡的已完成任务 → 先补 DONE，避免 scanInbox 盲目重派
    if (!spawnGroupId) {
      try {
        const sp = anomaly.settlePending(INBOX, LOGS);
        if (sp.supplemented) log(`♻️ [调度层兜底] 补 DONE ${sp.supplemented} 个（DONE 写入前死亡，工作实际已完成）: ${sp.names.join(', ')}`);
      } catch (e) { log(`⚠️ [调度层兜底] settlePending 异常: ${e.message}`); }
    }
    scanInbox(spawnGroupId); checkActive(); printSummary();
    setTimeout(() => { try { fs.unlinkSync(lockFile); } catch (e) {} process.exit(0); }, 3000);
    return;
  }

  // 常驻模式
  let tick = 0;
  let lastMisjudgedAt = 0;
  let lastExecAuditAt = 0;   // 执行完整性审计节流（2026-08-12）
  let lastSessionArchiveAt = 0;
  // 睡前模式自动关机状态（仅主管家进程内）
  let sleepIdleSince = 0;           // 队列清空后的空闲计时起点（ms）
  let sleepShutdownPlanned = false; // 是否已计划/触发关机（防重复触发）
  /* 睡前关机联动检查：flag 存在 + 队列空 + 连续 idleMin 分钟无活动 → 关机 */
  const checkSleepShutdown = () => {
    if (spawnGroupId) return;                 // 仅主管家调度关机
    const cfg = sleepShutdownCfg();
    if (!sleepModeOn()) {                     // 用户醒后清 flag → 取消
      if (sleepShutdownPlanned) { log('[睡前模式] flag 已清除，取消关机计划'); sleepShutdownPlanned = false; }
      sleepIdleSince = 0;
      return;
    }
    if (active.size > 0) {                    // 有任务在跑：记最近任务 + 重置空闲；已计划则取消
      lastTaskName.value = active.keys().next().value;
      if (sleepShutdownPlanned) { log('[睡前模式] 检测到新任务，取消关机计划'); sleepShutdownPlanned = false; }
      sleepIdleSince = 0;
      return;
    }
    // 队列为空：累计空闲计时
    if (sleepIdleSince === 0) { sleepIdleSince = Date.now(); return; }
    if (Date.now() - sleepIdleSince >= (cfg.idleMin || 5) * 60 * 1000 && !sleepShutdownPlanned) {
      sleepShutdownPlanned = true;
      const reason = `任务队列清空已满 ${cfg.idleMin || 5} 分钟无新活动`;
      log(`[睡前模式] ${reason} → 触发自动关机（${cfg.shutdownDelaySec || 60} 秒倒计时）`);
      writeShutdownNote(reason);
      runShutdown(cfg.shutdownDelaySec || 60);
    }
  };
  const cycle = () => {
    // 调度层兜底（2026-08-12 故障族加固）：扫描死 PID + 无终态标记但工作实际已完成的残留任务 → 补 DONE
    // 优先于 scanInbox，使补 DONE 后的任务被 scanInbox 的 .DONE 过滤跳过，不再盲目重派/触发无效 -improve 补验
    if (!spawnGroupId) {
      try {
        const sp = anomaly.settlePending(INBOX, LOGS);
        if (sp.supplemented) log(`♻️ [调度层兜底] 补 DONE ${sp.supplemented} 个（DONE 写入前死亡，工作实际已完成）: ${sp.names.join(', ')}`);
      } catch (e) { log(`⚠️ [调度层兜底] settlePending 异常: ${e.message}`); }
    }
    scanInbox(spawnGroupId);
    checkActive();
    persistActive();   // 共享表随轮询刷新（兜底：任何遗漏的 active 变化都会被盖上）
    if (!spawnGroupId) scanDiscussion();   // 主管家接分身讨论议题（零需求时零开销）
    if (!spawnGroupId) scanDecisionResults();   // 主管家接分身决策结果，恢复任务（2026-08-08）
    // 误杀标记自动归档（仅主管家，节流 60s；幂等，无残留时近零开销）
    if (!spawnGroupId && Date.now() - lastMisjudgedAt > 60 * 1000) {
      cleanupMisjudged();
      lastMisjudgedAt = Date.now();
    }
    // 执行完整性审计（2026-08-12 用户+魇. 共识）：任务内容含异常特征但 DONE 无过程记录
    // → 记 logs/exec-completeness-violations.jsonl + 告警；异常有处理记录 → 自动捕获沉淀候选
    if (!spawnGroupId && Date.now() - lastExecAuditAt > 60 * 1000) {
      try {
        const ec = require('./lib/exec-completeness');
        const res = ec.scanAndAudit(INBOX, LOGS, path.join(__dirname, 'knowledge'));
        if (res.violations) log(`⚠️ [执行完整性] ${res.violations} 个任务有异常特征但 DONE 无过程记录（静默绕过嫌疑，详见 logs/exec-completeness-violations.jsonl）`);
        if (res.pitfallCandidates) log(`🧫 [执行完整性] ${res.pitfallCandidates} 条过程沉淀已自动捕获 → knowledge/pitfalls-inbox.md`);
      } catch (e) { log(`⚠️ [执行完整性] 审计异常: ${e.message}`); }
      lastExecAuditAt = Date.now();
    }
    // 子代理会话归档（2026-08-12 会话复用配套：超 7 天未活动的会话 jsonl → archived-sessions，
    // 防 sessions/ 随任务无限堆积；节流 6h，实际每天最多一次；只移 mtime 老的，活跃会话不受影响）
    if (!spawnGroupId && Date.now() - lastSessionArchiveAt > 6 * 3600 * 1000) {
      try {
        const { execFile } = require('./lib/win-spawn');
        execFile(process.execPath, [path.join(__dirname, 'scripts', 'archive-sessions.js'), '--days', '7'],
          { timeout: 60 * 1000, windowsHide: true }, (err) => {
            if (err) log(`⚠️ 会话归档异常: ${err.message}`);
          });
      } catch (e) { log(`⚠️ 会话归档异常: ${e.message}`); }
      lastSessionArchiveAt = Date.now();
    }
    tick++;
    if (tick % SUMMARY_EVERY === 0) printSummary();
    if (!spawnGroupId) opencodeHealthCheck();   // 主管家每日一次，分身不重复查
    checkSleepShutdown();   // 睡前模式自动关机联动（2026-08-11）：flag + 空队列 + 空闲满阈值
  };

  // 插嘴通道只挂在主管家（分身任务少且 active 表同文件会互相覆盖）
  if (!spawnGroupId) watchInterject();

  // 学习进化官常驻巡检（2026-08-07 console-activity-fix）：
  // 主管家每小时 spawn patrol.js（实体审核+diary抽查），产出写入
  // entity-review-log.md + logs/learning-officer-patrol.log（控制台可读，角色 fallback 日志源）
  if (!spawnGroupId) {
    let lastPatrolAt = 0;
    const PATROL_INTERVAL_MS = 60 * 60 * 1000;   // 每小时一次
    const PATROL_SCRIPT = path.join(ORG_ROOT, 'agents', 'learning-officer', 'patrol.js');
    const PATROL_OUT = path.join(LOGS, 'learning-officer-patrol.log');
    const runPatrol = () => {
      const now = Date.now();
      if (now - lastPatrolAt < PATROL_INTERVAL_MS) return;
      lastPatrolAt = now;
      const child = spawn(process.execPath, [PATROL_SCRIPT], { cwd: ORG_ROOT, windowsHide: true });
      const sink = (buf, tag) => {
        const s = String(buf).trim();
        if (!s) return;
        const line = `[${new Date().toLocaleTimeString()}] ${tag}${s}`;
        log('🔬 学习进化官巡检: ' + s.slice(0, 160));
        try { fs.appendFileSync(PATROL_OUT, line + '\n', 'utf8'); } catch (e) {}
      };
      child.stdout.on('data', d => sink(d, ''));
      child.stderr.on('data', d => sink(d, 'ERR '));
      child.on('exit', code => {
        const line = `[${new Date().toLocaleTimeString()}] patrol 退出 code=${code}`;
        log(line);
        try { fs.appendFileSync(PATROL_OUT, line + '\n', 'utf8'); } catch (e) {}
      });
      child.on('error', e => {
        try { fs.appendFileSync(PATROL_OUT, `[${new Date().toLocaleTimeString()}] patrol 启动失败: ${e.message}\n`, 'utf8'); } catch (_) {}
      });
    };
    setTimeout(runPatrol, 10 * 1000);       // 启动 10s 后跑首轮
    setInterval(runPatrol, 5 * 60 * 1000);  // 每 5 分钟检查时间窗（实际每小时一次）
  }

  // 双集群同步守护（仅主管家）：每 syncIntervalMs 跑一次 dual-sync.js（--quiet），后台 detached 不阻塞
  if (!spawnGroupId) {
    const dsCfg = require('./config/dual-sync.json');
    if (dsCfg.enabled) {
      const SYNC_INTERVAL_MS = dsCfg.syncIntervalMs || 15 * 60 * 1000;
      const runDualSync = () => {
        const child = spawn(process.execPath, [path.join(ORG_ROOT, 'scripts', 'dual-sync.js'), '--quiet'], { cwd: ORG_ROOT, windowsHide: true, detached: true });
        child.unref();
        child.on('error', e => log('双集群同步启动失败: ' + e.message));
      };
      setTimeout(runDualSync, 30 * 1000);   // 启动 30s 后首跑
      setInterval(runDualSync, SYNC_INTERVAL_MS);
    }
  }

  // Git 通道同步守护（2026-08-11 cnb-sync-p0，仅主管家）：每 10 分钟 commit+push 到 cnb.cool 私有仓库
  // （互联 Git 通道 pull 模型主端；HK/CNB 从远端 pull）。后台 detached 不阻塞。
  if (!spawnGroupId) {
    const runGitSync = () => {
      const child = spawn(process.execPath, [path.join(ORG_ROOT, 'scripts', 'git-sync.js'), '--quiet'], { cwd: ORG_ROOT, windowsHide: true, detached: true });
      child.unref();
      child.on('error', e => log('Git 同步启动失败: ' + e.message));
    };
    setTimeout(runGitSync, 60 * 1000);      // 启动 60s 后首跑
    setInterval(runGitSync, 10 * 60 * 1000); // 每 10 分钟一次
  }

  // 每日例会调度器（2026-08-09，仅主管家）：每日 config/daily-meeting.json 设定时间（默认 22:00）
  // 触发 → 写 inbox/daily-meeting-<date>.md（type: daily-meeting）→ butler 捡起 → lib/daily-meeting.js
  // 有任务在跑则顺延（窗口期内每分钟重试，天然实现"有任务则顺延"）；已开过则不再开。
  if (!spawnGroupId) {
    let dmCfg = { enabled: true, hour: 22, minute: 0, windowMinutes: 90 };
    try { dmCfg = Object.assign(dmCfg, require('./config/daily-meeting.json')); } catch (e) {}
    const runDailyMeetingCheck = () => {
      if (!dmCfg.enabled) return;
      const d = new Date();
      const hm = d.getHours() * 60 + d.getMinutes();
      const start = (dmCfg.hour * 60 + dmCfg.minute);
      const end = start + (dmCfg.windowMinutes || 90);
      if (hm < start || hm > end) return;   // 不在例会窗口
      const date = d.toISOString().slice(0, 10);
      const taskName = `daily-meeting-${date}`;
      if (readIf(path.join(INBOX, `${taskName}.DONE`))) return;   // 今日已开过
      if (readIf(path.join(INBOX, `${taskName}.md`))) return;      // 已在队列
      if (active.size > 0) { log('🌙 每日例会：当前有任务进行中，顺延等待…'); return; }  // 有任务则顺延
      const content = [
        `type: daily-meeting`,
        `date: ${date}`,
        `agent: coo`,
        `provider: opencode-go`,
        `model: deepseek-v4-flash`,
        `thinking: off`,
        ``,
        `# 每日例会：${date}（夜间复盘 + 派发次日）`,
        ``,
        `全员大会（各智能体当日汇报）→ 管理组小会（评估+决策）→ 汇报文档 → 自动派发明日任务。`,
        ``,
      ].join('\n');
      fs.writeFileSync(path.join(INBOX, `${taskName}.md`), content, 'utf8');
      log(`🌙 每日例会触发: ${taskName}`);
    };
    setTimeout(runDailyMeetingCheck, 5 * 1000);
    setInterval(runDailyMeetingCheck, 60 * 1000);  // 每分钟检查（窗口内触发）
  }

  // 职责调度表（2026-08-09 auto-schedule，仅主管家）：统一 channel-manager 巡检 / intel-gatherer 收集 / reviewer 验收 三个定时
  // 配置 config/auto-schedule.json（改间隔即生效，每次 check 重读表）。每 60s 检查一次，到点触发：
  //   - channel-manager（inline）：读健康表 + 冷却渠道恢复探测，activity 留痕
  //   - intel-gatherer（dispatch）：写 inbox/intel-collect-<ts>.md 自动派发收集
  //   - reviewer（dispatch）：每日例会前写 inbox/review-daily-<date>.md 自动验收
  if (!spawnGroupId) {
    const runAutoSchedule = () => {
      try {
        const as = require('./lib/auto-schedule');
        as.check().then(fired => {
          if (fired && fired.length) log('🔁 职责调度: ' + fired.join(' | '));
        }).catch(e => log('职责调度异常: ' + e.message));
      } catch (e) { log('职责调度加载失败: ' + e.message); }
    };
    setTimeout(runAutoSchedule, 8 * 1000);
    setInterval(runAutoSchedule, 60 * 1000);  // 每分钟检查（窗口内触发）
  }

  // 自动复盘闭环（2026-08-10 review-loop，仅主管家）：任务完成钩子（DONE→复盘条目 append knowledge/reviews/<date>.jsonl）
  // + 生成例会管理组小会材料（当日复盘+待验证改进项）。config/review-loop.json 改即生效。
  if (!spawnGroupId) {
    const runReviewLoop = () => {
      try {
        const rl = require('./lib/review-loop');
        const changed = rl.check() || [];
        if (changed && changed.length) log('📝 复盘闭环: ' + changed.join(' | '));
      } catch (e) { log('复盘闭环异常: ' + e.message); }
    };
    setTimeout(runReviewLoop, 15 * 1000);
    setInterval(runReviewLoop, 5 * 60 * 1000);
  }

  // 资源锁巡检（2026-08-10 resource-lock，仅主管家）：扫描运行中活跃写集是否有多任务并发占用同一共享资源
  // （顶部门级 rl=resource-lock；勿用局部 rl 变量遮蔽）。核心链路 preDispatch→claim→release 已挂派发/回收钩子，
  // 此巡检补「运行中任务间冲突」最后一环：有冲突 log 警示，供分身/但管家人工协调。
  if (!spawnGroupId) {
    const runResourceLockCheck = () => {
      try {
        const conflicts = rl.check();
        if (conflicts && conflicts.length) log('🔒 资源锁巡检冲突: ' + conflicts.map(c => `${c.resource}←并发占用 ${c.by.join(',')}`).join(' | '));
      } catch (e) { log('资源锁巡检异常: ' + e.message); }
    };
    setTimeout(runResourceLockCheck, 15 * 1000);
    setInterval(runResourceLockCheck, 5 * 60 * 1000);
  }

  // 异常自动优化闭环（2026-08-10 auto-optimize，仅主管家）：扫描 .FAILED 超阈值任务自动优化
  //   （换渠道/换执行者/拆步/环境自查，决策留痕 logs/auto-optimize.jsonl + 复盘条目 review-loop）
  //   与 task-watchdog（看护卡死）衔接：watchdog 管询问，auto-optimize 管失败后策略。
  if (!spawnGroupId) {
    const runAutoOptimize = () => {
      try {
        const ao = require('./lib/auto-optimize');
        const touched = ao.check() || [];
        if (touched.length) log('🔧 异常自动优化: ' + touched.join(' | '));
      } catch (e) { log('异常自动优化异常: ' + e.message); }
    };
    const aoCfg = (() => { try { return require('./config/auto-optimize.json'); } catch (e) { return {}; } })();
    const aoInterval = (aoCfg.checkIntervalMin || 5) * 60 * 1000;
    setTimeout(runAutoOptimize, 18 * 1000);
    setInterval(runAutoOptimize, aoInterval);
  }

  // 智能体互救巡检（2026-08-12 agent-rescue-core，仅主管家）：跟踪进行中的救援案例
  //   （rescue-* 任务是否完成/失败/超时 → 成功闭环不打扰用户 / 失败换救援者 / 耗尽升级用户）
  //   与 auto-optimize 分工：auto-optimize 管同任务级优化（换渠道/换执行者），
  //   agent-rescue 管跨智能体互救（诊断+修复+接管）。config/agent-rescue.json 改即生效。
  if (!spawnGroupId) {
    const runAgentRescue = () => {
      try {
        const ar = require('./lib/agent-rescue');
        const res = ar.check() || { resolved: [], escalated: [] };
        if (res.resolved && res.resolved.length) log('🚑 互救闭环: ' + res.resolved.map(t => `[${t} 救援成功]`).join(' '));
        if (res.escalated && res.escalated.length) log('🚨 互救升级: ' + res.escalated.join('、') + ' → 用户');
      } catch (e) { log('互救巡检异常: ' + e.message); }
    };
    const arCfg = (() => { try { return require('./config/agent-rescue.json'); } catch (e) { return {}; } })();
    const arInterval = (arCfg.checkIntervalMin || 5) * 60 * 1000;
    setTimeout(runAgentRescue, 25 * 1000);
    setInterval(runAgentRescue, arInterval);
  }

  // 长任务定时自检反馈（2026-08-09 task-watchdog，仅主管家）：butler 主动看护运行超 30min 的长任务
  //   ①运行满 30/60/120/240min 节点主动问进度 ②日志连续 10min 无输出 → 自动投递进度询问
  //   询问写 inbox/checkpoint-<task>-<stamp>-<tag>.md（轻量 flash），回复写 logs/<task>.progress.jsonl
  //   完成时进度链附 .DONE；与异常恢复分工：看护管汇报、恢复管重启。config/task-watchdog.json 改即生效。
  if (!spawnGroupId) {
    const runTaskWatchdog = () => {
      try {
        const tw = require('./lib/task-watchdog');
        // 2026-08-10 修复：tw.check() 是同步函数（返回 {dispatched, completed} 对象），
        // 旧代码误用 .then() 导致每次都报 'tw.check(...).then is not a function'，看护从未在主循环生效。
        const res = tw.check() || { dispatched: [], completed: [] };
        if (res.dispatched && res.dispatched.length) log('⏱ 任务看护: ' + res.dispatched.map(d => `[${d.task} ${d.kind}${d.node ? '#' + d.node : ''}${d.idleMin ? ' 静默' + d.idleMin + 'min' : ''}]`).join(' '));
        if (res.completed && res.completed.length) log('⏱ 任务看护: 附进度链 ' + res.completed.join('、'));
      } catch (e) { log('任务看护异常: ' + e.message); }
    };
    const twCfg = (() => { try { return require('./config/task-watchdog.json'); } catch (e) { return {}; } })();
    const twInterval = (twCfg.checkIntervalMin || 5) * 60 * 1000;
    setTimeout(runTaskWatchdog, 12 * 1000);
    setInterval(runTaskWatchdog, twInterval);

    // 全盘 find/grep 检测看护（2026-08-11 fullscan-guard，仅主管家）：每 checkIntervalMin=2 分钟
    //   扫描 find.exe/grep.exe/rg.exe 进程命令行，命中全盘根（/、C:/、/c、/mnt/c）或进程数> maxSimultaneous
    //   → taskkill 杀 + 记 activity（[防卡死]）+ 若父任务仍在写提示到 logs/<task>.log（任务回合内可见）。
    //   白名单：受限目录扫描（/data/terraria 等多级路径）不拦，只拦 / 根/全盘。config/fullscan-guard.json 改即生效。
    const runFullscanGuard = () => {
      try {
        const res = fullscanGuard.scan() || { killed: [], hints: [], countTriggered: false };
        if (res.killed && res.killed.length) log(`🔪 [全盘看护] 杀全盘 find/grep ${res.killed.length} 个（${res.killed.join(',')}）` +
          ((res.hints && res.hints.length) ? `；提示任务 ${res.hints.join('、')}` : ''));
        else if (res.countTriggered) log(`🔪 [全盘看护] find/grep 进程数异常，已清杀全部`);
      } catch (e) { log('全盘看护异常: ' + e.message); }
    };
    const fsgCfg = (() => { try { return require('./config/fullscan-guard.json'); } catch (e) { return {}; } })();
    const fsgInterval = (fsgCfg.checkIntervalMin || 2) * 60 * 1000;
    setTimeout(runFullscanGuard, 10 * 1000);
    setInterval(runFullscanGuard, fsgInterval);

    // 孤儿进程定期清扫（2026-08-11 根治）：每 10 分钟扫一次 inbox/*.PID + 游离 RPC 进程，防运行期积累
    setInterval(sweepOrphans, 10 * 60 * 1000);
    setInterval(sweepRpcOrphans, 10 * 60 * 1000);
    // 静默失败兑底巡检（2026-08-12 auto-rerun-strengthen）：扫描未恢复的异常失败标记 → 自动重跑
    setInterval(sweepSilentFailures, 10 * 60 * 1000);
  }

  // 初次立即跑一轮
  setTimeout(cycle, 500);
  const timer = setInterval(cycle, POLL_MS);

  // fs.watch 实时响应新任务文件投递
  try {
    fs.watch(INBOX, { persistent: true }, (_, fname) => {
      if (fname && fname.endsWith('.md')) setTimeout(cycle, 800);
    });
  } catch (e) { log('fs.watch 不可用:', e.message); }

  process.on('SIGINT', () => {
    clearInterval(timer);
    log(`${butlerLabel} 停止`);
    try { fs.unlinkSync(lockFile); } catch (e) {}
    process.exit(0);
  });
  process.on('exit', () => { try { fs.unlinkSync(lockFile); } catch (e) {} });

  // 保持进程存活
  setInterval(() => {}, 60000);
}

if (require.main === module) main();

// 导出供测试/复用（2026-08-12）：routeTask/parseTask 单测用
module.exports = { parseTask, routeTask, isAnomalyFailure, isFailMarker, recoverFromFailure, sweepSilentFailures, degradeNodeTask, failureChainText, appendFailureChain };

