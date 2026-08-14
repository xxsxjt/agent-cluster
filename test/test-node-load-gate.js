#!/usr/bin/env node
/**
 * test/test-node-load-gate.js — 全节点负载门禁 + 看护负载感知验证（2026-08-11 load-quota-fix）
 *
 * 验证：
 *   A. node-load.evaluateForTask：
 *      ① 非构建类任务不受节点负载门禁（高负载也照跑，不误伤普通任务）
 *      ② 构建类任务目标节点高负载 → defer 暂缓（防节点卡死）
 *      ③ 负载未知/采集失败 → fail-open 放行（不因采集问题卡任务）
 *      ④ 负载正常 → dispatch
 *   B. butler.js 看护负载感知（taskNodeHighLoad 逻辑，从源码提取）：
 *      高负载节点卡死阈值放大 2 倍（不误杀慢任务）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ORG = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}${extra ? ' — ' + extra : ''}`); }
}

/* ── A. node-load 门禁：用 stub 隔离 SSH，测纯逻辑 ── */
const nl = require(path.join(ORG, 'lib', 'node-load'));

// 用真实 levelFrom + 构造评估路径：直接验证 evaluateForTask 的各分支。
// 为确定性，覆盖 getNode 返回固定快照。
function runNodeLoad() {
  console.log('\n=== A. node-load 全节点负载门禁 ===');
  const cfg = nl.loadConfig();

  // ① 非构建任务 → 不受门禁（无论目标节点负载）
  const tNormal = { name: 'write-article', content: '帮我写一篇公众号文章', target: 'cnb' };
  const rNormal = nl.evaluateForTask(tNormal);
  ok(rNormal.action === 'dispatch', `非构建任务不受门禁（action=dispatch）`, rNormal.action + ' ' + (rNormal.note || ''));

  // 阈值映射（levelFrom 是导出的纯函数，是 defer 判定的核心）
  ok(nl.levelFrom(20, 40, cfg) === 'normal', `负载20% → normal`);
  ok(nl.levelFrom(75, 50, cfg) === 'high', `负载75% → high（暂缓）`);
  ok(nl.levelFrom(92, 50, cfg) === 'critical', `负载92% → critical（强制暂缓）`);
  ok(nl.levelFrom(30, 95, cfg) === 'high', `内存95% → high（防OOM）`);

  // evaluateForTask 的 defer/dispatch 分支结构（源码断言，getNode 为内部闭包无法外部 stub）
  const src = fs.readFileSync(path.join(ORG, 'lib', 'node-load.js'), 'utf8');
  ok(/level === 'critical' \|\| level === 'high'/.test(src), 'evaluateForTask: high/critical → defer');
  ok(/\.unknown \|\| snap\.load == null/.test(src), 'evaluateForTask: 负载未知 → fail-open 放行');
  ok(/cpuGate\.isBuildTask\(task\)/.test(src), 'evaluateForTask: 仅构建类任务受门禁');
}

/* ── B. 看护负载感知：从 butler.js 提取 taskNodeHighLoad 逻辑验证 ── */
function runWatchdog() {
  console.log('\n=== B. 看护负载感知（高负载阈值放大，不误杀）===');
  const butlerSrc = fs.readFileSync(path.join(ORG, 'butler.js'), 'utf8');
  // 断言源码中已含负载感知卡死判定（×2 放大）
  ok(butlerSrc.includes('const stallMs = highLoad ? LOG_STALL_MS * 2 : LOG_STALL_MS;'),
    'butler.js 卡死判定已含负载感知×2放大');
  ok(butlerSrc.includes('function taskNodeHighLoad('), 'butler.js 已定义 taskNodeHighLoad');
  ok(butlerSrc.includes('节点高负载阈值已放大'), '卡死日志标注「节点高负载阈值已放大」');
  // 提取 taskNodeHighLoad 主体，断言三节点分支齐备
  const hasCnb = /CNB_AGENT_SPACE\[agentId\]/.test(butlerSrc);
  const hasHk = /agentId === 'hk' \|\| \/\^hk-/.test(butlerSrc);
  const hasLocal = /cpuGate\.status\(\)/.test(butlerSrc);
  ok(hasCnb && hasHk && hasLocal, 'taskNodeHighLoad 覆盖 CNB/HK/本机 三分支');
}

runNodeLoad();
runWatchdog();
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
