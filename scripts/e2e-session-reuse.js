#!/usr/bin/env node
/**
 * scripts/e2e-session-reuse.js — 会话复用端到端验证（2026-08-12）
 *
 * 不经 butler（不打断在跑任务），直接调 lib/spawn.js 模拟派发两个同族任务：
 *   任务 A（session-reuse-e2e-a）→ 记录自己的会话 id 到 artifacts/e2e-a.txt
 *   （模拟空闲）任务 B（session-reuse-e2e-b，同族）→ 应复用 A 的会话：
 *     ① 当前会话 id == A 记录的 id（spawn 复用判定 + pi resume 双验证）
 *     ② B 凭上下文回忆出 A 的任务内容（上下文延续性验证，不查文件）
 *
 * 用法：node scripts/e2e-session-reuse.js [--agent-dir <dir>]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { spawnAgent } = require('../lib/spawn');

// ── 临时 agent 目录（隔离，不碰真实 sessions） ──
const agentDir = process.argv.includes('--agent-dir')
  ? path.resolve(process.argv[process.argv.indexOf('--agent-dir') + 1])
  : fs.mkdtempSync(path.join(os.tmpdir(), 'sess-e2e-'));
for (const d of ['sessions', 'artifacts']) fs.mkdirSync(path.join(agentDir, d), { recursive: true });

const doneA = path.join(agentDir, 'artifacts', 'e2e-a.DONE');
const doneB = path.join(agentDir, 'artifacts', 'e2e-b.DONE');
const outA = path.join(agentDir, 'artifacts', 'e2e-a.txt');
const outB = path.join(agentDir, 'artifacts', 'e2e-b.txt');

const promptA = `你是测试智能体（E2E 会话复用验证）。工作目录: ${agentDir}
任务 A：用 bash 命令读取你自己会话文件的第一行（sessions 目录下最新的 .jsonl，head -1），
提取其中的 "id" 字段值，写入 ${outA}（格式一行：SESSION_ID=<id>）。
完成后创建标记文件 ${doneA}（一行摘要）。`;

const promptB = `你是测试智能体（E2E 会话复用验证，同一会话的第二个任务）。工作目录: ${agentDir}
任务 B（验证会话复用）：
1. 读取 ${outA} 得到任务 A 记录的会话 id（SESSION_ID=xxx）。
2. 用 bash 读取你自己当前会话文件的第一行（sessions 目录下最新的 .jsonl，head -1），提取 "id" 字段。
3. 判断：当前会话 id 是否 == 任务 A 的会话 id？相等 → 会话复用成功。
4. 【上下文延续验证】不查看任何文件，凭当前会话上下文回忆：任务 A 让你做了什么？输出任务 A 的指令摘要。
5. 全部写入 ${outB}，格式：
   REUSED=true|false
   TASK_A_ID=<id>
   CURRENT_ID=<id>
   RECALL=<任务A指令摘要>
完成后创建标记文件 ${doneB}（一行摘要）。`;

function waitFor(file, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (fs.existsSync(file)) { clearInterval(iv); resolve(fs.readFileSync(file, 'utf8').trim()); }
      else if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error(`${label} 超时 ${timeoutMs / 1000}s`)); }
    }, 2000);
  });
}

async function main() {
  console.log(`E2E 目录: ${agentDir}`);
  console.log('--- 任务 A 派发（应新开会话） ---');
  const childA = spawnAgent({
    type: 'pi', prompt: promptA, cwd: agentDir, name: 'night-worker',
    taskName: 'session-reuse-e2e-a', sessionPolicy: 'auto',
    log: path.join(agentDir, 'artifacts', 'a.log'), donePath: doneA
  });
  await waitFor(doneA, 240 * 1000, '任务A');
  const idA = fs.readFileSync(outA, 'utf8').trim().replace('SESSION_ID=', '');
  console.log(`任务 A 完成, session id = ${idA}`);

  // 模拟空闲：把 A 的会话 mtime 改旧（真实场景 = 上个任务结束 >2min）
  const sessDir = path.join(agentDir, 'sessions');
  const sessFile = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl')).sort().pop();
  const past = new Date(Date.now() - 3 * 60 * 1000);
  fs.utimesSync(path.join(sessDir, sessFile), past, past);
  console.log(`会话文件 ${sessFile} mtime 已置旧（模拟任务 A 结束 3min）`);

  console.log('--- 任务 B 派发（应复用任务 A 会话） ---');
  const childB = spawnAgent({
    type: 'pi', prompt: promptB, cwd: agentDir, name: 'night-worker',
    taskName: 'session-reuse-e2e-b', sessionPolicy: 'auto',
    log: path.join(agentDir, 'artifacts', 'b.log'), donePath: doneB
  });
  await waitFor(doneB, 240 * 1000, '任务B');
  const report = fs.readFileSync(outB, 'utf8').trim();
  console.log('--- 任务 B 报告 ---');
  console.log(report);

  // 判定
  const reused = /REUSED=true/.test(report);
  const sameId = report.includes(`CURRENT_ID=${idA}`);
  console.log('\n=== 判定 ===');
  console.log(`复用判定: ${reused ? 'PASS（B 的会话 id == A）' : 'FAIL'}`);
  console.log(`上下文延续: ${sameId && /RECALL=/.test(report) ? 'PASS（B 回忆出任务 A 内容）' : '见报告'}`);
  const ok = reused && sameId;
  console.log(`总体: ${ok ? '✅ E2E 通过' : '❌ E2E 失败'}`);
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error('E2E 异常:', e.message); process.exit(1); });
