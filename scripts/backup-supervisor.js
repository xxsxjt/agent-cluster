#!/usr/bin/env node
/**
 * backup-supervisor.js — 备用监督者（org 版，2026-08-12）
 *
 * 用户 2026-08-12 21:4x 第一版设计落地（参考 hub orchestrator+supervisor 双进程框架，移植适配 org）：
 *   1. 留一个备用的——看着正在干活的（隔一段时间看一次——正常运行不用管——继续待机）
 *   2. 死机了 → 尝试修复 → 再分一个备用看着（监督者自身也要有人看）
 *   3. 通知分流：管理员/监督者处理失败的才通知用户（用户不接日常失败/重启通知）
 *
 * 双层看护架构：
 *   L0 系统级：pi-org-watchdog（schtasks 10min，已有）——butler 进程死 → bootstrap 重启
 *   L1 本脚本（默认模式，schtasks 每 6min）——看管家 butler：进程死/日志停滞 → 死因快照 → bootstrap start
 *      修复成功 → 再分一个备用（检查 L2 心跳，过期则补拉起）；修复失败/反复失败 → 通知用户
 *   L2 本脚本 --l2 模式（schtasks 每 6min 错开 3min）——看 L1 心跳：L1 死/卡死 → 拉起 L1 一轮 + 接管管家检查
 *
 * 心跳：
 *   - 管家心跳 = logs/butler.log mtime（butler 每 15~60s 写一次，实测最大间隔 137s；>10min 判死/卡死，
 *     与 twin-daemon.js 判据一致）
 *   - L1 心跳 = logs/supervisor-l1.heartbeat（每轮写 pid+ts）
 *   - L2 心跳 = logs/supervisor-l2.heartbeat
 *
 * 通知分流：
 *   - 日常修复成功 → 只写 logs/supervisor.log + 修复事件文件，不通知用户（用户无感）
 *   - 修复失败 / 30min 内反复失败（≥3 次）/ 监督者连续故障 → hk-alert.js --supervisor → APP 通知
 *
 * 用法：
 *   node scripts/backup-supervisor.js            # L1 跑一轮（看管家）
 *   node scripts/backup-supervisor.js --l2       # L2 跑一轮（看 L1）
 *   node scripts/backup-supervisor.js --check    # 只读检查一轮（不修复不通知），用于验证
 *   node scripts/backup-supervisor.js --status   # 打印心跳/状态
 *   node scripts/backup-supervisor.js --root <dir>   # 指定 org 根（沙箱测试用）
 *
 * 配置：config/backup-supervisor.json（改即生效，每轮重读）
 */
'use strict';
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLI = process.argv.slice(2);
const ARG_ROOT = (() => { const i = CLI.indexOf('--root'); return i >= 0 ? CLI[i + 1] : null; })();
const ORG_ROOT = ARG_ROOT ? path.resolve(ARG_ROOT) : path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ORG_ROOT, 'config', 'backup-supervisor.json');
const LOGS = path.join(ORG_ROOT, 'logs');
const LOG_FILE = path.join(LOGS, 'supervisor.log');
const HB_L1 = path.join(LOGS, 'supervisor-l1.heartbeat');
const HB_L2 = path.join(LOGS, 'supervisor-l2.heartbeat');
const FIX_STATE = path.join(LOGS, 'supervisor-fix-state.json');
const FIX_EVENTS = path.join(LOGS, 'supervisor-fix-events.jsonl');

const BUTLER_PID = path.join(ORG_ROOT, 'butler.pid');
const BUTLER_LOG = path.join(LOGS, 'butler.log');
const BOOTSTRAP = path.join(ORG_ROOT, 'scripts', 'bootstrap.js');

/* ── 配置（每轮重读，改即生效） ─────────────────────── */
function loadConfig() {
  const def = {
    enabled: true,
    logStaleMin: 10,          // butler.log 超过 N 分钟未更新 = 死/卡死（与 twin-daemon 一致）
    l1StaleMin: 15,           // L1 心跳超过 N 分钟 = L1 死（错过 ≥2 轮）
    l2StaleMin: 15,           // L2 心跳超过 N 分钟 = L2 死
    fixMaxPerWindow: 3,       // 窗口内最大修复次数，超过 → 通知用户并停止本轮
    fixWindowMin: 30,         // 防反复窗口（分钟）
    fixRetry: 2,              // 单轮修复尝试次数（bootstrap start 后复查）
    notifyUser: true,         // 处理失败是否通知用户（APP 通知）
    checkL2: true,            // L1 修复成功后是否再分备用（检查/拉起 L2）
  };
  try { return { ...def, ...(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}) }; }
  catch (e) { return def; }
}

