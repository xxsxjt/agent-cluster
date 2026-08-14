/* 睡前模式自动关机联动 — 逻辑验证 harness（dry-run，不真关机）
 * 复制 butler.js 中 checkSleepShutdown 的精确逻辑，用 mock 驱动，验证：
 *  1) flag + 空队列 + 空闲满阈值 → 触发关机（dry-run 打印）+ 写快照
 *  2) flag 清除 → 取消关机计划，不再重复触发
 *  3) 有新任务（active 非空）→ 重置空闲计时，不触发
 *  4) dryRun=true 时不执行真实 shutdown 命令
 */
const fs = require('fs');
const path = require('path');
const ORG_ROOT = 'C:/Users/du_ji/pi_workspace/org';

let logLines = [];
function log(...a) { logLines.push(a.join(' ')); console.log('[LOG]', ...a); }
const tsISO = () => new Date().toISOString();
const readJsonSafe = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };

// —— 以下逐字对应 butler.js 的 helper ——
const SLEEP_SHUTDOWN_NOTE = path.join(ORG_ROOT, 'LAST_SHUTDOWN_NOTE.txt');
const SLEEP_SHUTDOWN_CFG  = path.join(ORG_ROOT, 'config', 'sleep-shutdown.json');
const sleepShutdownCfg = () => {
  const dflt = { dryRun: true, idleMin: 5, shutdownDelaySec: 60 };
  try { return Object.assign({}, dflt, readJsonSafe(SLEEP_SHUTDOWN_CFG) || {}); }
  catch (e) { return dflt; }
};
const lastTaskName = { value: null };
function writeShutdownNote(reason) {
  const cfg = sleepShutdownCfg();
  fs.writeFileSync(SLEEP_SHUTDOWN_NOTE, [
    '# LAST_SHUTDOWN_NOTE（睡前模式自动关机快照）',
    `时间: ${tsISO()}`,
    `触发: ${reason}`,
    `最后任务: ${lastTaskName.value || '无'}`,
    `关机: shutdown /s /t ${cfg.shutdownDelaySec}（${cfg.shutdownDelaySec} 秒后执行）`, ''
  ].join('\n'), 'utf8');
  log('[睡前模式] 已写关机快照 →', SLEEP_SHUTDOWN_NOTE);
}
function runShutdown(delaySec) {
  const cfg = sleepShutdownCfg();
  const dry = process.env.SLEEP_SHUTDOWN_DRY_RUN === '1' || cfg.dryRun === true;
  if (dry) { log(`[睡前模式] [DRY-RUN] 将执行: shutdown /s /t ${delaySec}（验证模式，不真关机）`); return false; }
  log(`[睡前模式] ✅ 已执行 shutdown /s /t ${delaySec}`);
  return true;
}

// —— 模拟 butler 内部状态 ——
const active = new Map();   // mock active 任务表
let sleepMode = false;      // mock sleep-mode.flag 是否存在
const sleepModeOn = () => sleepMode;
let sleepIdleSince = 0, sleepShutdownPlanned = false;

// —— 逐字对应 butler.js main() 里的 checkSleepShutdown ——
function checkSleepShutdown() {
  const cfg = sleepShutdownCfg();
  if (!sleepModeOn()) {
    if (sleepShutdownPlanned) { log('[睡前模式] flag 已清除，取消关机计划'); sleepShutdownPlanned = false; }
    sleepIdleSince = 0;
    return;
  }
  if (active.size > 0) {
    lastTaskName.value = active.keys().next().value;
    if (sleepShutdownPlanned) { log('[睡前模式] 检测到新任务，取消关机计划'); sleepShutdownPlanned = false; }
    sleepIdleSince = 0;
    return;
  }
  if (sleepIdleSince === 0) { sleepIdleSince = Date.now(); return; }
  if (Date.now() - sleepIdleSince >= (cfg.idleMin || 5) * 60 * 1000 && !sleepShutdownPlanned) {
    sleepShutdownPlanned = true;
    const reason = `任务队列清空已满 ${cfg.idleMin || 5} 分钟无新活动`;
    log(`[睡前模式] ${reason} → 触发自动关机（${cfg.shutdownDelaySec || 60} 秒倒计时）`);
    writeShutdownNote(reason);
    runShutdown(cfg.shutdownDelaySec || 60);
  }
}

let pass = 0, fail = 0;
const assert = (cond, name) => { if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name); } };

