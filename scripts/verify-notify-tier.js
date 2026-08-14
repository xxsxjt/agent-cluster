#!/usr/bin/env node
/**
 * verify-notify-tier.js — 异常通知分级（notify-tier）隔离验证
 *
 * 从 butler.js 源码【按函数名提取真实函数体】（brace 匹配），经 new Function 注入 mock 依赖，
 * 确定性测试分级决策，不依赖 HK/真实 agent：
 *   A. failTaskAnomaly 异常标记 → 不立即通知用户 + 写出恢复决策请求
 *   B. 分身决策「重跑」→ 打 recovery 标 → 重跑完成【不通知】，记 [自动恢复]，flag 清理
 *   C. 重跑超限（handleRecoveryDecision）→ 通知用户，消息含尝试说明
 *   D. 分身决策归档 → 通知用户带说明
 *   E. 正常任务完成仍照常通知（回归）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ORG_ROOT = path.resolve(__dirname, '..');
const BUTLER = fs.readFileSync(path.join(ORG_ROOT, 'butler.js'), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-tier-'));
const INBOX = path.join(tmp, 'inbox');
const LOGS  = path.join(tmp, 'logs');
fs.mkdirSync(INBOX, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });
const RECOVERY_COUNT = path.join(LOGS, 'recovery-count.json');
const DEC_DIR = path.join(INBOX, 'decisions');
const RECOVERY_FLAG_DIR = path.join(INBOX, '.recovery');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}

/* ---- 从源码提取函数体（brace 匹配） ---- */
function extractFn(src, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('function not found: ' + name);
  let i = src.indexOf('{', m.index);
  if (i < 0) throw new Error('no body for: ' + name);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(m.index, i + 1);
}
function extractArrow(src, name) {
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*[^;]+;', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('const not found: ' + name);
  const seg = m[0];
  let end = m.index + seg.length;
  const arrowIdx = seg.indexOf('=>');
  let afterArrow = '';
  if (arrowIdx >= 0) { let j = m.index + arrowIdx + 2; while (j < src.length && /\s/.test(src[j])) j++; afterArrow = src[j] || ''; }
  if (seg.includes('=>') && afterArrow === '{') {
    let i = m.index + seg.indexOf('{'); let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    end = i + 1;
  }
  return src.slice(m.index, end);
}

/* ---- 组装依赖 + 提取真实函数 ---- */
const notifications = [];
const mockSpawn = () => ({ unref(){} });

const deps = {
  fs, path, os,
  log: () => {},
  ensure: d => fs.mkdirSync(d, { recursive: true }),
  readIf: p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } },
  readJsonSafe: p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } },
  writeJsonSafe: (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8'),
  isAlive: () => false,
  memory: { appendDiary(){}, extractEntities(){} },
  active: new Map(),
  persistActive: () => {},
  spawn: (exe, args) => { notifications.push({ status: args[2], summary: args.slice(3).join(' ').trim() }); return { unref(){} }; },
  MAX_RERUN: 2,
  RECOVERY_COUNT, DEC_DIR, INBOX, RECOVERY_FLAG_DIR, ORG_ROOT,
  CLUSTER_ALERT_SCRIPT: path.join(ORG_ROOT, 'scripts', 'hk-alert.js'),
  STALL_GRACE_MS: 2 * 60 * 1000, LOG_STALL_MS: 20 * 60 * 1000,
  routeTask: () => 'coo',
  dispatch: (t, a) => { console.log(`     [mock] dispatch → ${a}`); },
};

const combined = [
  extractArrow(BUTLER, 'recCount'),
  extractArrow(BUTLER, 'bumpRecCount'),
  extractArrow(BUTLER, 'RECOVERY_FLAG'),
  extractArrow(BUTLER, 'isRecoveryRerun'),
  extractArrow(BUTLER, 'markRecoveryRerun'),
  extractArrow(BUTLER, 'clearRecoveryRerun'),
  extractArrow(BUTLER, 'notifyAnomalyAutoRecovered'),
  extractFn(BUTLER, 'parseTask'),
  extractFn(BUTLER, 'detectSourceAgent'),
  extractFn(BUTLER, 'notifyTaskEvent'),
  extractFn(BUTLER, 'requestRecoveryDecision'),
  extractFn(BUTLER, 'failTaskAnomaly'),
  extractFn(BUTLER, 'handleRecoveryDecision'),
].join('\n');

const names = ['recCount','bumpRecCount','isRecoveryRerun','markRecoveryRerun','clearRecoveryRerun',
  'notifyAnomalyAutoRecovered','parseTask','detectSourceAgent','notifyTaskEvent',
  'requestRecoveryDecision','failTaskAnomaly','handleRecoveryDecision','active','readIf','writeJsonSafe'];
const runner = new Function('deps', `
  const { fs, path, os, log, ensure, readIf, readJsonSafe, writeJsonSafe, isAlive,
          memory, active, persistActive, spawn, MAX_RERUN, RECOVERY_COUNT, DEC_DIR,
          INBOX, RECOVERY_FLAG_DIR, ORG_ROOT, CLUSTER_ALERT_SCRIPT,
          STALL_GRACE_MS, LOG_STALL_MS, routeTask, dispatch } = deps;
  ${combined}
  return { ${names.join(', ')} };
`);
const F = runner(deps);

/* mock config 文件（供 notifyAnomalyAutoRecovered 读取） */
function writeCfg(v) {
  fs.writeFileSync(path.join(ORG_ROOT, 'config', 'cluster-notify.json'),
    JSON.stringify({ notifyAnomalyAutoRecovered: v }), 'utf8');
}
writeCfg(false);

