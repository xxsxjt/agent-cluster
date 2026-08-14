#!/usr/bin/env node
/**
 * lib/fullscan-guard.js — 全盘 find/grep 检测看护（2026-08-11 fullscan-guard）
 *
 * 背景（用户 2026-08-11 17:55 电脑卡死——第二次）：
 *   智能体任务执行 `find / -name xxx`（全盘扫描）→ 19 个 find/grep 进程卡死机器。
 *   第一次：reviewer 验收全盘 find（已加效率约束但没机制检测）
 *   第二次：hk-tailscale-restore 找 tailscaled.log 用 `find /`
 *   口头规则挡不住，必须机制检测。本模块即该机制。
 *
 * 职责（butler 主循环每 checkIntervalMin=2 分钟调一次 scan()）：
 *   1. 检测：枚举 find.exe/grep.exe 进程命令行，匹配全盘特征
 *      - find / （根目录）、find C:/、grep -r /、grep -r C:/、-name xxx 但路径是 /
 *      - 以及：find/grep 进程数量异常（> maxSimultaneous=5 个同时）
 *   2. 处理：taskkill /F 杀进程 + 记 activity（"[防卡死] 任务 X 全盘 find 已杀——禁止全盘扫描"）
 *      + 若父任务仍在 → 写一次提示到任务日志（logs/<task>.log，任务回合内可见）
 *   3. 白名单：明确的受限目录扫描（/data/terraria 等）不拦——只拦 / 根/全盘
 *      （实现上：只拦"独立 token"等于 /、盘根 C:/、/c 等；/data/terraria 是多级路径，不匹配）
 *   4. 轻量：每 2 分钟一次 Get-CimInstance 快照，不常驻
 *
 * 配置：org/config/fullscan-guard.json（改即生效，每次 scan 重读）
 * 状态：org/logs/fullscan-guard-guard.log（自身日志，避开与任务名 fullscan-guard 撞名）+ agents/twin/activity.log（分身可见）
 *
 * 用法：
 *   node lib/fullscan-guard.js check                  # 跑一轮扫描（butler 每 2 分钟调）
 *   node lib/fullscan-guard.js --cfg <path> check     # 指定配置（测试）
 *   node lib/fullscan-guard.js --status               # 当前状态 + 跑一轮
 *   node lib/fullscan-guard.js self-test              # 内置自检（模式识别 + 白名单 + 集成）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ORG_ROOT   = path.join(__dirname, '..');
const CONFIG     = path.join(ORG_ROOT, 'config', 'fullscan-guard.json');
const LOGS       = path.join(ORG_ROOT, 'logs');
// 2026-08-11 修：log 名避开 'fullscan-guard'（否则与名为 fullscan-guard 的但丁任务会话日志撞名污染）。
//   详见 task-watchdog.js 的撞名教训注释——任务日志与模块日志必须用不同名。
const GUARD_LOG  = path.join(LOGS, 'fullscan-guard-guard.log');
const ACTIVE_FILE= path.join(LOGS, 'active-tasks.json');

const { logActivity } = require('./twin-log');

/* ── 默认配置（config/fullscan-guard.json 可覆盖，改即生效） ── */
const DEFAULTS = {
  enabled: true,                // 总开关
  checkIntervalMin: 2,          // 扫描间隔（butler 实际调度用；scan 自身幂等）
  maxSimultaneous: 5,           // find/grep 进程数超过此值 → 判定异常（runaway），清杀全部
  processNames: ['find.exe', 'grep.exe', 'rg.exe'],   // 监控的进程名（rg=ripgrep 全盘也会卡死）
  tag: '安全',                  // activity 记录 tag
  hintPrefix: '[防卡死]',       // 写入任务日志的提示前缀
};

/* ── 全盘根 token 正则 ───────────────────────────────
 * 只匹配"独立 token"等于根/盘根，多级路径（/data/terraria）不匹配。
 *   - [a-zA-Z]:[\\\/]      → C:/  C:\       盘根
 *   - \/[a-zA-Z][\\\/]?    → /c  /c/  /d     git bash 盘根
 *   - \/mnt\/[a-zA-Z][\\\/]? → /mnt/c         WSL 盘根
 */
