/**
 * soft-timeout while 循环模拟测试（2026-08-11 night-worker）
 * 复刻 scripts/hk-task.js / cnb-task.js 的软超时轮询核心逻辑，
 * 用假 ssh（可控远端日志 mtime）验证：超时→询问→远端活跃续期 / 远端停滞宽限到→FAILED。
 */
'use strict';
const path = require('path');
const ORG = path.resolve(__dirname, '..');
const soft = require(path.join(ORG, 'lib', 'soft-timeout'));

const SOFT_GRACE_SEC = 10 * 60;
const fakeSleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; console.log('  ✅', msg); } else { fail++; console.log('  ❌', msg); } };

/** 模拟一次桥轮询。remoteActiveFn: () => 远端日志mtime(epoch秒) */
async function runLoop(name, timeoutSec, remoteActiveFn, totalSec, graceSec) {
  const grace = graceSec || SOFT_GRACE_SEC;
  const baseDeadline = Date.now() + timeoutSec * 1000;
  let deadline = baseDeadline;
  let softEnteredAt = null;
  let softDeadline = 0;
  let asked = 0, renewed = 0, failed = false;
  const start = Date.now();
  while (true) {
    // 轮询间隔 100ms（加速）
    await fakeSleep(100);
    // 到期后的处理：首次到期 → 软超时（询问），随后查远端活跃 → 续期 / 宽限到 → 卡死
    if (Date.now() >= deadline) {
      if (softEnteredAt === null) {
        softEnteredAt = Date.now();
        softDeadline = softEnteredAt + grace * 1000;
        asked++;   // 模拟投 checkpoint 询问
      }
      const logMtime = remoteActiveFn();
      if (soft.isRemoteActive(logMtime)) {
        deadline = Date.now() + timeoutSec * 1000;
        softEnteredAt = null;
        renewed++;
        continue;
      }
      if (Date.now() >= softDeadline) { failed = true; break; }
    }
    if (Date.now() - start > totalSec * 1000) break;  // 模拟时长上限
  }
  return { asked, renewed, failed };
}

(async () => {
  console.log('场景A：超时后远端日志仍活跃 → 桥应续期（不杀），不 FAILED');
  // 远端日志 mtime 始终=now（持续活跃）
  const a = await runLoop('simA', 1, () => Math.floor(Date.now() / 1000), 6);
  assert(a.asked >= 1, `到点投过询问（asked=${a.asked}）`);
  assert(a.renewed >= 1, `远端活跃触发续期（renewed=${a.renewed}）`);
  assert(a.failed === false, `未 FAILED（failed=${a.failed}）—— 证明"超时但进程活着 → 继续跑"`);
  console.log(`  → asked=${a.asked} renewed=${a.renewed} failed=${a.failed}`);

  console.log('\n场景B：超时后远端日志停滞 + 宽限到 → 判定真卡死 FAILED');
  // 远端日志 mtime 停在 4 分钟前（超活跃窗口 3min）→ 宽限到应 FAILED
  const stale = Math.floor((Date.now() - 4 * 60 * 1000) / 1000);
  const b = await runLoop('simB', 1, () => stale, 3, 1);
  assert(b.asked >= 1, `到点投过询问（asked=${b.asked}）`);
  assert(b.renewed === 0, `远端停滞不续期（renewed=${b.renewed}）`);
  assert(b.failed === true, `宽限到判定卡死（failed=${b.failed}）—— 真卡死仍然结束`);

  console.log('\n场景C：任务在超时点前完成 → 正常退出，无询问无续期无FAILED');
  // 模拟完成：远端日志在宽限内出现（runLoop 简化：用超短 totalSec 未到超时就 break）
  const c = await runLoop('simC', 60, () => 0, 0.3);
  assert(c.asked === 0 && c.renewed === 0 && c.failed === false, `未到超时即正常结束（asked=${c.asked} renewed=${c.renewed} failed=${c.failed}）`);

  console.log('\n场景D：超时后模拟智能体回应（远端日志恢复活跃）→ 桥续期不杀（任务继续）');
  // 先停滞(无日志) → 到点询问 → 模拟智能体回应后远端日志恢复活跃 → 续期
  let responded = false;
  const activeFn = () => responded
    ? Math.floor(Date.now() / 1000)        // 回应后日志恢复活跃
    : Math.floor((Date.now() - 4 * 60 * 1000) / 1000); // 回应前停滞(4min前)
  const d = await (async () => {
    // 异步驱动：1.2s 时“模拟回应”切 activeFn 状态
    const timer = setTimeout(() => { responded = true; }, 1200);
    const r = await runLoop('simD', 1, activeFn, 5);
    clearTimeout(timer);
    return r;
  })();
  assert(d.asked >= 1, `到点投过询问（asked=${d.asked}）`);
  assert(d.renewed >= 1, `模拟回应后远端活跃触发续期（renewed=${d.renewed}）`);
  assert(d.failed === false, `未 FAILED（failed=${d.failed}）—— 智能体回应后任务继续，没被杀`);
  console.log(`  → asked=${d.asked} renewed=${d.renewed} failed=${d.failed}`);

  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