/* ── 工具 ─────────────────────────────────────────── */
function log(...a) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] [backup-supervisor] ${a.join(' ')}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) {}
}
const readIf = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const mtimeMs = p => { try { return fs.statSync(p).mtimeMs; } catch (e) { return 0; } };
const ensure = d => { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} };
const alive = pid => {
  if (!pid || Number.isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const readPid = file => {
  const s = (readIf(file) || '').trim();
  const pid = parseInt(s, 10);
  return Number.isNaN(pid) ? null : pid;
};
function heartbeatWrite(file, role) {
  ensure(LOGS);
  const payload = { role, pid: process.pid, ts: Date.now(), iso: new Date().toISOString() };
  try { fs.writeFileSync(file, JSON.stringify(payload), 'utf8'); } catch (e) {}
}
function heartbeatAgeMin(file) {
  const ms = mtimeMs(file);
  if (!ms) return -1; // 文件不存在
  return (Date.now() - ms) / 60000;
}
function writeFixState(state) {
  try { fs.writeFileSync(FIX_STATE, JSON.stringify(state), 'utf8'); } catch (e) {}
}
function readFixState() {
  try { return JSON.parse(readIf(FIX_STATE)) || { fixes: [], lastNotifyAt: 0 }; }
  catch (e) { return { fixes: [], lastNotifyAt: 0 }; }
}
function appendFixEvent(ev) {
  ensure(LOGS);
  try { fs.appendFileSync(FIX_EVENTS, JSON.stringify({ ts: Date.now(), iso: new Date().toISOString(), ...ev }) + '\n', 'utf8'); } catch (e) {}
}

/* ── 管家检测 ─────────────────────────────────────── */
function checkButler(cfg) {
  const pid = readPid(BUTLER_PID);
  const pidAlive = pid && alive(pid);
  const logAge = heartbeatAgeMin(BUTLER_LOG);
  const stale = logAge >= 0 && logAge > cfg.logStaleMin;
  let reason = null;
  if (!pidAlive) reason = pid ? `进程死亡（原 PID=${pid}）` : 'PID 文件缺失或为空';
  else if (stale) reason = `疑似卡死（butler.log ${logAge.toFixed(0)} 分钟未更新）`;
  return { pid, pidAlive, logAge, stale, reason };
}

/* ── 死因快照（复用 twin-daemon 模式） ─────────────── */
function crashSnapshot(reason) {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, '');
  const crashPath = path.join(LOGS, `supervisor-crash-${ts}.log`);
  try {
    const tail = (readIf(BUTLER_LOG) || '').split(/\r?\n/).slice(-20).join('\n');
    fs.writeFileSync(crashPath,
      `# butler crash snapshot @ ${new Date().toISOString()}\n# 触发原因: ${reason}\n# 尾部 20 行:\n${tail}\n`, 'utf8');
    return crashPath;
  } catch (e) { return null; }
}

/* ── 修复管家（bootstrap start 幂等 + 复查 + 尝试 N 次） ── */
function runBootstrapStart() {
  return new Promise(resolve => {
    if (!fs.existsSync(BOOTSTRAP)) return resolve({ ok: false, err: 'bootstrap.js 不存在: ' + BOOTSTRAP });
    execFile(process.execPath, [BOOTSTRAP, 'start'], { cwd: ORG_ROOT, windowsHide: true, timeout: 60000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '').trim().slice(-200), err: String(stderr || '').trim().slice(-200) }));
  });
}
async function fixButler(cfg, reason) {
  const snap = crashSnapshot(reason);
  log(`🔧 修复管家: ${reason} | 快照 ${snap || '(写入失败)'}`);
  const maxTry = Math.max(1, cfg.fixRetry || 2);
  for (let i = 1; i <= maxTry; i++) {
    const r = await runBootstrapStart();
    log(`   尝试 ${i}/${maxTry}: bootstrap start ${r.ok ? 'OK' : '失败 ' + (r.err || '')}`);
    await new Promise(res => setTimeout(res, 30 * 1000)); // 等 30s 复查
    const after = checkButler(cfg);
    if (!after.reason) return { ok: true, tryCount: i, pid: after.pid, snap };
  }
  const after = checkButler(cfg);
  return { ok: false, tryCount: maxTry, reason: after.reason, snap };
}