const DRIVE_ROOT_TOKEN = /(?:^|\s)("?)([a-zA-Z]:[\\\/]|\/[a-zA-Z][\\\/]?|\/mnt\/[a-zA-Z][\\\/]?)\1(?=\s|$)/;

const readIf = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const readJsonSafe = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const ensure = d => fs.mkdirSync(d, { recursive: true });
const tsISO  = () => new Date().toISOString();

function loadConfig(cfgPath) {
  try { return Object.assign({}, DEFAULTS, readJsonSafe(cfgPath || CONFIG) || {}); }
  catch (e) { return Object.assign({}, DEFAULTS); }
}
function log(...a) {
  const line = `[${new Date().toLocaleTimeString()}] [fullscan-guard] ${a.join(' ')}`;
  console.log(line);
  try { ensure(LOGS); fs.appendFileSync(GUARD_LOG, line + '\n', 'utf8'); } catch (e) {}
}
function evLog(o) {
  try {
    ensure(LOGS);
    fs.appendFileSync(path.join(LOGS, 'fullscan-guard.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n', 'utf8');
  } catch (e) {}
}

/* ── 进程枚举（Windows PowerShell Get-CimInstance） ── */
function runPowershell(script) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return (out || '').trim();
  } catch (e) { return ''; }
}

/** 枚举 find/grep/rg 进程 → [{pid, ppid, cmd}]（失败返回 []） */
function listFindGrep(cfg) {
  const names = (cfg.processNames || DEFAULTS.processNames)
    .map(n => `Name='${n}'`).join(' or ');
  const out = runPowershell(
    `Get-CimInstance Win32_Process -Filter "${names}" | ` +
    `ForEach-Object { [pscustomobject]@{pid=[int]\$_.ProcessId; ppid=[int]\$_.ParentProcessId; cmd=(\$_.CommandLine -replace '\`"','"')} } | ` +
    `ConvertTo-Json -Compress`
  );
  try {
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : (arr ? [arr] : []);
  } catch (e) { return []; }
}

/** 枚举所有进程的 pid→ppid 映射（用于找父任务） */
function pidMap() {
  const out = runPowershell(
    `Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{pid=[int]\$_.ProcessId; ppid=[int]\$_.ParentProcessId} } | ConvertTo-Json -Compress`
  );
  try {
    const arr = JSON.parse(out);
    const map = {};
    for (const x of Array.isArray(arr) ? arr : [arr]) { if (x && x.pid) map[x.pid] = x.ppid; }
    return map;
  } catch (e) { return {}; }
}

/** 读 butler 活动任务表（pid→taskName 反向） */
function activePidToTask() {
  const d = readJsonSafe(ACTIVE_FILE);
  const m = {};
  if (d && typeof d === 'object') {
    for (const name of Object.keys(d)) {
      const pid = parseInt(d[name].pid, 10);
      if (!Number.isNaN(pid) && pid > 0) m[pid] = { name, agentId: d[name].agentId };
    }
  }
  return m;
}

/** 从被杀的进程 pid 沿父链上溯，找最近的仍在活动的任务 */
function findParentTask(pid, pmap, atmap) {
  let cur = parseInt(pid, 10);
  const seen = {};
  for (let i = 0; i < 40 && cur && !seen[cur]; i++) {
    seen[cur] = true;
    if (atmap[cur]) return atmap[cur];          // 命中活动任务 → 返回
    cur = pmap[cur];                             // 上溯父进程
  }
  return null;
}