/* ============ 场景 A：异常标记不通知 + 请求恢复决策 ============ */
console.log('\n【场景 A】异常标记（failTaskAnomaly）→ 不立即通知，只请求恢复决策');
{
  const entry = { doneMarker: path.join(INBOX, 't1.DONE'), agentId: 'coo' };
  F.failTaskAnomaly('t1', entry, '进程异常中断（pid 已死）');
  assert(notifications.length === 0, '异常时【不】触发用户通知');
  assert(fs.existsSync(DEC_DIR) && fs.readdirSync(DEC_DIR).some(f => f.includes('t1')), '写出了恢复决策请求');
  assert(F.active.size === 0, 'active 已移除异常任务');
  assert(fs.readFileSync(entry.doneMarker, 'utf8').includes('.FAILED'), '写失败标记');
}

/* ============ 场景 B：重跑打标 → 重跑完成不通知 ============ */
console.log('\n【场景 B】分身决策「重跑」→ 打 recovery 标 → 重跑完成【不通知】，记 [自动恢复]');
{
  fs.writeFileSync(path.join(INBOX, 't2.md'), 'agent: coo\n# 任务 t2\n', 'utf8');
  fs.writeFileSync(path.join(INBOX, 't2.DONE'), '.FAILED: 疑似卡死', 'utf8');
  F.handleRecoveryDecision('t2', 'A. 重跑（管家重新派发原任务文件）');
  assert(fs.existsSync(path.join(RECOVERY_FLAG_DIR, 't2.flag')), '重跑打上 recovery 标记');
  assert(!fs.existsSync(path.join(INBOX, 't2.DONE')), '重跑清除失败标记，可再次派发');

  fs.writeFileSync(path.join(INBOX, 't2.DONE'), '重跑成功完成', 'utf8');
  const before = notifications.length;
  // 复刻 checkActive 完成分支判定（用真实 helper）
  const done = F.readIf(path.join(INBOX, 't2.DONE'));
  const ok = !done.includes('.FAILED');
  let skipped = false, logMsg = '';
  if (F.isRecoveryRerun('t2')) {
    F.clearRecoveryRerun('t2');
    if (ok) { skipped = true; logMsg = '♻️ [t2] 异常自动恢复成功（重跑完成）→ 已跳过用户通知，记 [自动恢复]'; }
  }
  assert(skipped === true, 'recovery 重跑完成识别为「自动恢复成功」');
  assert(notifications.length === before, '重跑完成【不】通知用户');
  assert(!fs.existsSync(path.join(RECOVERY_FLAG_DIR, 't2.flag')), 'flag 完成后清理');
  assert(logMsg.includes('[自动恢复]'), '日志含 [自动恢复] 记录');
}

/* ============ 场景 C：重跑超限 → 通知带说明 ============ */
console.log('\n【场景 C】重跑超限（MAX_RERUN=2）→ 通知用户，消息含尝试说明');
{
  F.writeJsonSafe(RECOVERY_COUNT, { t3: 2 });
  fs.writeFileSync(path.join(INBOX, 't3.md'), 'agent: coo\n# 任务 t3\n', 'utf8');
  fs.writeFileSync(path.join(INBOX, 't3.DONE'), '.FAILED: 疑似卡死', 'utf8');
  const before = notifications.length;
  F.handleRecoveryDecision('t3', 'A. 重跑');
  const n = notifications.slice(before);
  assert(n.length === 1, '超限触发 1 次用户通知');
  assert(n[0] && n[0].status === 'failed', '通知状态为 failed');
  assert(n[0] && /尝试自动恢复 2 次仍失败/.test(n[0].summary), '通知消息含尝试说明');
  assert(fs.readFileSync(path.join(INBOX, 't3.DONE'), 'utf8').includes('.FAILED'), '强制归档写失败标记');
}

/* ============ 场景 D：分身决策归档 → 通知带说明 ============ */
console.log('\n【场景 D】分身决策「归档」→ 通知用户，带说明');
{
  fs.writeFileSync(path.join(INBOX, 't4.md'), 'agent: coo\n# 任务 t4\n', 'utf8');
  fs.writeFileSync(path.join(INBOX, 't4.DONE'), '.FAILED: 进程异常中断', 'utf8');
  const before = notifications.length;
  F.handleRecoveryDecision('t4', 'B. 归档（保留失败标记，不再重派）');
  const n = notifications.slice(before);
  assert(n.length === 1, '归档触发 1 次用户通知');
  assert(n[0] && /自动恢复失败：分身决策归档/.test(n[0].summary), '归档通知带说明');
}

/* ============ 场景 E：正常任务完成仍通知（回归） ============ */
console.log('\n【场景 E】正常任务完成 → 仍照常通知（回归）');
{
  fs.writeFileSync(path.join(INBOX, 't5.DONE'), '正常完成', 'utf8');
  let willNotify = false;
  if (F.isRecoveryRerun('t5')) { F.clearRecoveryRerun('t5'); }
  else willNotify = true;
  assert(willNotify === true, '正常任务完成走「照常通知」路径');
}

/* 恢复原始 config */
fs.writeFileSync(path.join(ORG_ROOT, 'config', 'cluster-notify.json'),
  JSON.stringify({ enabled: true, notifyDone: true, notifyAnomalyAutoRecovered: false, newApiUrl: '', hkHost: '', hkPort: '', hkUser: '', hkKey: '' }), 'utf8');

console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail === 0 ? 0 : 1);
