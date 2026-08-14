'use strict';
/* 2026-08-10 channel-manager 任务：校验 fallback 链四渠道全部登记且健康。
 * 1) 读健康表，补登记缺失渠道（aliyun-tokenplan/xxsx/deepseek）
 * 2) 对四渠道轻量探测 GET /v1/models
 * 3) 更新健康表 probedAt/probeOk/status，输出结果
 */
const fs = require('fs');
const path = require('path');
const ORG_ROOT = path.join(__dirname, '..', '..', '..'); // org/
const cf = require(path.join(ORG_ROOT, 'lib', 'channel-fallback.js'));

const HEALTH_FILE = cf.HEALTH_FILE;
const CHAIN = cf.FALLBACK_CHAIN;
const providers = CHAIN.map(c => c.provider);

async function main() {
  console.log('=== 任务：校验 fallback 链四渠道登记 + 健康 ===');
  console.log('链上渠道顺序:', providers.join(' -> '));

  // 1) 核对健康表登记情况，补登记缺失渠道
  const health = cf.readHealth();
  console.log('\n--- 登记核对 ---');
  const missing = providers.filter(p => !(p in health));
  if (missing.length) {
    console.log('健康表缺失渠道:', missing.join(', '), '→ 补登记');
    for (const p of missing) {
      health[p] = { fails: 0, lastFailAt: null, coolingUntil: 0, lastError: '', status: 'registered' };
    }
    cf.writeHealth(health);
    console.log('已补登记:', missing.join(', '));
  } else {
    console.log('四渠道均已登记');
  }

  // 2) 对四渠道轻量探测 GET /v1/models
  console.log('\n--- 四渠道健康探测 ---');
  const results = [];
  for (const p of providers) {
    const r = await cf.probeChannel(p);
    const rec = health[p] || {};
    rec.probedAt = Date.now();
    rec.probeOk = !!r.ok;
    rec.probeCode = r.code || null;
    if (r.ok) {
      rec.lastError = '';
      rec.status = rec.status === 'recovered' ? 'recovered' : 'healthy';
    } else {
      rec.lastError = String(r.error || r.code || 'probe fail').slice(0, 200);
      rec.status = rec.status || 'unreachable';
    }
    health[p] = rec;
    results.push({ provider: p, ok: r.ok, code: r.code, error: r.error || '', detail: (r.body || '').slice(0, 90) });
    console.log(`  ${p}: ${r.ok ? 'OK' : 'FAIL'}${r.code ? ' (HTTP ' + r.code + ')' : ''}${r.error ? ' err=' + r.error : ''}`);
  }
  cf.writeHealth(health);

  // 3) 汇总
  console.log('\n=== 结果汇总 ===');
  const allOk = results.every(r => r.ok);
  const okList = results.filter(r => r.ok).map(r => r.provider);
  const failList = results.filter(r => !r.ok).map(r => `${r.provider}(${r.error || r.code || 'err'})`);
  console.log('链上四渠道:', providers.join(', '));
  console.log('健康可用:', okList.join(', ') || '(无)');
  console.log('异常:', failList.join('; ') || '(无)');
  console.log('四渠道全部登记且健康:', allOk ? '是' : '否');
  return { allOk, providers, okList, failList };
}

main().then(r => {
  console.log('\nDONE_JSON:' + JSON.stringify(r));
}).catch(e => {
  console.error('ERR', e);
  process.exit(1);
});
