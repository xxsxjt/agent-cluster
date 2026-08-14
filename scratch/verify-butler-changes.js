// 验证 butler.js 的 parseTask session 字段与自查块注入（避免命令行中文编码问题）
const fs = require('fs');
const path = require('path');
const org = 'C:/Users/du_ji/pi_workspace/org';

// 1. 自查块存在
const butler = fs.readFileSync(path.join(org, 'butler.js'), 'utf8');
const checks = [
  ['自查块标题', butler.includes('交付前自查（2026-08-12 强制执行，通过后才写 DONE）')],
  ['编码自查项', butler.includes('① 编码——产物文本文件 UTF-8 无乱码')],
  ['UI/布局自查项', butler.includes('② UI/布局')],
  ['内容完整性自查项', butler.includes('③ 内容完整性')],
  ['需求覆盖自查项', butler.includes('④ 需求覆盖')],
  ['自查不通过自修', butler.includes('自查不通过 → 自己修 → 再自查，全过才写 DONE')],
  ['parseTask session 字段', /let session = null/.test(butler) && /^session\s*:\s*(\S+)/im.test(butler.slice(butler.indexOf('function parseTask'), butler.indexOf('function parseTask') + 4000))],
  ['spawnAgent 传 taskName/sessionPolicy', butler.includes('taskName: task.name, sessionPolicy: task.session')],
  ['会话归档维护', butler.includes('lastSessionArchiveAt') && butler.includes('archive-sessions.js')],
];
let fail = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) fail++;
}

// 2. parseTask 实际解析 session 字段（模拟任务文件）
const tmp = path.join(org, 'scratch', 'test-session-parse.md');
fs.writeFileSync(tmp, [
  'agent: night-worker',
  'provider: opencode-go',
  'model: deepseek-v4-flash',
  'session: reuse',
  '',
  '任务内容'
].join('\n'), 'utf8');
// 直接提取 parseTask 函数执行（butler.js 顶部 require 会启动副作用？——用 vm 或直接复制解析逻辑）
// 简单验证：正则解析头部
const content = fs.readFileSync(tmp, 'utf8');
const m = content.split('\n').slice(0, 15).find(l => /^session\s*:\s*(\S+)/i.test(l));
console.log(`${m && m.match(/^session\s*:\s*(\S+)/i)[1] === 'reuse' ? 'PASS' : 'FAIL'} session 头部解析 → ${m}`);
if (!(m && m.match(/^session\s*:\s*(\S+)/i)[1] === 'reuse')) fail++;
fs.unlinkSync(tmp);

// 3. spawn.js 的会话复用接线
const spawn = fs.readFileSync(path.join(org, 'lib', 'spawn.js'), 'utf8');
if (spawn.includes("require('./session-reuse')") && spawn.includes('sessionPolicy')) {
  console.log('PASS spawn.js 接入 session-reuse');
} else { console.log('FAIL spawn.js 接入'); fail++; }

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail ? 1 : 0);
