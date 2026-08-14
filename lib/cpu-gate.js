/**
 * lib/cpu-gate.js — CPU 负载门禁（CPU Guardian × 集群框架联动）
 *
 * 背景（用户 2026-08-11 10:5x）：CPU Guardian（D:\dx\workspace\cpu_guardian\cpu_guardian.py）已在跑，
 *   监控本机 CPU 负载/温度。本模块把"本机 CPU 占用过高"接入任务派发：
 *   - 构建类任务（header 声明 `load-sensitive: true` 或内容命中构建关键词）→ high 时暂缓 / critical 时强制暂缓
 *   - 暂缓超阈值（默认 30 分钟）且任务可在 CNB 云环境跑 → 转 CNB（分担本机构建负载）
 *   - 普通（非构建）任务不受门禁影响（轻量，高负载也照跑）
 *   - 温度 > 90°C 视为 critical（高温保护，读 guardian_state.json 的 temp 字段）
 *
 * 负载来源：
 *   1. 首选 CPU Guardian 状态文件 guardian_state.json（{state, temp, load, last_check}，本机已在跑，最准）
 *   2. 兜底 psutil（python 一行，state 文件缺失/过期时）
 *
 * 用法（butler 集成）：
 *   const cpuGate = require('./lib/cpu-gate');
 *   const ev = cpuGate.evaluate(task);      // {action:'dispatch'|'defer'|'escalate', ...}
 *   if (ev.action !== 'dispatch') { log(`[负载门禁] ${ev.reason}`); continue; }  // 暂缓/转CNB
 *
 * 设计要点（不误伤）：
 *   - 只有构建类任务受门禁；AI 对话/轻量任务照常派发
 *   - 暂缓任务留原 inbox/<name>.md（不删），每个轮询周期重评估：负载降了自动派发（无需等 5 分钟）
 *   - 暂缓日志节流（默认每 5 分钟报一次"为什么没跑"），避免每 15s 刷屏
 *   - 暂缓超阈值 → escalate（转 CNB），幂等（只转一次）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pickSide, CNB_MARKERS, WINDOWS_MARKERS } = require('./route-auto');

const ORG_ROOT = path.resolve(__dirname, '..');
const LOGS     = path.join(ORG_ROOT, 'logs');
const CONFIG   = path.join(ORG_ROOT, 'config', 'cpu-gate.json');
const PENDING  = path.join(LOGS, 'cpu-gate-pending.json');
const EVLOG    = path.join(LOGS, 'cpu-gate.jsonl');

/* ── 默认配置（config/cpu-gate.json 可覆盖，改即生效） ───── */
const DEFAULTS = {
  enabled: true,               // 总开关
  highThreshold: 70,           // load >= 70 → high
  criticalThreshold: 90,       // load >= 90 → critical
  tempCriticalC: 90,           // temp > 90°C → critical（高温保护）
  lowThreshold: 40,            // load < 40 → low（信息用）
  deferEscalateMin: 30,        // 暂缓超 30 分钟 → 转 CNB
  logThrottleMs: 5 * 60 * 1000, // 暂缓日志节流（每 5 分钟报一次）
  guardianStatePath: 'D:/dx/workspace/cpu_guardian/guardian_state.json',
  stateStaleMs: 3 * 60 * 1000, // guardian state 超 3 分钟视为过期 → 走 psutil
  psutilCmd: 'python',         // 兜底负载查询命令
};

/* ── 构建类任务判定（header load-sensitive:true 或内容命中构建关键词） ── */
const BUILD_MARKERS = [
  'gradle', 'gradlew', 'maven', 'mvn ', 'npm run build', 'npm build', 'npm run', 'yarn build', 'yarn run',
  'webpack build', 'vite build', 'compile', '编译', '编 译',
  'android', 'apk', 'sdk', 'make build', 'go build', 'tsc', 'tsc -b', 'java', 'jar',
  'msbuild', 'msvc', 'visual studio', '.csproj', 'dotnet', 'nuget',
  '打包', '构建', 'build', 'gradle构建', 'maven构建', 'compose build'
];

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    return Object.assign({}, DEFAULTS, c || {});
  } catch (e) { return Object.assign({}, DEFAULTS); }
}

