#!/usr/bin/env node
/**
 * 孤儿进程根治验证（2026-08-11，任务 orphan-cleanup）
 * 从 butler.js 源码抽取真实实现（isAlive/terminateChild/finalizeTask/sweepOrphans），
 * 注入测试作用域（fake active + fake INBOX + 临时目录），验证：
 *  1) finalizeTask：杀子进程 + 删 PID + 移出 active，一次做齐
 *  2) sweepOrphans：四类场景——正常在跑(不动)/孤儿子进程(强杀)/已完成PID残留(清)/死PID(删文件)
 * 全程用临时目录，绝不触碰真实 inbox。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const butlerSrc = fs.readFileSync(path.join(__dirname, '..', 'butler.js'), 'utf8');

/* 从源码提取指定函数（从 "function <name>(" 所在行起，到顶层闭合 }） */
function extract(fnName) {
  const startMarker = `function ${fnName}(`;
  const si = butlerSrc.indexOf(startMarker);
  if (si < 0) throw new Error(`未找到 function ${fnName}`);
  const lnStart = butlerSrc.lastIndexOf('\n', si) + 1;
  let depth = 0, started = false, i = lnStart;
  for (; i < butlerSrc.length; i++) {
    const ch = butlerSrc[i];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') { depth--; if (started && depth === 0) { i++; break; } }
  }
  return butlerSrc.slice(lnStart, i);
}
const isAliveMatch = butlerSrc.match(/const isAlive = pid => \{[\s\S]*?\n\};/);
if (!isAliveMatch) throw new Error('isAlive 提取失败');
const isAliveExpr = isAliveMatch[0].replace(/^const isAlive = /, '');

// 组装测试作用域：真实函数 + 临时目录 + fake active
const code = `
module.exports = (function(){
  'use strict';
  const fs = require('fs'), path = require('path'), cp = require('child_process');
  const active = new Map();
  const ORG_ROOT = ${JSON.stringify(fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-test-')))}; // 临时工作根
  const INBOX = path.join(ORG_ROOT, 'inbox');
  const LOGS  = path.join(ORG_ROOT, 'logs');
  const ACTIVE_TABLE = path.join(LOGS, 'active-tasks.json');
  fs.mkdirSync(INBOX, { recursive: true });
  fs.mkdirSync(LOGS, { recursive: true });
  const readIf = function(p){ try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
  const isAlive = ${isAliveExpr};
  const persistCalls = { n: 0 };
  function log(...a){ if (process.env.TEST_VERBOSE) console.log(...a); }
  function persistActive(){ persistCalls.n++; }
  ${extract('terminateChild')}
  ${extract('finalizeTask')}
  ${extract('sweepOrphans')}
  return { finalizeTask, sweepOrphans, active, INBOX, ORG_ROOT, persistCalls, fs, path, spawn: cp.spawn };
})()
`;

const m = new module.constructor();
m.filename = __filename;
m.paths = module.paths;
m._compile(code, path.join(__dirname, 'orphan-cleanup.scope.js'));

