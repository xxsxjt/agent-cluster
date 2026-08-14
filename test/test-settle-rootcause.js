#!/usr/bin/env node
/* 2026-08-10 「agent_settled 进程不退出」根因修复验证
 * 验证：pi RPC 子进程是长驻会话，agent_settled 后不自退；关 stdin → 自然退出。
 * 以及 butler terminateChild 逻辑（真实函数源码提取）能正确判定/收尾。 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PI = 'C:/Users/du_ji/AppData/Roaming/npm/pi.cmd';
const ORG = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

function isAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/* 1) 根因机制：pi RPC 子进程在只发 prompt 后不自退（长驻），必须收 stdin 才退 */
function testPiLingering(done) {
  console.log('\n[Test 1] pi RPC 子进程 agent_settled 后是否自退（根因机制）');
  const child = spawn('cmd.exe', ['/c', PI, '--mode', 'rpc', '--provider', 'opencode-go',
    '--model', 'deepseek-v4-flash', '--thinking', 'low', '--name', 'settle-test'], {
    cwd: ORG, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let sawSettled = false;
  let buf = '';
  child.stdout.on('data', d => {
    buf += d.toString();
    if (/"type"\s*:\s*"agent_settled"/.test(buf)) sawSettled = true;
  });
  // 3s 后发一个最小 prompt，模拟但管家派发
  setTimeout(() => {
    try { child.stdin.write(JSON.stringify({ type: 'prompt', message: '只回复OK', id: 'p1', streamingBehavior: 'steer' }) + '\n'); } catch (e) {}
  }, 2000);
  // 8s 时检查：应已看到 agent_settled 且进程仍存活（证明不自退=根因）
  setTimeout(() => {
    ok(sawSettled, 'pi 发出 agent_settled（完成标志）');
    ok(isAlive(child.pid), `agent_settled 后进程仍存活 pid=${child.pid}（长驻不自退 → 根因证实）`);
    // 关 stdin → 应自然退出
    try { child.stdin.end(); } catch (e) {}
    let exited = false;
    child.on('exit', () => { exited = true; });
    setTimeout(() => {
      ok(exited || !isAlive(child.pid), '关 stdin 后进程退出（terminateChild 收尾机制可行）');
      done();
    }, 3000);
  }, 8000);
}

/* 2) terminateChild 逻辑（从 butler.js 提取真实源码） */
function testTerminateChild(done) {
  console.log('\n[Test 2] butler terminateChild 函数源码提取自检');
  const src = fs.readFileSync(path.join(ORG, 'butler.js'), 'utf8');
  const m = src.match(/function terminateChild[\s\S]*?\n}/);
  ok(!!m, 'terminateChild 函数存在于 butler.js');
  if (m) {
    const terminateChild = new Function('require', 'isAlive', 'log', m[0] + '; return terminateChild;')(require, isAlive, console.log);
    const fake = { pid: 999999999, stdin: { end(){}, destroyed:false }, kill(){}, };  // 无效 pid
    const r = terminateChild({ child: fake }, '测试');
    ok(r === false, '对不存在 pid 返回 false（不死循环/无副作用）');
  }
  done();
}

testPiLingering(() => {
  testTerminateChild(() => {
    console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
    process.exit(fail ? 1 : 0);
  });
});
