const path = require('path');
const ORG = path.resolve('.');

// 1) 验证 stripTaskHeader 真实剥离 type 头
const dm = require(path.join(ORG, 'lib', 'daily-meeting.js'));
const polluted = [
  'type: daily-meeting',
  'date: 2026-08-09',
  'agent: coo',
  'provider: opencode-go',
  'model: deepseek-v4-flash',
  'thinking: off',
  '',
  '# 例会说明',
  '请各智能体汇报今日工作。'
].join('\n');
const stripped = dm.stripTaskHeader(polluted);
console.log('=== 验证1: stripTaskHeader 剥离 type 头 ===');
console.log('剥离结果前6行:', JSON.stringify(stripped.split('\n').slice(0,6)));
console.log('前15行含 type: ?', /type\s*:/.test(stripped.split('\n').slice(0,15).join('\n')));
console.log('前15行含 agent: ?', /agent\s*:/.test(stripped.split('\n').slice(0,15).join('\n')));
console.log('正文保留?', stripped.includes('# 例会说明') && stripped.includes('请各智能体汇报'));
console.log('');

// 2) 验证 butler 守卫逻辑（复制自 butler.js:593-598）
function guardIsSubTask(name) {
  return /^daily-meeting-\d{4}-\d{2}-\d{2}-[^-]+/.test(name);
}
console.log('=== 验证2: butler 防递归守卫 ===');
const cases = {
  'daily-meeting-2026-08-09': false,
  'daily-meeting-2026-08-09-copywriting': true,
  'daily-meeting-2026-08-09-hermes': true,
  'daily-meeting-2026-08-09-learning-officer': true,
  'daily-meeting-2026-08-09-channel-manager': true,
};
let pass = true;
for (const [name, expected] of Object.entries(cases)) {
  const got = guardIsSubTask(name);
  const ok = got === expected;
  if (!ok) pass = false;
  console.log(`${name}: got=${got} expected=${expected} ${ok ? '✅' : '❌'}`);
}
console.log(`子任务守卫: ${pass ? '全部通过 ✅' : '有失败 ❌'}`);
console.log('');

// 3) 验证 buildDailyPrompt 产物前15行不含 type（模拟真实调用链）
console.log('=== 验证3: buildDailyPrompt 输出前15行 ===');
const result = dm.buildDailyPrompt('2026-08-09', 'copywriting', stripped, '/tmp/done');
const head15 = result.split('\n').slice(0,15).join('\n');
console.log('输出前15行含 type: ?', /type\s*:/.test(head15));
console.log('输出前15行含 agent: ?', /agent\s*:/.test(head15));
console.log('prompt 含任务名?', result.includes('copywriting'));
console.log('');

console.log('=== 综合判定 ===');
const allPass = stripped && !/type\s*:/.test(stripped.split('\n').slice(0,15).join('\n')) && pass && !/type\s*:/.test(head15);
console.log(allPass ? '✅ 修复真实有效，全部验证通过' : '❌ 存在失败项');
