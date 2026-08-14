/**
 * test/concurrency-routing.spec.js — 并发限制 + 类型路由验证脚本
 * 不启动 butler（避免干扰运行中的但管家），黑盒验证：
 *   1. config/butler.json maxConcurrent 读取与默认
 *   2. route-auto pickSide 分类（local/remote/cnb/hk）
 *   3. 并发排队逻辑（模拟 active 表）
 *   4. waiting 表真实落盘/读取
 * 用法: node test/concurrency-routing.spec.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pickSide } = require('../lib/route-auto');

const ORG = path.join(__dirname, '..');
const CFG = path.join(ORG, 'config', 'butler.json');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✅ ' + msg); } else { fail++; console.log('  ❌ ' + msg); } };

console.log('=== 1. config/butler.json ===');
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
ok(typeof cfg.maxConcurrent === 'number' && cfg.maxConcurrent >= 1, `maxConcurrent=${cfg.maxConcurrent}`);
ok(cfg.remoteFirst === 'cnb', `remoteFirst=${cfg.remoteFirst}`);

console.log('\n=== 2. route-auto pickSide 分类 ===');
const cls = [
  ['intel-collect 信息收集', 'remote'],
  ['写复盘报告', 'remote'],
  ['gradle 构建', 'cnb'],
  ['ssh 服务器部署', 'hk'],
  ['修改 butler.js', 'local'],
  ['side: remote\n纯推理任务', 'remote'],
  ['side: local\n改代码', 'local'],
];
for (const [c, e] of cls) ok(pickSide({ content: c, name: 't' }) === e, `[${e}] ${c.replace(/\n/, ' ')}`);

console.log('\n=== 3. 并发排队逻辑（模拟但管家 scanInbox） ===');
const active = new Map();
const localActiveCount = () => { let n = 0; for (const [, e] of active) if (e.agentId !== 'hk' && e.agentId !== 'cnb-dev') n++; return n; };
const URGENT = [/^checkpoint-/, /^review-/, /^复盘/, /^巡检/, /^daily-meeting/, /^intel-collect/];
const isAuto = n => URGENT.some(r => r.test(n));
const tasks = ['t1', 't2', 't3', 't4', 't5'].map(n => ({ name: n }));
const dispatched = [], queued = [];
for (const t of tasks) {
  if (!isAuto(t.name) && localActiveCount() >= 3) { queued.push(t.name); continue; }
  dispatched.push(t.name); active.set(t.name, { agentId: 'coo' });
}
ok(dispatched.length === 3, `首轮只派发 3 个（实际 ${dispatched.length}）`);
ok(queued.length === 2, `排队 2 个（实际 ${queued.length}）`);
active.delete('t1');
const queued2 = [];
for (const q of queued) { if (localActiveCount() >= 3) { queued2.push(q); continue; } dispatched.push(q); active.set(q, { agentId: 'coo' }); }
ok(dispatched.length === 4, `完成 1 个后自动补 1 个 → 派发 ${dispatched.length}`);
ok(queued2.length === 1, `剩余排队 1 个`);

console.log('\n=== 4. waiting 表真实落盘/读取 ===');
const WT = path.join(ORG, 'logs', 'waiting-tasks.json');
fs.writeFileSync(WT, JSON.stringify({ testWaiting: { ts: new Date().toISOString(), agentId: 'coo', prio: 1, reason: 'test' } }, null, 2));
const w1 = JSON.parse(fs.readFileSync(WT, 'utf8'));
ok(w1.testWaiting && w1.testWaiting.agentId === 'coo', 'waiting 表写入/读取正常');
delete w1.testWaiting;
fs.writeFileSync(WT, JSON.stringify(w1, null, 2), 'utf8');
ok(!JSON.parse(fs.readFileSync(WT, 'utf8')).testWaiting, 'waiting 表清理正常');

console.log(`\n==== 结果: ${pass} 通过 / ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
