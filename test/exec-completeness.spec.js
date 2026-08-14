/**
 * test/exec-completeness.spec.js — 执行完整性审计单测（2026-08-12）
 * 用法：node test/exec-completeness.spec.js
 * 覆盖：audit 判定（异常特征/记录特征/违规）、hitWords、scanAndAudit 集成
 *      （真实临时目录：violations.jsonl 写入 / pitfalls-inbox.md 捕获 / 幂等游标）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ec = require('../lib/exec-completeness');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✔ ${msg}`); }
  else { failed++; console.log(`  ✘ ${msg}`); }
}

console.log('[1] audit 判定逻辑');

// 1.1 任务含「连不上」+ DONE 无记录 → 违规
let r = ec.audit('t1', '尝试连接 192.168.1.5 连不上，改用方案B完成', '任务完成，产出 ok');
assert(r.anomaly === true && r.violation === true, '连不上+无记录 → 违规');

// 1.2 任务含「连不上」+ DONE 有过程异常记录 → 合规
r = ec.audit('t2', '尝试连接 192.168.1.5 连不上，改用方案B完成', '任务完成 [过程异常: 端口连不上→已降级备用通道]');
assert(r.anomaly === true && r.violation === false && r.recorded === true, '连不上+过程异常记录 → 合规');

// 1.3 任务含「失败/超时」+ DONE 有「已修复」→ 合规
r = ec.audit('t3', '接口调用失败，超时3次', '完成 [过程异常: 接口超时→修复重试参数，已修复]');
assert(r.anomaly === true && r.violation === false, '失败/超时+已修复 → 合规');

// 1.4 任务含「绕行」+ DONE 有「沉淀」→ 合规
r = ec.audit('t4', '主渠道不可用，绕行备用源抓取', '完成，坑已沉淀到 pitfalls.md');
assert(r.anomaly === true && r.violation === false, '绕行+沉淀 → 合规');

// 1.5 任务内容无异常特征 → 不打扰（即使 DONE 简单）
r = ec.audit('t5', '生成本周报告并归档', '已完成');
assert(r.anomaly === false && r.violation === false, '无异常特征 → 不误伤');

// 1.6 英文错误词
r = ec.audit('t6', 'ECONNREFUSED on api host, use backup', 'done [过程异常: refused→backup ok]');
assert(r.anomaly === true && r.violation === false, 'ECONNREFUSED+backup 记录 → 合规');

// 1.7 空任务/空 DONE 边界
r = ec.audit('t7', '', '完成');
assert(r.violation === false, '空任务内容 → 不违规');
r = ec.audit('t8', '连接失败', '');
assert(r.violation === true, '异常任务空 DONE → 违规');

console.log('[2] hitWords');
const hw = ec.hitWords('连接超时后换备用通道，最终失败');
assert(hw.length >= 1 && hw.some(w => /超时|失败|备用/.test(w)), `命中词提取: ${hw.join(',')}`);

console.log('[3] scanAndAudit 集成（临时目录）');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-comp-'));
const inbox = path.join(tmp, 'inbox'), logs = path.join(tmp, 'logs'), kd = path.join(tmp, 'knowledge');
fs.mkdirSync(inbox, { recursive: true }); fs.mkdirSync(logs, { recursive: true }); fs.mkdirSync(kd, { recursive: true });

// 3.1 违规样例：任务含连不上，DONE 无记录
fs.writeFileSync(path.join(inbox, 'job-a.md'), '连接数据库连不上，换了端口', 'utf8');
fs.writeFileSync(path.join(inbox, 'job-a.DONE'), '完成', 'utf8');
// 3.2 合规样例：任务含失败，DONE 有过程异常
fs.writeFileSync(path.join(inbox, 'job-b.md'), 'API 调用失败两次，绕行缓存', 'utf8');
fs.writeFileSync(path.join(inbox, 'job-b.DONE'), '完成 [过程异常: 失败→绕行缓存，已修复]', 'utf8');
// 3.3 无异常任务：不打扰
fs.writeFileSync(path.join(inbox, 'job-c.md'), '整理文档', 'utf8');
fs.writeFileSync(path.join(inbox, 'job-c.DONE'), '完成', 'utf8');
// 3.4 失败标记：跳过
fs.writeFileSync(path.join(inbox, 'job-d.md'), '连不上目标，无法继续', 'utf8');
fs.writeFileSync(path.join(inbox, 'job-d.FAILED'), '.FAILED: 目标不可达', 'utf8');

let res = ec.scanAndAudit(inbox, logs, kd);
assert(res.violations === 1, `违规计数=1（实际 ${res.violations}）`);
assert(res.pitfallCandidates === 1, `沉淀候选=1（实际 ${res.pitfallCandidates}）`);
assert(res.audited === 2, `审计数=2（实际 ${res.audited}）`);

const viol = fs.readFileSync(path.join(logs, 'exec-completeness-violations.jsonl'), 'utf8');
assert(viol.includes('job-a') && viol.includes('hitWords'), 'violations.jsonl 内容含 job-a + hitWords');

const pf = fs.readFileSync(path.join(kd, 'pitfalls-inbox.md'), 'utf8');
assert(pf.includes('job-b') && pf.includes('待 learning-officer'), 'pitfalls-inbox.md 捕获 job-b');

// 3.5 幂等：再跑一次不重复
res = ec.scanAndAudit(inbox, logs, kd);
assert(res.violations === 0 && res.pitfallCandidates === 0, `幂等：二次扫描无新增（v=${res.violations}, p=${res.pitfallCandidates}）`);

// 3.6 游标文件生成
assert(fs.existsSync(path.join(logs, 'exec-completeness-cursor.json')), 'cursor 文件生成');

// 3.7 无任务文件的 DONE（已归档）→ 不判定不崩
fs.writeFileSync(path.join(inbox, 'orphan.DONE'), '完成', 'utf8');
res = ec.scanAndAudit(inbox, logs, kd);
assert(res.violations === 0 && !viol.includes('orphan'), '归档任务无对照 → 跳过不误报');

// 清理
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
