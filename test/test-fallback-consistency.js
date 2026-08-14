'use strict';
/**
 * test/test-fallback-consistency.js — channel-fallback 状态一致性回归测试
 *
 * 2026-08-11 修复目标：markFailure / probeCoolingChannels 失败路径保证 status 与 probeOk 同步，
 *   失败即置 failing/冷却态，不允许 status=healthy 但 probeOk=false。
 *
 * 安全：真实健康表开头备份一份、全部测试结束后统一恢复（单一备份 + 末尾恢复，
 *   杜绝 process.exit 截断恢复微任务导致的污染）。
 */
const assert = require('assert');
const fs = require('fs');
const cf = require('../lib/channel-fallback');

const HEALTH = cf.HEALTH_FILE;
const BAK = `${HEALTH}.consistency-bak-${Date.now()}`;
const existed = fs.existsSync(HEALTH);
if (existed) fs.copyFileSync(HEALTH, BAK);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

function seed(data) { cf.writeHealth(data); }

(async () => {
  // 1. markFailure 单次失败 → failing + probeOk=false
  await t('markFailure 单次失败 → status=failing, probeOk=false', () => {
    seed({ 'zzz-a': { fails: 0, lastFailAt: null, coolingUntil: 0, status: 'recovered', probeOk: true } });
    const rec = cf.markFailure('zzz-a', 'connection reset');
    assert.strictEqual(rec.status, 'failing');
    assert.strictEqual(rec.probeOk, false);
    assert.strictEqual(rec.fails, 1);
    assert.strictEqual(rec.coolingUntil, 0, '未达阈值不应冷却');
  });

  // 2. markFailure 达阈值 → cooling + probeOk=false
  await t('markFailure 达阈值 → status=cooling, probeOk=false', () => {
    seed({ 'zzz-a': { fails: 1, lastFailAt: null, coolingUntil: 0, status: 'failing', probeOk: false } });
    const rec = cf.markFailure('zzz-a', '500 internal');
    assert.strictEqual(rec.status, 'cooling');
    assert.strictEqual(rec.probeOk, false);
    assert.ok(rec.coolingUntil > Date.now(), '应进入冷却窗口');
  });

  // 3. probeCoolingChannels 探测失败 → 强制 cooling（原 status=recovered 也被改）
  await t('probeCoolingChannels 失败 → status=cooling, probeOk=false', async () => {
    seed({ 'zzz-notexist': { fails: 3, lastFailAt: null, coolingUntil: Date.now() - 1000, status: 'recovered', probeOk: true, probedAt: 0 } });
    const results = await cf.probeCoolingChannels(0);
    const mine = results.find(r => r.provider === 'zzz-notexist');
    assert.ok(mine, '应探测到 zzz-notexist');
    assert.strictEqual(mine.recovered, false, '无端点配置应探测失败');
    const rec = cf.readHealth()['zzz-notexist'];
    assert.strictEqual(rec.status, 'cooling', '探测失败后 status 应=cooling');
    assert.strictEqual(rec.probeOk, false, '探测失败后 probeOk 应=false');
  });

  // 4. markRecovered → recovered + probeOk=true
  await t('markRecovered → status=recovered, probeOk=true', () => {
    seed({ 'zzz-a': { fails: 5, status: 'cooling', probeOk: false, coolingUntil: Date.now() + 600000 } });
    const rec = cf.markRecovered('zzz-a');
    assert.strictEqual(rec.status, 'recovered');
    assert.strictEqual(rec.probeOk, true);
    assert.strictEqual(rec.fails, 0);
  });

  // 5. markSuccess → 清零失败 + probeOk=true + status 复位 recovered
  await t('markSuccess → fails=0, probeOk=true, status=recovered', () => {
    seed({ 'zzz-a': { fails: 4, status: 'cooling', probeOk: false, coolingUntil: Date.now() + 1000, quotaFails: 3, quotaFailAt: Date.now() } });
    cf.markSuccess('zzz-a');
    const rec = cf.readHealth()['zzz-a'];
    assert.strictEqual(rec.fails, 0);
    assert.strictEqual(rec.probeOk, true);
    assert.strictEqual(rec.quotaFails, 0, '成功应清零额度怀疑');
    assert.strictEqual(rec.status, 'recovered', '成功应复位健康态（不残留 failing/cooling）');
  });

  // 5b. markSuccess 双向同步：failing 态成功 → status 复位 recovered + probeOk=true
  await t('markSuccess (failing) → status=recovered, probeOk=true', () => {
    seed({ 'zzz-b': { fails: 1, status: 'failing', probeOk: false, coolingUntil: 0 } });
    cf.markSuccess('zzz-b');
    const rec = cf.readHealth()['zzz-b'];
    assert.strictEqual(rec.status, 'recovered');
    assert.strictEqual(rec.probeOk, true);
  });

  // 5c. reconcileHealth：修复 fails>0 但 status 残留 recovered 的历史脏数据
  await t('reconcileHealth 修复失败态残留 recovered 脏数据', () => {
    seed({
      'zzz-dirty': { fails: 1, lastFailAt: Date.now(), coolingUntil: 0, status: 'recovered', probeOk: true },
      'zzz-clean': { fails: 0, lastFailAt: null, coolingUntil: 0, status: 'recovered', probeOk: true },
    });
    const r = cf.reconcileHealth();
    assert.strictEqual(r.repaired, 1, '应仅修复脏渠道');
    const dirty = cf.readHealth()['zzz-dirty'];
    assert.strictEqual(dirty.status, 'failing', 'fails=1 未冷却 → failing');
    assert.strictEqual(dirty.probeOk, false, '失败态 → probeOk=false');
    const clean = cf.readHealth()['zzz-clean'];
    assert.strictEqual(clean.status, 'recovered');
    assert.strictEqual(clean.probeOk, true, '干净态不误伤');
  });

  // 5d. reconcileHealth：冷却中脏数据（fails=0 但 coolingUntil 未到）→ cooling + probeOk=false
  await t('reconcileHealth 冷却中修复为 cooling', () => {
    seed({ 'zzz-cool': { fails: 0, coolingUntil: Date.now() + 600000, status: 'recovered', probeOk: true } });
    cf.reconcileHealth();
    const rec = cf.readHealth()['zzz-cool'];
    assert.strictEqual(rec.status, 'cooling');
    assert.strictEqual(rec.probeOk, false);
  });

  // 6. isCooling 逻辑未破坏
  await t('isCooling 逻辑未破坏', () => {
    assert.strictEqual(cf.isCooling({ fails: 2, coolingUntil: Date.now() + 5000 }), true);
    assert.strictEqual(cf.isCooling({ fails: 2, coolingUntil: Date.now() - 5000 }), false);
    assert.strictEqual(cf.isCooling({ fails: 0, coolingUntil: 0 }), false);
  });

  // ── 统一恢复真实健康表（必须在 process.exit 之前完成）──
  if (existed) {
    fs.copyFileSync(BAK, HEALTH);
    fs.unlinkSync(BAK);
    console.log('  已恢复真实健康表');
  } else {
    try { fs.unlinkSync(HEALTH); } catch (e) {}
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