function readPending() {
  try { return JSON.parse(fs.readFileSync(PENDING, 'utf8')) || {}; }
  catch (e) { return {}; }
}
function writePending(p) {
  try { fs.mkdirSync(LOGS, { recursive: true }); fs.writeFileSync(PENDING, JSON.stringify(p, null, 2), 'utf8'); }
  catch (e) {}
}
function evLog(o) {
  try {
    fs.mkdirSync(LOGS, { recursive: true });
    fs.appendFileSync(EVLOG, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n', 'utf8');
  } catch (e) {}
}

/** 读 CPU 占用：优先 guardian_state.json，兜底 psutil */
function readCpu() {
  const cfg = loadConfig();
  // 1) guardian_state.json（本机已在跑）
  try {
    const raw = fs.readFileSync(cfg.guardianStatePath, 'utf8');
    const st = JSON.parse(raw);
    if (st && typeof st.load === 'number') {
      const age = Date.now() - new Date((st.last_check || '').replace(' ', 'T')).getTime();
      if (!isNaN(age) && age <= cfg.stateStaleMs) {
        return { load: st.load, temp: typeof st.temp === 'number' ? st.temp : null, src: 'guardian' };
      }
    }
  } catch (e) { /* 无 state 文件或过期，走兜底 */ }
  // 2) psutil 兜底
  try {
    const out = execFileSync(cfg.psutilCmd, ['-c',
      'import psutil,sys;print(psutil.cpu_percent(interval=0.3))'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const load = parseFloat((out || '').trim());
    if (!isNaN(load)) return { load, temp: null, src: 'psutil' };
  } catch (e) { /* psutil 不可用 */ }
  return { load: 0, temp: null, src: 'unknown' };
}

/** 由 load/temp 定级 */
function levelFrom(load, temp, cfg) {
  if (typeof temp === 'number' && temp > cfg.tempCriticalC) return 'critical';
  if (load >= cfg.criticalThreshold) return 'critical';
  if (load >= cfg.highThreshold) return 'high';
  if (load >= cfg.lowThreshold) return 'normal';
  return 'low';
}

/** 判断是否为构建类任务（受门禁） */
function isBuildTask(task) {
  if (!task) return false;
  if (task.loadSensitive) return true;   // header 显式声明 load-sensitive: true
  const text = String(task.content || task.name || '').toLowerCase();
  return BUILD_MARKERS.some(m => text.includes(m));
}

/** 判断任务可否转 CNB（跨平台构建；Windows 专属构建 CNB/HK 跑不了） */
function canEscalateToCnb(task) {
  if (!task) return false;
  if (task.target && task.target !== 'cnb') return false;   // 显式指定了其他侧 → 不抢
  const side = pickSide(task);
  if (side === 'cnb') return true;
  // pickSide 返回 hk（服务器/重活标记）或 local：仅当命中 CNB 且未命中 Windows 专属 → 可转
  const text = String(task.content || task.name || '').toLowerCase();
  const hasCnb = CNB_MARKERS.some(m => text.includes(m));
  const hasWin = WINDOWS_MARKERS.some(m => text.includes(m));
  return hasCnb && !hasWin;
}

/**
 * 对任务做负载门禁评估。
 * @param {object} task 解析后的任务（{name, content, loadSensitive, target, ...}）
 * @returns {{action:'dispatch'|'defer'|'escalate', level, load, temp, reason, toCnb?, deferredSec?}}
 *   - 'dispatch'：放行（非构建 或 负载正常）
 *   - 'defer'   ：暂缓（构建 + high/critical；日志节流）
 *   - 'escalate'：转 CNB（构建暂缓超阈值 且 可跨平台）
 */
function evaluate(task) {
  const cfg = loadConfig();
  const dflt = { action: 'dispatch', level: 'low', load: 0, temp: null, reason: '负载正常' };
  if (!cfg.enabled) return dflt;
  if (!task || !task.name) return dflt;

  const cpu = readCpu();
  const level = levelFrom(cpu.load, cpu.temp, cfg);
  const now = Date.now();
  const p = readPending();
  const name = task.name;

  // 非构建任务：不受门禁（高负载也照跑）。若曾在 pending（critical 转CNB）→ 清理
  if (!isBuildTask(task)) {
    if (p[name]) { delete p[name]; writePending(p); }
    return { action: 'dispatch', level, load: cpu.load, temp: cpu.temp, reason: '非构建任务，不受门禁' };
  }

  // 负载正常 → 放行；清理 pending 记录
  if (level !== 'high' && level !== 'critical') {
    if (p[name]) { delete p[name]; writePending(p); }
    return { action: 'dispatch', level, load: cpu.load, temp: cpu.temp, reason: `负载 ${cpu.load}%(${level})，放行构建任务` };
  }

  // 命中门禁（high/critical）
  const nowEntry = p[name] || { deferredAt: now, firstDeferredAt: now, lastLog: 0, escalated: false, loadAtDefer: cpu.load };
  nowEntry.loadAtDefer = cpu.load;
  p[name] = nowEntry;
  writePending(p);
  const deferredSec = Math.round((now - nowEntry.firstDeferredAt) / 1000);

  // 暂缓超阈值 + 可转 CNB + 未转过 → 转 CNB
  if (deferredSec >= cfg.deferEscalateMin * 60 && canEscalateToCnb(task) && !nowEntry.escalated) {
    nowEntry.escalated = true;
    nowEntry.escalatedAt = now;
    writePending(p);
    evLog({ event: 'escalate', task: name, load: cpu.load, level, temp: cpu.temp, deferredSec });
    return { action: 'escalate', level, load: cpu.load, temp: cpu.temp, toCnb: true, deferredSec,
      reason: `CPU ${cpu.load}%(${level}) 暂缓超 ${cfg.deferEscalateMin} 分钟，转 CNB 云环境` };
  }

  // 普通暂缓（日志节流：每 logThrottleMs 报一次，避免刷屏）
  const needLog = now - nowEntry.lastLog >= cfg.logThrottleMs;
  if (needLog) { nowEntry.lastLog = now; writePending(p); }
  const reason = `CPU ${cpu.load}%(${level})${cpu.temp != null ? ` / 温度${cpu.temp}°C` : ''} 暂缓构建任务（已暂缓 ${Math.floor(deferredSec / 60)} 分钟${canEscalateToCnb(task) ? `，超 ${cfg.deferEscalateMin} 分钟转 CNB` : '，本任务不可转 CNB（Windows 专属）'}）`;
  if (needLog) evLog({ event: 'defer', task: name, load: cpu.load, level, temp: cpu.temp, deferredSec });
  return { action: 'defer', level, load: cpu.load, temp: cpu.temp, deferredSec, reason };
}

/** 手动强制评估（测试/运维用）：返回当前等级字符串 */
function status() {
  const cfg = loadConfig();
  const cpu = readCpu();
  const level = levelFrom(cpu.load, cpu.temp, cfg);
  const p = readPending();
  return {
    enabled: cfg.enabled,
    level, load: cpu.load, temp: cpu.temp, src: cpu.src,
    thresholds: { high: cfg.highThreshold, critical: cfg.criticalThreshold, tempCritical: cfg.tempCriticalC },
    pending: Object.keys(p).map(k => ({ task: k, ...p[k] })),
  };
}

module.exports = { getLoad: readCpu, levelFrom, isBuildTask, canEscalateToCnb, evaluate, status, DEFAULTS };
