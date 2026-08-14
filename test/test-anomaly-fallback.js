#!/usr/bin/env node
/**
 * 进程异常退出兜底回归验证（2026-08-12 失败判定机制体系化加固，night-worker）
 * 测 lib/anomaly-fallback.js 全部纯函数（补DONE / 已闭环跳过 / 自动重派 / 清陈旧.FAILED）。
 * 全程用临时 inbox 目录，绝不触碰真实 inbox。
 *
 * 覆盖场景：
 *   A. 补 DONE：进程异常退出但日志有 agent_settled（完成证据）→ decideFallback=supplement-done → 写 .DONE
 *   B. 已闭环跳过：源任务已由 -improve 覆盖 / 源已 .DONE → decideFallback=skip-closed，不再重复补验
 *   C. 自动重派：无完成证据且未闭环 → decideFallback=redispatch
 *   D. isClosed 三种闭环判定
 *   E. hasCompletionEvidence：agent_settled 命中 / 无证据 / logOffset 越界 → null
 *   F. cleanClosedFailed：清已闭环任务的陈旧 .FAILED，保留未闭环 .FAILED
 *   G. markClosedSkipped 写终态标记
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const anomaly = require(path.join(__dirname, '..', 'lib', 'anomaly-fallback'));

const ORG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'anomaly-fb-test-'));
const INBOX = path.join(ORG_ROOT, 'inbox');
const LOGS  = path.join(ORG_ROOT, 'logs');
fs.mkdirSync(INBOX, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

const readIF = p => { try { return require('fs').readFileSync(p, 'utf8'); } catch (e) { return ''; } };

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log(`  ✅ ${msg}`); } else { failed++; console.log(`  ❌ ${msg}`); } };
const write = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c, 'utf8'); };

console.log('=== A. 补 DONE：异常退出但工作已完成 ===');
{
  const name = 'src-done-补DONE';
  const logPath = path.join(LOGS, `${name}.log`);
  write(logPath, '[start]\n{"type":"agent_settled","ok":true}\n');
  const fb = anomaly.decideFallback(name, { logPath, logOffset: 0 }, { inboxDir: INBOX });
  ok(fb.action === 'supplement-done' && fb.evidence === 'agent_settled',
    `decideFallback 判定 supplement-done（${fb.evidence}）`);
  const content = anomaly.supplementDone(name, INBOX, fb.evidence);
  ok(fs.existsSync(path.join(INBOX, `${name}.DONE`)) && content.includes('补 DONE'),
    'supplementDone 已写 .DONE 补标记');
  // 补 DONE 后任务即闭环，isClosed 命中
  ok(anomaly.isClosed(name, INBOX) === true, '补 DONE 后任务 isClosed=true');
}

console.log('=== B. 已闭环跳过：源任务由 -improve 覆盖 ===');
{
  // 构造：源任务 fail，同时 -improve 已完成 → 源任务视为已闭环，不再重复补验
  const src = 'src-已闭环-覆盖';
  write(path.join(INBOX, `${src}.md`), 'agent: night-worker\n\n源任务');
  write(path.join(INBOX, `${src}.FAILED`), '.FAILED: 进程异常中断（pid 已死）');
  write(path.join(INBOX, `${src}-improve.DONE`), 'improve 补验完成');  // 已由 -improve 覆盖闭环
  const fb = anomaly.decideFallback(src, { logPath: null, logOffset: 0 }, { inboxDir: INBOX });
  ok(fb.action === 'skip-closed', `decideFallback 判定 skip-closed（源已由 -improve 覆盖）`);
  ok(anomaly.isClosed(src, INBOX) === true, 'isClosed 识别源任务已由 -improve 闭环');
}

console.log('=== B2. 已闭环跳过：源任务本身已 .DONE ===');
{
  const src2 = 'src-已闭环-自身done';
  write(path.join(INBOX, `${src2}.DONE`), 'done');
  ok(anomaly.isClosed(src2, INBOX) === true, 'isClosed 识别自身 .DONE');
  ok(anomaly.isClosed(src2 + '-improve', INBOX) === true, 'isClosed 识别 -improve 的源已 .DONE');
  const fb2 = anomaly.decideFallback(src2 + '-improve', { logPath: null }, { inboxDir: INBOX });
  ok(fb2.action === 'skip-closed', `improve 任务源已闭环 → skip-closed`);
}

console.log('=== C. 自动重派：无证据且未闭环 ===');
{
  const open = 'src-未闭环-重派';
  write(path.join(INBOX, `${open}.md`), 'agent: night-worker\n\n未闭环任务');
  const fb = anomaly.decideFallback(open, { logPath: null, logOffset: 0 }, { inboxDir: INBOX });
  ok(fb.action === 'redispatch', 'decideFallback 判定 redispatch（无证据且未闭环）');
  ok(anomaly.isClosed(open, INBOX) === false, 'isClosed 未闭环 = false');
}

console.log('=== D. hasCompletionEvidence：agent_settled / 无 / logOffset ===');
{
  const l1 = path.join(LOGS, 'ev-1.log');
  write(l1, 'before\n{"type":"agent_settled","done":true}\n');
  ok(anomaly.hasCompletionEvidence(l1, 0) === 'agent_settled', 'agent_settled JSON 事件被识别');
  ok(anomaly.hasCompletionEvidence(l1, 999999) === null, 'logOffset 越界 → null（本次无新段）');
  const l2 = path.join(LOGS, 'ev-2.log');
  write(l2, 'no settlement here, still working\n');
  ok(anomaly.hasCompletionEvidence(l2, 0) === null, '无完成证据 → null');
  ok(anomaly.hasCompletionEvidence(null, 0) === null, 'logPath 缺失 → null');
  ok(anomaly.hasCompletionEvidence(path.join(LOGS, 'nope.log'), 0) === null, '日志不存在 → null');
}

console.log('=== E. cleanClosedFailed：清已闭环陈旧 .FAILED，留未闭环 ===');
{
  const closed1 = 't-闭环-1';
  write(path.join(INBOX, `${closed1}-improve.DONE`), 'improve done');
  write(path.join(INBOX, `${closed1}.FAILED`), '.FAILED: 异常');
  const open1 = 't-未闭环-1';
  write(path.join(INBOX, `${open1}.FAILED`), '.FAILED: 异常');
  const closed2 = 't-闭环-2';
  write(path.join(INBOX, `${closed2}.DONE`), 'done');
  write(path.join(INBOX, `${closed2}.FAILED`), '.FAILED: 异常');  // 自身 .DONE + .FAILED 并存（异常残留）
  // 注意：INBOX 此刻还残留上一节 B 的 src-已闭环-覆盖.FAILED（也已闭环）→ 一并清理，共 3 个
  const cleaned = anomaly.cleanClosedFailed(INBOX);
  ok(cleaned === 3, `清理 ${cleaned} 个已闭环任务的陈旧 .FAILED（期望 3：t-闭环-1 + t-闭环-2 + 上节残留 src-已闭环-覆盖）`);
  ok(!fs.existsSync(path.join(INBOX, 't-闭环-1.FAILED')), '已闭环(t-闭环-1).FAILED 已移除');
  ok(!fs.existsSync(path.join(INBOX, 't-闭环-2.FAILED')), '已闭环(t-闭环-2).FAILED 已移除');
  ok(fs.existsSync(path.join(INBOX, 't-未闭环-1.FAILED')), '未闭环任务的 .FAILED 保留');
}

console.log('=== F. markClosedSkipped 写终态标记 ===');
{
  const name = 't-skip';
  const content = anomaly.markClosedSkipped(name, INBOX, '进程异常中断（pid 已死）');
  const got = fs.readFileSync(path.join(INBOX, `${name}.FAILED`), 'utf8');
  ok(content && got.includes('源任务已由 -improve 闭环，跳过重复补验'), 'markClosedSkipped 写 .FAILED 注明已闭环');
}

console.log('=== G. settlePending：调度层兜底（DONE 写入前死亡） ===');
{
  // G1: 死 PID + 日志有完成证据 + 无终态标记 → 补 DONE
  const done1 = 'sp-完成-1';
  write(path.join(INBOX, `${done1}.md`), 'task');
  write(path.join(INBOX, `${done1}.PID`), '9999999');          // 死 PID
  write(path.join(LOGS, `${done1}.log`), '[start]\n{"type":"agent_settled"}\n');
  // G2: 死 PID + 无完成证据 → 不补（留给 scanInbox 正常重派）
  const open1 = 'sp-未完成-1';
  write(path.join(INBOX, `${open1}.md`), 'task');
  write(path.join(INBOX, `${open1}.PID`), '9999998');
  write(path.join(LOGS, `${open1}.log`), '[start] still working\n');
  // G3: 活 PID（自身进程）→ 不动（正常在跑）
  const alive1 = 'sp-运行-1';
  write(path.join(INBOX, `${alive1}.md`), 'task');
  write(path.join(INBOX, `${alive1}.PID`), String(process.pid));
  write(path.join(LOGS, `${alive1}.log`), '[start]\n{"type":"agent_settled"}\n');
  // G4: 已有 .DONE → 不动（已终态）
  const done2 = 'sp-已完成-2';
  write(path.join(INBOX, `${done2}.md`), 'task');
  write(path.join(INBOX, `${done2}.DONE`), 'done');
  write(path.join(INBOX, `${done2}.PID`), '9999997');
  write(path.join(LOGS, `${done2}.log`), '{"type":"agent_settled"}');
  // G5: 已有 .FAILED → 不动（走失败恢复链）
  const failed1 = 'sp-失败-1';
  write(path.join(INBOX, `${failed1}.md`), 'task');
  write(path.join(INBOX, `${failed1}.FAILED`), '.FAILED: 异常');
  write(path.join(INBOX, `${failed1}.PID`), '9999996');

  const res = anomaly.settlePending(INBOX, LOGS);
  ok(res.supplemented === 1 && res.names.includes(done1), `只补 1 个（${res.names.join(',')}），期望 [${done1}]`);
  ok(fs.existsSync(path.join(INBOX, `${done1}.DONE`)) && readIF(path.join(INBOX, `${done1}.DONE`)).includes('补 DONE'), 'G1 死PID+完成证据 → 已补写 .DONE');
  ok(!fs.existsSync(path.join(INBOX, `${done1}.PID`)), 'G1 补 DONE 后死 PID 残留已清理');
  ok(!fs.existsSync(path.join(INBOX, `${open1}.DONE`)), 'G2 无完成证据 → 不补 DONE（留给正常重派）');
  ok(!fs.existsSync(path.join(INBOX, `${alive1}.DONE`)), 'G3 活 PID（正常在跑）→ 不动');
  ok(!fs.existsSync(path.join(INBOX, `${done2}.DONE`)) === false, 'G4 已有 .DONE → 不动（不重复补）');
  ok(fs.existsSync(path.join(INBOX, `${failed1}.FAILED`)), 'G5 已有 .FAILED → 不动（走失败恢复链）');
  ok(res.scanned === 1, `scanned 只计实际补 DONE 的任务数=${res.scanned}（非命中不 scan）`);
}

// 清理临时目录
try { fs.rmSync(ORG_ROOT, { recursive: true, force: true }); } catch (e) {}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