const B = m.exports;
const { finalizeTask, sweepOrphans, active, INBOX, ORG_ROOT, persistCalls, spawn } = B;

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log(`  ✅ ${msg}`); } else { failed++; console.log(`  ❌ ${msg}`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 造一个真实存活子进程（node 长驻），返回 {child, pid} */
function spawnLiveNode() {
  return spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);'], { stdio: 'ignore' });
}

(async () => {
  console.log('=== 场景1: finalizeTask 统一收尾 ===');
  {
    // 造一个在跑子进程 + PID 文件
    const child = spawnLiveNode();
    await sleep(300);
    const name = 'task-success';
    const pidPath = path.join(INBOX, name + '.PID');
    fs.writeFileSync(pidPath, String(child.pid), 'utf8');
    const entry = { child, pidPath, startedAt: Date.now() };
    active.set(name, entry);
    // 任务完成：写 .DONE
    fs.writeFileSync(path.join(INBOX, name + '.DONE'), 'done', 'utf8');

    ok(active.has(name), `收尾前 active 含 ${name}`);
    ok(fs.existsSync(pidPath), `收尾前 PID 文件存在`);
    ok(B.fs.existsSync !== undefined, 'fs 可用');

    const ret = finalizeTask(name, entry, '完成收尾');
    await sleep(1500);
    ok(ret === true, `finalizeTask 返回 true`);
    ok(!active.has(name), `收尾后已移出 active`);
    ok(!fs.existsSync(pidPath), `收尾后 PID 文件已删`);
    // 子进程应被杀（已退出）
    let childAlive = true;
    try { process.kill(child.pid, 0); } catch (e) { childAlive = false; }
    ok(!childAlive, `子进程已终止 (pid=${child.pid})`);
  }

  console.log('=== 场景2: sweepOrphans —— 正常在跑任务不动 ===');
  {
    const child = spawnLiveNode();
    await sleep(300);
    const name = 'task-running';
    const pidPath = path.join(INBOX, name + '.PID');
    fs.writeFileSync(pidPath, String(child.pid), 'utf8');
    active.set(name, { child, pidPath });   // 在 active → 不应被扫
    const before = fs.readdirSync(INBOX).length;
    sweepOrphans();
    ok(fs.existsSync(pidPath), `正常在跑任务的 PID 文件保留`);
    let alive = true; try { process.kill(child.pid, 0); } catch (e) { alive = false; }
    ok(alive, `正常在跑任务的子进程未被误杀`);
    // 清理该测试子进程
    child.kill();
    active.delete(name);
  }

  console.log('=== 场景3: sweepOrphans —— 孤儿子进程（不在 active）强杀+删 ===');
  {
    const child = spawnLiveNode();
    await sleep(300);
    const name = 'task-orphan';
    const pidPath = path.join(INBOX, name + '.PID');
    fs.writeFileSync(pidPath, String(child.pid), 'utf8');
    // 不放进 active（模拟 butler 重启后 active 丢失）
    sweepOrphans();
    await sleep(1500);
    ok(!fs.existsSync(pidPath), `孤儿任务 PID 文件已删`);
    let alive = true; try { process.kill(child.pid, 0); } catch (e) { alive = false; }
    ok(!alive, `孤儿子进程已被强杀 (pid=${child.pid})`);
  }

  console.log('=== 场景4: sweepOrphans —— 已完成(.DONE)但 PID 残留 ===');
  {
    const child = spawnLiveNode();
    await sleep(300);
    const name = 'task-done-leak';
    const pidPath = path.join(INBOX, name + '.PID');
    fs.writeFileSync(pidPath, String(child.pid), 'utf8');
    fs.writeFileSync(path.join(INBOX, name + '.DONE'), 'done', 'utf8');
    // 不在 active（任务已完成，进程却因 exit 未触发残留）
    sweepOrphans();
    await sleep(1500);
    ok(!fs.existsSync(pidPath), `已完成但残留的 PID 文件已删`);
    let alive = true; try { process.kill(child.pid, 0); } catch (e) { alive = false; }
    ok(!alive, `已完成任务的残留子进程已被杀`);
  }

  console.log('=== 场景5: sweepOrphans —— 死 PID 残留标记 ===');
  {
    const name = 'task-deadpid';
    const pidPath = path.join(INBOX, name + '.PID');
    fs.writeFileSync(pidPath, '999999', 'utf8');   // 不存在的 pid
    sweepOrphans();
    ok(!fs.existsSync(pidPath), `死 PID 残留文件已删`);
  }

  console.log('=== 场景6: finalizeTask 幂等（进程已死）===');
  {
    const name = 'task-alreadydead';
    const pidPath = path.join(INBOX, name + '.PID');
    fs.writeFileSync(pidPath, '999999', 'utf8');
    const entry = { child: { pid: 999999, stdin: { end() {} }, kill() {} }, pidPath };
    active.set(name, entry);
    const ret = finalizeTask(name, entry, '收尾');
    ok(ret === true, `finalizeTask 对死进程仍返回 true`);
    ok(!active.has(name), `死进程任务已移出 active`);
    ok(!fs.existsSync(pidPath), `死进程任务 PID 文件已删`);
  }

  // 清理临时目录
  try { fs.rmSync(ORG_ROOT, { recursive: true, force: true }); } catch (e) {}

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
