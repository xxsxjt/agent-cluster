/**
 * test/test-load-quota.js — 渠道限额判定专项验证（2026-08-11 load-quota-fix）
 *
 * 验证「不轻易判限额」铁律：
 *   ① 单次 403/失败 ≠ 限额 —— 不通知（按不稳定自动重试）
 *   ② 连续 QUOTA_CONFIRM_THRESHOLD(5) 次额度类失败 且在窗口内 → 才确认限额 → 通知
 *   ③ 跨窗口累计 → 重置为 1，不确认
 *   ④ 非额度错误（timeout/连接错）→ 不累计 quotaFails，不误报
 *   ⑤ 成功后 markSuccess → 清零额度怀疑
 *
 * 安全：测试用独立 provider('__testq'/'__testt')，跑完清理，不污染真实渠道健康表。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ORG = path.resolve(__dirname, '..');
const cf = require(path.join(ORG, 'lib', 'channel-fallback'));

const HEALTH = path.join(ORG, 'logs', 'channel-health.json');
const OUTAGE = path.join(ORG, 'logs', 'channel-outage.json');

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra ? '— ' + extra : ''}`); }
}

function backup(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } }
function restore(f, b) { if (b === null) { try { fs.unlinkSync(f); } catch (e) {} } else { try { fs.writeFileSync(f, b); } catch (e) {} } }

const bHealth = backup(HEALTH), bOutage = backup(OUTAGE);
const HEALTH_BEFORE = backup(HEALTH);

function resetTestProvider() {
  const h = cf.readHealth();
  delete h.__testq; delete h.__testt;
  cf.writeHealth(h);
}
function run() {
  const chain = [
    { provider: '__testq', model: 'x', thinking: 'off', label: '测试渠道Q' },
    { provider: '__testt', model: 'x', thinking: 'off', label: '测试渠道T' },
  ];

  console.log('\n=== 场景① 单次 403 ≠ 限额（不通知） ===');
  resetTestProvider();
  cf.markFailure('__testq', '403 insufficient_quota');
  assert('单次 403 未确认限额', cf.isQuotaConfirmed('__testq') === false);
  const o1 = cf.recordOutage({ name: 't1' }, chain, 1);
  assert('recordOutage needNotify=false（单次不误报）', o1.quota.needNotify === false, JSON.stringify(o1.quota));
  assert('unstable 渠道含 __testq', o1.quota.unstable.includes('__testq'));
  assert('confirmed 为空', o1.quota.confirmed.length === 0);

  console.log('\n=== 场景② 连续 5 次额度失败（窗口内）→ 确认限额 → 通知 ===');
  resetTestProvider();
  for (let i = 0; i < 5; i++) cf.markFailure('__testq', '403 quota exceeded');
  assert('5 次后确认限额', cf.isQuotaConfirmed('__testq') === true);
  const o2 = cf.recordOutage({ name: 't2' }, chain, 6);
  assert('needNotify=true（已确认限额触发通知）', o2.quota.needNotify === true);
  assert('confirmed 含 __testq', o2.quota.confirmed.includes('__testq'));
  assert('threshold=5', o2.quota.threshold === 5);

  console.log('\n=== 场景③ 连续 5 次但跨窗口 → 重置为 1，不确认 ===');
  resetTestProvider();
  // 前 4 次在窗口内
  for (let i = 0; i < 4; i++) cf.markFailure('__testq', '403 quota');
  // 手动把 quotaFailAt 推到窗口外（>10min 前）
  const h = cf.readHealth();
  h.__testq.quotaFailAt = Date.now() - cf.QUOTA_CONFIRM_WINDOW_MS - 1000;
  cf.writeHealth(h);
  cf.markFailure('__testq', '403 quota');   // 第5次，但跨窗口 → 重置为1
  assert('跨窗口后 quotaFails 重置为 1', (cf.readHealth().__testq.quotaFails) === 1);
  assert('跨窗口未确认限额', cf.isQuotaConfirmed('__testq') === false);
  const o3 = cf.recordOutage({ name: 't3' }, chain, 5);
  assert('needNotify=false（跨窗口不确认）', o3.quota.needNotify === false);

  console.log('\n=== 场景④ 非额度错误不误报 ===');
  resetTestProvider();
  for (let i = 0; i < 5; i++) cf.markFailure('__testt', 'ETIMEDOUT connect timeout');
  assert('timeout 5 次 quotaFails 仍为 0', (cf.readHealth().__testt.quotaFails || 0) === 0);
  assert('timeout 未确认限额', cf.isQuotaConfirmed('__testt') === false);
  const o4 = cf.recordOutage({ name: 't4' }, chain, 6);
  assert('needNotify=false（非额度）', o4.quota.needNotify === false);

  console.log('\n=== 场景⑤ 成功后清零额度怀疑 ===');
  resetTestProvider();
  for (let i = 0; i < 5; i++) cf.markFailure('__testq', '403 quota');
  assert('5 次后确认限额（前置）', cf.isQuotaConfirmed('__testq') === true);
  cf.markSuccess('__testq');
  assert('成功后 quotaFails 清零', (cf.readHealth().__testq.quotaFails || 0) === 0);
  assert('成功后不再确认限额', cf.isQuotaConfirmed('__testq') === false);

  console.log('\n=== 场景⑥ 混合：额度+非额度交替，不累计确认 ===');
  resetTestProvider();
  cf.markFailure('__testq', '403 quota');     // q=1
  cf.markFailure('__testq', 'ETIMEDOUT');     // 非额度，不动
  cf.markFailure('__testq', '403 quota');     // q=2
  cf.markFailure('__testq', '500 internal');  // 非额度
  cf.markFailure('__testq', '403 quota');     // q=3
  assert('交替后 quotaFails=3（非额度不累计）', (cf.readHealth().__testq.quotaFails) === 3);
  assert('未达 5 不确认', cf.isQuotaConfirmed('__testq') === false);

  // 清理测试渠道
  resetTestProvider();
  const healthNow = JSON.parse(fs.readFileSync(HEALTH, 'utf8'));
  const changed = Object.keys(healthNow).some(k => k.startsWith('__test'));
  assert('测试渠道已清理（健康表无污染）', changed === false, '仍残留 ' + JSON.stringify(Object.keys(healthNow).filter(k=>k.startsWith('__test'))));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  // 恢复原始健康表（若测试污染了真实渠道，还原；测试渠道已清理，通常无需）
  if (bHealth !== null) fs.writeFileSync(HEALTH, bHealth);
  if (bOutage !== null) fs.writeFileSync(OUTAGE, bOutage);
  process.exit(fail ? 1 : 0);
}
try { run(); } catch (e) {
  console.error('测试异常:', e);
  if (bHealth !== null) fs.writeFileSync(HEALTH, bHealth);
  if (bOutage !== null) fs.writeFileSync(OUTAGE, bOutage);
  process.exit(1);
}
