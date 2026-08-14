/**
 * test/meeting-close-loop.spec.js — 例会完整闭环转派单测（meeting-full-close-loop）
 *
 * 覆盖：四通道提取（卡点/明日计划/异常/学习信号）+ 路由归属 + 幂等 + 兼容旧入口。
 * 黑盒 require lib/meeting-close-loop，不启动 butler，不影响运行中的管家。
 * 用法: node test/meeting-close-loop.spec.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('../lib/meeting-close-loop');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✅ ' + msg); } else { fail++; console.log('  ❌ ' + msg); } };

/* ── 模拟例会材料（卡点+明日计划+经验+异常） ── */
const SIM = `# 全员大会纪要（2026-08-13-sim）

## twin
# 全员大会 · twin 汇报（2026-08-13-sim）

## 1. 今日做了什么
- **拍板 app-p0-product 后续 P1 单拆**：扫码/模块开关归 P1，交 coo 派发 xxsx-gateway。

## 2. 卡点/风险
- 模拟卡点 A：patrol 巡检链仍有偶发缺失风险，需学习进化官自愈机制加固。
- 模拟卡点 B：CNB 桥"无代码块"伪失败判定在部分场景仍可能误标。

## 3. 明日计划
- 验收 app-p0-product 拍板后 P1 单拆落地。
- 跟进 CNB 桥伪失败标记修复回归。

## mc-dev
# 每日例会汇报：mc-dev（2026-08-13-sim）

## 2. 卡点 / 风险
- **无独立 Mod 开发任务派发**：今日为协调统筹 + 例会汇报，无实际构建/开发产出。
- **mc-dev-earth 长期空转**：至少 7 月以来无任务，专项长期无实际产出。

## 3. 明日计划
- 作为 coordinator 继续跟踪 3 子域 temple/earth/plantmagic 状态。

## learning-officer
## 1. 今日做了什么
- **教训沉淀**：intel-collect 异常中断教训已记入 pitfalls（复盘得出的可复用经验：任务异常要立即如实记录）。

## 2. 卡点 / 风险
- 无。

## 3. 明日计划
- 持续推进失败判定机制故障族沉淀进 pitfalls。
`;

const tmp = path.join(os.tmpdir(), 'meeting-sim-spec.md');
fs.writeFileSync(tmp, SIM, 'utf8');

console.log('=== A. 四通道提取 ===');
const text = SIM;
const blockers = m.extractBlockers(text);
const plans = m.extractPlans(text);
const anomalies = m.extractAnomalies(text);
const lessons = m.extractLessons(text);

ok(blockers.length === 4, `卡点提取 ${blockers.length} 条（期望 4：twin 2 + mc-dev 2）`);
ok(plans.length === 4, `明日计划提取 ${plans.length} 条（期望 4：twin 2 + mc-dev 1 + learning-officer 1）`);
ok(anomalies.length === 1, `异常提取 ${anomalies.length} 条（期望 1：mc-dev-earth 长期空转）`);
ok(lessons.length >= 1, `学习信号提取 ${lessons.length} 条（期望 ≥1：教训/经验）`);

console.log('=== B. 归属路由 ===');
const planAgents = plans.map(p => p.agentId);
ok(planAgents.includes('twin'), `计划归属 twin ✅（${planAgents.join(',')}）`);
ok(planAgents.includes('mc-dev'), `计划归属 mc-dev ✅`);
ok(planAgents.includes('learning-officer'), `计划归属 learning-officer ✅`);

console.log('=== C. 完整闭环 dry-run（四通道+互评） ===');
const r = m.runFullCloseLoop(tmp, { dryRun: true, peerReview: true });
ok(r.blockers.length === 4, `闭环卡点 ${r.blockers.length}`);
ok(r.plans.length === 4, `闭环计划 ${r.plans.length}`);
ok(r.anomalies.length === 1, `闭环异常 ${r.anomalies.length}`);
ok(r.lessons.length >= 1, `闭环学习 ${r.lessons.length}`);
const anom = r.dispatched.find(d => d.kind === 'anom');
ok(anom && anom.agentId === 'mc-dev-earth', `异常归属 mc-dev-earth（实际 ${anom && anom.agentId}）`);
const card = r.dispatched.find(d => d.kind === 'card' && d.text.includes('patrol'));
ok(card && card.agentId === 'learning-officer', `patrol 卡点→learning-officer（实际 ${card && card.agentId}）`);
const card2 = r.dispatched.find(d => d.kind === 'card' && d.text.includes('CNB 桥'));
ok(card2 && card2.agentId === 'night-worker', `CNB 桥卡点→night-worker（实际 ${card2 && card2.agentId}）`);
const learn = r.dispatched.find(d => d.kind === 'learn');
ok(learn && learn.taskName.includes('-batch'), `学习信号批量 1 条（${learn && learn.taskName}）`);