/* ── 通知用户（处理失败才通知——通知分流） ───────────── */
function notifyUser(title, msg) {
  const script = path.join(ORG_ROOT, 'scripts', 'hk-alert.js');
  if (!fs.existsSync(script)) { log('⚠ 通知通道缺失: ' + script); return; }
  spawn(process.execPath, [script, '--supervisor', String(title).slice(0, 60), String(msg).slice(0, 180)], {
    cwd: ORG_ROOT, stdio: 'ignore', windowsHide: true, detached: true,
  }).unref();
  log(`📣 通知用户: ${title}`);
}

/* ── 再分一个备用（L1 修复成功后检查 L2） ───────────── */
function spawnSelf(args) {
  // 透传 --root（沙箱测试隔离：子进程也用同一 org 根；绝对路径防 cwd 错位）
  const full = ARG_ROOT ? ['--root', ORG_ROOT, ...args] : args;
  return spawn(process.execPath, [__filename, ...full], { cwd: path.dirname(__filename), stdio: 'ignore', windowsHide: true, detached: true }).unref();
}
function ensureL2(cfg, reason) {
  if (!cfg.checkL2) return;
  const age = heartbeatAgeMin(HB_L2);
  if (age >= 0 && age <= cfg.l2StaleMin) { log(`   ✅ 备用在场（L2 心跳 ${age.toFixed(0)}min）`); return; }
  log(`   🔄 再分一个备用: L2 心跳 ${age < 0 ? '缺失' : age.toFixed(0) + 'min 过期'} → 补拉起 L2 一轮`);
  spawnSelf(['--l2']);
  appendFixEvent({ kind: 'respwan-l2', reason });
}

/* ── L1：看管家 ───────────────────────────────────── */
async function runL1() {
  const cfg = loadConfig();
  heartbeatWrite(HB_L1, 'l1');
  if (!cfg.enabled) { log('L1 跳过（enabled=false）'); return; }

  const butler = checkButler(cfg);
  if (!butler.reason) {
    // 正常：看 L2 心跳是否新鲜（备用失联要补）
    const l2Age = heartbeatAgeMin(HB_L2);
    if (cfg.checkL2 && l2Age > cfg.l2StaleMin) {
      log(`L2 心跳 ${l2Age < 0 ? '缺失' : l2Age.toFixed(0) + 'min'} → 补拉起备用`);
      ensureL2(cfg, 'L2 心跳过期（管家正常巡检）');
    }
    log(`✅ 管家正常（PID=${butler.pid || '?'}，日志 ${butler.logAge < 0 ? '?' : butler.logAge.toFixed(0) + 'min'}）— 待机`);
    return;
  }

  // 管家异常 → 尝试修复
  const state = readFixState();
  const now = Date.now();
  state.fixes = (state.fixes || []).filter(t => now - t < cfg.fixWindowMin * 60000);
  if (state.fixes.length >= cfg.fixMaxPerWindow) {
    // 防反复：窗口内已修满 → 通知用户 + 停止本轮
    log(`🚨 管家 ${cfg.fixWindowMin}min 内反复异常（${state.fixes.length} 次）→ 停止自动修复，通知用户`);
    appendFixEvent({ kind: 'exhausted', reason: butler.reason, fixes: state.fixes.length });
    if (cfg.notifyUser && now - (state.lastNotifyAt || 0) > 30 * 60 * 1000) {
      notifyUser('管家反复故障，自动修复已停止',
        `butler ${cfg.fixWindowMin}min 内故障 ${state.fixes.length} 次（${butler.reason}），需人工介入`);
      state.lastNotifyAt = now;
      writeFixState(state);
    }
    return;
  }

  const fix = await fixButler(cfg, butler.reason);
  if (fix.ok) {
    state.fixes.push(now);
    writeFixState(state);
    appendFixEvent({ kind: 'fixed', reason: butler.reason, tryCount: fix.tryCount, newPid: fix.pid });
    log(`✅ 管家修复成功（尝试 ${fix.tryCount} 次，新 PID=${fix.pid}）— 用户无感`);
    ensureL2(cfg, '管家修复完成，再分备用');
  } else {
    state.fixes.push(now);
    writeFixState(state);
    appendFixEvent({ kind: 'fix-failed', reason: fix.reason, tryCount: fix.tryCount });
    log(`🚨 管家修复失败（${fix.tryCount} 次尝试后仍: ${fix.reason}）`);
    if (cfg.notifyUser && now - (state.lastNotifyAt || 0) > 30 * 60 * 1000) {
      notifyUser('管家修复失败，需人工介入', `butler ${fix.reason}，已尝试 ${fix.tryCount} 次`);
      state.lastNotifyAt = now;
      writeFixState(state);
    }
  }
}