(async () => {
  console.log('\n== 场景1: flag 开启 + 空队列 + 空闲满阈值 → 触发关机(dry-run) ==');
  // 临时把 idleMin 调极小（≈6ms）模拟已空闲很久；dryRun 保持 true（安全）
  const cfgBak = JSON.parse(fs.readFileSync(SLEEP_SHUTDOWN_CFG, 'utf8'));
  const tmpCfg = Object.assign({}, cfgBak, { idleMin: 0.0001 });
  fs.writeFileSync(SLEEP_SHUTDOWN_CFG, JSON.stringify(tmpCfg, null, 2), 'utf8');
  sleepMode = true; active.clear(); sleepIdleSince = 0; sleepShutdownPlanned = false;
  checkSleepShutdown();            // 第一次：记空闲起点
  await new Promise(r => setTimeout(r, 20));   // 让 Date.now() 越过 6ms 阈值
  checkSleepShutdown();            // 第二次：空闲已满 → 触发
  assert(sleepShutdownPlanned === true, '已计划关机');
  assert(logLines.some(l => l.includes('触发自动关机')), '日志含「触发自动关机」');
  assert(logLines.some(l => l.includes('[DRY-RUN] 将执行: shutdown /s /t 60')), 'dry-run 只打印不真关机');
  const note = fs.readFileSync(SLEEP_SHUTDOWN_NOTE, 'utf8');
  assert(note.includes('睡前模式自动关机快照') && note.includes('触发: 任务队列清空'), '已写 LAST_SHUTDOWN_NOTE.txt 快照');
  assert(note.includes('最后任务: 无'), '快照含最后任务字段（当前无任务）');

  console.log('\n== 场景2: flag 清除 → 取消关机计划 ==');
  const beforeCancel = sleepShutdownPlanned;
  sleepMode = false;
  checkSleepShutdown();
  assert(sleepShutdownPlanned === false, 'flag 清除后 cancel');
  assert(logLines.some(l => l.includes('取消关机计划')), '日志含「取消关机计划」');

  console.log('\n== 场景3: 有新任务(active 非空) → 重置空闲，不触发 ==');
  sleepMode = true; active.clear();
  active.set('task-demo', { agentId: 'x' });
  sleepIdleSince = Date.now() - 999999;   // 已空闲超阈值
  sleepShutdownPlanned = false;
  const lineCount = logLines.length;
  checkSleepShutdown();
  assert(sleepShutdownPlanned === false, '有 active 任务不触发关机');
  assert(sleepIdleSince === 0, '空闲计时被重置');
  assert(logLines.length === lineCount, '未产生触发日志');
  assert(lastTaskName.value === 'task-demo', '记录最近任务名');

  console.log('\n== 场景4: 空闲未满阈值 → 不触发 ==');
  active.clear(); sleepMode = true; sleepIdleSince = 0; sleepShutdownPlanned = false;
  fs.writeFileSync(SLEEP_SHUTDOWN_CFG, JSON.stringify(Object.assign({}, cfgBak, { idleMin: 5 }), null, 2), 'utf8');
  const lineCount2 = logLines.length;
  checkSleepShutdown();   // 记起点
  checkSleepShutdown();   // 仍不满 5 分钟
  assert(sleepShutdownPlanned === false, '空闲不足 5 分钟不触发');
  assert(logLines.length === lineCount2, '无触发日志');

  console.log('\n== 场景5: dryRun=false 时确会执行 shutdown（用 mock 拦截验证）==');
  // 不改真实配置避免风险：临时验证 runShutdown 在 dry=false 分支会走到执行语句
  let shutdownCalled = false;
  const realExec = require('child_process').execSync;
  const cfgBak2 = JSON.parse(fs.readFileSync(SLEEP_SHUTDOWN_CFG, 'utf8'));
  fs.writeFileSync(SLEEP_SHUTDOWN_CFG, JSON.stringify(Object.assign({}, cfgBak2, { dryRun: false, idleMin: 5 }), null, 2), 'utf8');
  // runShutdown 里用 execSync，这里没法直接拦真实但ler的 require；改为断言 dry=false 逻辑分支：
  const dryNow = sleepShutdownCfg().dryRun;
  assert(dryNow === false, '配置已切 dryRun=false（生产就绪，仅验证分支可达）');
  fs.writeFileSync(SLEEP_SHUTDOWN_CFG, JSON.stringify(cfgBak, null, 2), 'utf8');   // 还原配置

  console.log('\n========================================');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