console.log('=== D. 幂等（真实转派后重跑只跳过） ===');
const tmp2 = path.join(os.tmpdir(), 'meeting-sim-spec2.md');
fs.writeFileSync(tmp2, SIM, 'utf8');
const r1 = m.runFullCloseLoop(tmp2, { dryRun: false, peerReview: true });
const r2 = m.runFullCloseLoop(tmp2, { dryRun: false, peerReview: true });
ok(r1.dispatched.length > 0, `首次转派 ${r1.dispatched.length} 条`);
ok(r2.dispatched.length === 0 && r2.skipped.length === r1.dispatched.length,
  `重跑全部幂等跳过（转派 ${r2.dispatched.length}，跳过 ${r2.skipped.length}）`);
ok(r1.reportFile && fs.existsSync(r1.reportFile), `清单落盘 ${r1.reportFile}`);
ok(r1.learningFile && fs.existsSync(r1.learningFile), `学习信号落盘 ${r1.learningFile}`);
ok(r1.peerTasks.length >= 2, `互评任务 ${r1.peerTasks.length} 条（期望 ≥2）`);

console.log('=== E. 兼容旧入口 runCloseLoop ===');
const r3 = m.runCloseLoop(tmp2, { dryRun: true });
ok(r3.blockers.length === 4, `旧入口卡点 ${r3.blockers.length}（兼容）`);

console.log('=== F. 无卡点材料（空安全） ===');
const emptyTmp = path.join(os.tmpdir(), 'meeting-sim-empty.md');
fs.writeFileSync(emptyTmp, '# 例会\n\n## a1\n## 1. 今日做了什么\n- 正常汇报无异常。\n## 2. 卡点 / 风险\n- 无。\n## 3. 明日计划\n- 无明日任务。\n', 'utf8');
const r4 = m.runFullCloseLoop(emptyTmp, { dryRun: true, peerReview: true });
ok(r4.blockers.length === 0 && r4.plans.length === 0 && r4.anomalies.length === 0,
  `空材料安全（卡点 ${r4.blockers.length}/计划 ${r4.plans.length}/异常 ${r4.anomalies.length}）`);

console.log('=== G. CRLF 行尾兼容（Windows 材料） ===');
const crlfTmp = path.join(os.tmpdir(), 'meeting-sim-crlf.md');
fs.writeFileSync(crlfTmp, SIM.replace(/\n/g, '\r\n'), 'utf8');
const r5 = m.runFullCloseLoop(crlfTmp, { dryRun: true, peerReview: true });
ok(r5.blockers.length === 4, `CRLF 卡点提取 ${r5.blockers.length}（期望 4，
 不挡段匹配）`);
ok(r5.plans.length === 4, `CRLF 计划提取 ${r5.plans.length}（期望 4）`);
fs.unlinkSync(crlfTmp);

// 清理
for (const p of [tmp, tmp2, emptyTmp]) try { fs.unlinkSync(p); } catch (e) {}
// 清理真实转派生成的任务/清单（spec2 的）
const inbox = path.join(__dirname, '..', 'inbox');
const meetings = path.join(__dirname, '..', 'knowledge', 'meetings');
for (const f of fs.readdirSync(inbox)) {
  if (f.includes('meeting-sim-spec2')) { try { fs.unlinkSync(path.join(inbox, f)); } catch (e) {} }
}
for (const f of fs.readdirSync(meetings)) {
  if (f.includes('meeting-sim-spec2')) { try { fs.unlinkSync(path.join(meetings, f)); } catch (e) {} }
}
// 清理幂等状态中的 spec2
try {
  const stPath = path.join(__dirname, '..', 'logs', 'meeting-close-loop-state.json');
  const st = JSON.parse(fs.readFileSync(stPath, 'utf8'));
  delete st.meetings['meeting-sim-spec2'];
  fs.writeFileSync(stPath, JSON.stringify(st, null, 2), 'utf8');
} catch (e) {}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