/* ── L2：看 L1（监督者的监督者——第二层接管） ────────── */
async function runL2() {
  const cfg = loadConfig();
  heartbeatWrite(HB_L2, 'l2');
  if (!cfg.enabled) { log('L2 跳过（enabled=false）'); return; }

  const l1Age = heartbeatAgeMin(HB_L1);
  if (l1Age >= 0 && l1Age <= cfg.l1StaleMin) {
    log(`✅ L1 监督者正常（心跳 ${l1Age.toFixed(0)}min）— 待机`);
    return;
  }

  log(`🚨 L1 监督者失联（心跳 ${l1Age < 0 ? '缺失' : l1Age.toFixed(0) + 'min 过期'}）→ 第二层接管`);
  appendFixEvent({ kind: 'l1-dead', l1Age });

  // 1. 尝试修复 L1：补拉起一轮 L1（bootstrap 无关，直接 spawn 本脚本）
  spawnSelf([]);
  log('   🔄 已补拉起 L1 一轮');

  // 2. 接管管家检查（L1 死前可能没修完）
  const butler = checkButler(cfg);
  if (butler.reason) {
    log(`   ⛑ 接管管家检查: ${butler.reason} → 尝试修复`);
    const fix = await fixButler(cfg, butler.reason + '（L2 接管）');
    appendFixEvent({ kind: fix.ok ? 'l2-fixed' : 'l2-fix-failed', reason: butler.reason });
    if (fix.ok) {
      log(`   ✅ 接管修复成功（新 PID=${fix.pid}）`);
      ensureL2(cfg, 'L2 接管修复完成'); // 再分备用（L2 自己活着则跳过）
    } else if (cfg.notifyUser) {
      log('   🚨 接管修复失败 → 通知用户');
      notifyUser('管家修复失败（L2 接管）', `butler ${fix.reason}`);
    }
  } else {
    log(`   ✅ 管家正常（PID=${butler.pid}）— 无需接管修复`);
  }
}

/* ── 只读检查 / 状态 ──────────────────────────────── */
function runCheck() {
  const cfg = loadConfig();
  const butler = checkButler(cfg);
  const l1Age = heartbeatAgeMin(HB_L1);
  const l2Age = heartbeatAgeMin(HB_L2);
  const out = {
    butler: { pid: butler.pid, alive: butler.pidAlive, logAgeMin: butler.logAge, health: butler.reason ? '异常: ' + butler.reason : '正常' },
    l1: { heartbeatAgeMin: l1Age, health: l1Age >= 0 && l1Age <= cfg.l1StaleMin ? '正常' : '异常/缺失' },
    l2: { heartbeatAgeMin: l2Age, health: l2Age >= 0 && l2Age <= cfg.l2StaleMin ? '正常' : '异常/缺失' },
    config: cfg,
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

/* ── main ─────────────────────────────────────────── */
(async () => {
  ensure(LOGS);
  if (CLI.includes('--check')) { runCheck(); return; }
  if (CLI.includes('--status')) {
    const s = runCheck();
    log(`--status: butler=${s.butler.health} l1=${s.l1.health} l2=${s.l2.health}`);
    return;
  }
  const t0 = Date.now();
  try {
    if (CLI.includes('--l2')) await runL2();
    else await runL1();
  } catch (e) {
    log('⚠ 监督轮异常: ' + e.message);
    try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [backup-supervisor] FATAL ${e.stack || e}\n`, 'utf8'); } catch (err) {}
  }
  process.exit(0);
})();