/** 是否全盘根 token */
function isFullDiskPath(p) {
  if (p === null || p === undefined) return false;
  p = String(p).trim().replace(/^["']|["']$/g, '');
  if (!p) return false;
  if (p === '/') return true;                            // 根
  if (/^[a-zA-Z]:[\\\/]$/.test(p)) return true;          // C:/  C:\
  if (/^\/[a-zA-Z][\\\/]?$/.test(p)) return true;        // /c  /c/
  if (/^\/mnt\/[a-zA-Z][\\\/]?$/.test(p)) return true;   // /mnt/c
  return false;
}

/** 全局"独立全盘根 token"正则：组1=可选引号，组2=根/盘根。
 * 反向引用 \1 强制引号闭合，天然避开 exe 自身路径 C:\Program... 的误判。 */
const FULL_DISK_TOKEN = /(?:^|\s)("?)(\/|[a-zA-Z]:[\\\/]|\/[a-zA-Z][\\\/]?|\/mnt\/[a-zA-Z][\\\/]?)\1(?=\s|$)/g;

/** 判断一条 find/grep 命令行是否为全盘扫描。返回 {fullDisk, detail, roots} */
function classify(cmd) {
  const c = String(cmd || '');
  if (!c) return { fullDisk: false, detail: '', roots: [] };
  const isFind = /\bfind\b/.test(c);
  const isGrep = /\bgrep\b/.test(c);
  if (!isFind && !isGrep) return { fullDisk: false, detail: '', roots: [] };

  // 1) 提取所有"独立全盘根 token"（/、C:/、C:\、/c、/mnt/c），多级路径不匹配
  const roots = [];
  FULL_DISK_TOKEN.lastIndex = 0;
  let mm;
  while ((mm = FULL_DISK_TOKEN.exec(c)) !== null) {
    const r = mm[2];
    if (isFullDiskPath(r) && !roots.includes(r)) roots.push(r);
  }

  let fullDisk = roots.length > 0;

  if (isFind && !fullDisk) {
    // find 前导路径参数 === /（find / -name）——兜底（若 token 未被全局正则捕获）
    const fm = c.match(/\bfind\b\s+(.*)$/);
    const args = (fm ? fm[1] : '').split(/\s+/).filter(Boolean);
    for (const a of args) {
      const clean = a.replace(/^["']|["']$/g, '');
      if (clean.startsWith('-')) break;              // 选项开始 → 路径结束
      if (clean === '/') { fullDisk = true; roots.push('/'); }
      break;                                          // 只判断第一个路径参数
    }
  }

  return { fullDisk, detail: fullDisk ? `全盘扫描：${roots.join(',')}` : '', roots };
}

/** 杀进程（Windows taskkill /F），返回是否成功 */
function kill(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    return true;
  } catch (e) { return false; }
}

/** 写一次提示到任务日志 logs/<task>.log（任务回合内可见） */
function hintTaskLog(taskName, msg) {
  try {
    ensure(LOGS);
    fs.appendFileSync(path.join(LOGS, `${taskName}.log`), `\n[${new Date().toLocaleString()}] ${msg}\n`, 'utf8');
    return true;
  } catch (e) { return false; }
}

/**
 * 跑一轮全盘扫描看护。
 * @returns {{checked, killed:Array, hint:Array, fullDiskDetected:Array, countTriggered}}
 */
function scan(cfgPath) {
  const cfg = loadConfig(cfgPath);
  const empty = { checked: 0, killed: [], hints: [], fullDiskDetected: [], countTriggered: false };
  if (!cfg.enabled) return empty;

  const procs = listFindGrep(cfg);
  const count = procs.length;
  empty.checked = count;

  // 异常数量触发（> maxSimultaneous）→ 判定 runaway，清杀全部 find/grep
  if (count > (cfg.maxSimultaneous || DEFAULTS.maxSimultaneous)) {
    empty.countTriggered = true;
    log(`🚨 find/grep 进程数异常（${count} 个 > ${cfg.maxSimultaneous}），判定 runaway → 清杀全部`);
    for (const p of procs) { if (kill(p.pid)) empty.killed.push(p.pid); }
    evLog({ event: 'count', count, killed: empty.killed, cmdline: procs.map(p => p.cmd) });
    logActivity('[防卡死] find/grep 进程数异常已清杀', `${count} 个进程（${empty.killed.join(',')}），禁止全盘扫描`, cfg.tag);
    return empty;
  }

  // 逐条检测全盘特征
  const pmap = pidMap();
  const atmap = activePidToTask();
  const killedPids = new Set();
  for (const p of procs) {
    const cls = classify(p.cmd);
    if (!cls.fullDisk) continue;
    if (killedPids.has(p.pid)) continue;
    // 杀
    const ok = kill(p.pid);
    killedPids.add(p.pid);
    if (ok) empty.killed.push(p.pid);
    empty.fullDiskDetected.push({ pid: p.pid, cmd: p.cmd, roots: cls.roots });
    // 找父任务 → 写提示
    const parent = findParentTask(p.pid, pmap, atmap);
    const who = parent ? `${parent.agentId}/${parent.name}` : `PID ${p.pid}`;
    const line = `[${new Date().toLocaleString()}] ${cfg.hintPrefix} ${who} 执行全盘扫描（${cls.roots.join(',')}）已杀——禁止全盘 find/grep（会卡死机器）！请用受限目录或精确路径。`;
    log(`🔪 ${line}`);
    evLog({ event: 'kill', pid: p.pid, cmd: p.cmd, roots: cls.roots, parent: parent ? parent.name : null });
    logActivity('[防卡死] 全盘 find 已杀', `${who} 全盘扫描（${cls.roots.join(',')}）——禁止全盘扫描`, cfg.tag);
    if (parent) { hintTaskLog(parent.name, line); empty.hints.push(parent.name); }
  }

  if (empty.killed.length) log(`本轮全盘看护：杀 ${empty.killed.length} 个（${empty.killed.join(',')}）`);
  else log(`本轮全盘看护：无异常（检查 ${count} 个 find/grep 进程）`);
  return empty;
}

/* ── 内置自检（模式识别 + 白名单 + 父任务定位） ── */
function selfTest() {
  const results = [];
  let pass = 0, fail = 0;
  const checkOne = (ok, label) => { results.push((ok ? '✅' : '❌') + ' ' + label); ok ? pass++ : fail++; };

  // 全盘：应被拦
  checkOne(classify('"C:\\Program Files\\Git\\usr\\bin\\find.exe" / -name tailscaled.log').fullDisk, '识别全盘：find / -name tailscaled.log');
  checkOne(classify('find / -name x').fullDisk, '识别全盘：find / -name x');
  checkOne(classify('find C:/ -name x').fullDisk, '识别全盘：find C:/ -name x');
  checkOne(classify('find C:\\ -name x').fullDisk, '识别全盘：find C:\\ -name x');
  checkOne(classify('grep -r "foo" /').fullDisk, '识别全盘：grep -r foo /（末token=/）');
  checkOne(classify('grep -r / pattern').fullDisk, '识别全盘：grep -r / pattern（-r后紧跟/）');
  checkOne(classify('grep -r foo C:/').fullDisk, '识别全盘：grep -r foo C:/');

  // 白名单/正常：不应拦
  checkOne(!classify('find /data/terraria -name x').fullDisk, '白名单不拦：find /data/terraria -name x');
  checkOne(!classify('find /data -name x').fullDisk, '白名单不拦：find /data -name x');
  checkOne(!classify('grep -rn "TODO" src/').fullDisk, '正常不拦：grep -rn "TODO" src/');
  checkOne(!classify('grep -r "user/home" dir/').fullDisk, '正常不拦：grep -r "user/home" dir/（非全盘）');
  checkOne(!classify('grep -rn InfoSearch xxsx-proxy-gateway-chat-assistant/').fullDisk, '正常不拦：项目内 grep');
  checkOne(!classify('find . -name "*.log"').fullDisk, '正常不拦：find . -name（当前目录）');
  checkOne(!classify('find ./src -name x').fullDisk, '正常不拦：find ./src -name x');

  // 路径判定
  checkOne(isFullDiskPath('/'), '路径判定：/ 是全盘根');
  checkOne(isFullDiskPath('C:/'), '路径判定：C:/ 是全盘根');
  checkOne(isFullDiskPath('/c/'), '路径判定：/c/ 是全盘根');
  checkOne(!isFullDiskPath('/data/terraria'), '路径判定：/data/terraria 非全盘根');

  console.log('\n=== fullscan-guard 内置自检 ===');
  results.forEach(r => console.log('  ' + r));
  console.log(`结果: ${pass}/${pass + fail} 通过${fail ? '（有失败）' : ''}`);
  process.exit(fail ? 1 : 0);
}

/* ── CLI ── */
function main() {
  const argv = process.argv.slice(2);
  let cfgPath = null;
  const i = argv.indexOf('--cfg');
  if (i >= 0 && argv[i + 1]) { cfgPath = argv[i + 1]; argv.splice(i, 2); }
  if (argv.includes('self-test')) return selfTest();
  if (argv.includes('--status')) {
    const cfg = loadConfig(cfgPath);
    const res = scan(cfgPath);
    console.log('=== 全盘扫描看护状态 ===');
    console.log(JSON.stringify({ enabled: cfg.enabled, checkIntervalMin: cfg.checkIntervalMin, maxSimultaneous: cfg.maxSimultaneous, result: res }, null, 2));
    return;
  }
  const res = scan(cfgPath);
  console.log('fullscan-guard scan 完成 → ' +
    (res.killed.length ? `杀 ${res.killed.length} 个全盘进程（${res.killed.join(',')}）` + (res.hints.length ? `；提示任务 ${res.hints.join('、')}` : '') : '（本轮无异常）'));
  process.exit(0);
}

if (require.main === module) main();

module.exports = { scan, classify, isFullDiskPath, loadConfig, DEFAULTS, kill, findParentTask };
