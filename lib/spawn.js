#!/usr/bin/env node
/**
 * lib/spawn.js - 子智能体启动工具（复用 hub claude -p / pi rpc）
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';
// 2026-08-13：claude 有原生 exe（bin/claude.exe）——直跑（cmd 包装在 WT 默认终端下会弹）
const CLAUDE = process.env.CLAUDE_BIN || (IS_WIN ? 'C:/Users/du_ji/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe' : 'claude');
// 2026-08-11 hk-exec-hub 跨平台：Windows 用 pi.cmd（cmd.exe 包装），Linux/HK 用系统 pi（直接 spawn）
// 2026-08-13 弹窗根治：cmd /c pi.cmd 包装时 windowsHide 对 cmd 有时无效（孙进程 node 启动闪现窗口）
// → Windows 直跑 node 入口 cli.js（node 是控制台程序但 windowsHide 对其有效）
const PI_JS = 'C:/Users/du_ji/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js';
const PI = process.env.PI_BIN || (IS_WIN ? PI_JS : 'pi');
// spawn 包装：Windows 需 cmd.exe /c（.cmd 脚本），Linux 直接 spawn 可执行文件
function spawnCmd(exe, args, opts) {
  if (IS_WIN) {
    // 直跑 .js（node）/.exe（原生二进制）——windowsHide 有效；仅 .cmd/.bat 才用 cmd 包装
    // （Windows 11 默认终端=WT 时 cmd /c 包装的孙进程会弹窗——Node 已知问题）
    if (exe.endsWith('.js')) return spawn(process.execPath, [exe, ...args], opts);
    if (exe.endsWith('.exe') || (!exe.endsWith('.cmd') && !exe.endsWith('.bat'))) return spawn(exe, args, opts);
    return spawn('cmd.exe', ['/c', exe, ...args], opts);
  }
  return spawn(exe, args, opts);
}
// ── 防御补丁 2026-08-13（hk-butler activating 循环根因修复，本机同源同步）──
// 1) cwd 缺失（agent 目录被清理/未创建，如 HK cnb-build/cnb-test）→ Node spawn 报 ENOENT；
//    自动补建 memory/sessions，让派发不因目录缺失失败。
function ensureWorkdir(cwd) {
  try {
    if (!cwd) return;
    if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });
    for (const sub of ['memory', 'sessions']) {
      const p = path.join(cwd, sub);
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    }
  } catch (e) {
    try { fs.appendFileSync(path.join(__dirname, '..', 'logs', 'spawn-debug.log'),
      `[${new Date().toISOString()}] ensureWorkdir ERROR: ${e.message}\n`); } catch (_) {}
  }
}
// 2) spawn 失败（ENOENT/EPERM...）只记日志+标记任务失败，绝不抛 Unhandled 'error' 崩掉管家进程
//    （2026-08-13 HK 管家 systemd activating 循环：spawn pi ENOENT 未监听 → 每 5s 重启一次）。
function armErrorGuard(child, opts) {
  child.on('error', (err) => {
    const line = `[${new Date().toISOString()}] SPAWN-ERROR name=${opts.name || '?'} exe=${err.path || '?'} code=${err.code || '?'} msg=${err.message}\n`;
    try { fs.appendFileSync(path.join(__dirname, '..', 'logs', 'spawn-debug.log'), line); } catch (_) {}
    if (opts.donePath) {
      try { fs.writeFileSync(opts.donePath, `.FAILED: spawn ${err.path || '?'} ${err.code || '?'} (${err.message})`, 'utf8'); } catch (_) {}
    }
  });
  return child;
}
const { defaultRoute, visionRoute, isVisionTask } = require('./model-router');
const channelFallback = require('./channel-fallback');
const { computeSessionId } = require('./session-reuse');

/**
 * 启动一个子智能体（claude -p 或 pi --mode rpc）
 * @param {object} opts { type:'claude'|'pi', prompt, cwd, name, log }
 * @returns {ChildProcess}
 */
function spawnAgent(opts) {
  const { type = 'claude', prompt, cwd, name, log } = opts;
  ensureWorkdir(cwd); // 2026-08-13：cwd 不存在自动补建，防 spawn ENOENT
  let child, args;

  if (type === 'claude') {
    args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
    child = spawnCmd(CLAUDE, args, {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    // claude -p 用 stdin 传 prompt（避免命令行长度限制）
    setTimeout(() => {
      try {
        child.stdin.write(prompt + '\n');
        child.stdin.end();
      } catch (e) {}
    }, 2000);
  } else if (type === 'pi') {
    // 定时路由默认值（见 lib/model-router.js）：
    //   - 白天 默认 opencode-go/deepseek-v4-flash
    //   - 夜间(22-8) 默认 aliyun qwen3.8-max（折扣价，复杂任务）
    //   - 看图/视觉任务 默认 qwen3.8-max（多模态，不分昼夜）
    // 默认非强制——任务可用 opts.provider / opts.model / opts.thinking（任务文件头部声明）显式覆盖（显式优先）。
    // 渠道 fallback（2026-08-08）：无显式 provider 时按默认链选渠道，跳过已冷却渠道；
    // 夜间/看图把对应路由作为链头（首选），qwen 冷却时自然落到 opencode-go 等健康渠道。
    const route = defaultRoute();
    const isVision = opts.vision === true || isVisionTask(prompt);
    const base = isVision ? visionRoute() : route; // 看图/视觉优先多模态 qwen3.8
    let provider, model;
    if (opts.provider) {
      provider = opts.provider;              // 显式渠道最优先（任务头覆盖）
      model    = opts.model    || base.model;
    } else {
      // 链头 = 当前默认路由（白天 flash / 夜间 qwen / 看图 qwen），随后是标准 fallback 链（去重 provider）
      const chain = [base, ...channelFallback.FALLBACK_CHAIN.filter(c => c.provider !== base.provider)];
      const picked = channelFallback.pickProvider(chain);
      provider = picked.provider;
      model    = picked.model;
    }
    const thinking = opts.thinking || base.thinking;
    // 会话复用（2026-08-12 用户批评：无限新开会话/上下文不延续）：
    //   同 agent + 同主题族（任务名前两段）→ 复用最近空闲会话（pi --session-id 存在即续用，上下文连续）；
    //   无关任务/体积超限/会话活跃中 → 新开（隔离底线——2026-08-10 上下文爆炸修复不破）。
    //   任务头 session: reuse | new | <id> 可显式覆盖（butler parseTask 解析后经 opts.sessionPolicy 传入）。
    const reuse = opts.sessionId
      ? { sessionId: opts.sessionId, reused: true, family: '-', reason: '显式指定' }
      : computeSessionId({
          agentId: name || 'agent',
          taskName: opts.taskName || name || 'task',
          agentDir: cwd || process.cwd(),
          policy: opts.sessionPolicy || 'auto'
        });
    const sessionId = reuse.sessionId; // 唯一 session-id 仍保留（非 --no-session：可 auto-compact / steer / 续用）
    args = ['--mode', 'rpc', '--provider', provider, '--model', model,
            '--thinking', thinking,
            '--session-dir', path.join(cwd || '.', 'sessions'),
            '--session-id', sessionId, '--name', name || 'agent'];
    try { fs.appendFileSync(path.join(__dirname, '..', 'logs', 'spawn-debug.log'),
      `[${new Date().toISOString()}] session ${sessionId} reused=${reuse.reused} (${reuse.reason}) agent=${name} task=${opts.taskName || ''}\n`); } catch (e) {}
    if (opts.ephemeral) args.push('--no-session');
    child = spawnCmd(PI, args, {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    // pi RPC 官方协议（已在 distill-v3 验证）：3 秒后直接发 prompt，不等 READY
    setTimeout(() => {
      const ok = sendRPC(child, { type: 'prompt', message: prompt, id: 'p-' + Date.now(), streamingBehavior: 'steer' });
      try { fs.appendFileSync(path.join(__dirname, '..', 'logs', 'spawn-debug.log'),
        `[${new Date().toISOString()}] sendRPC ${ok ? 'OK' : 'FAILED'} name=${name} killed=${child.killed} stdinDestroyed=${child.stdin.destroyed}\n`); } catch (e) {}
    }, 3000);
  } else if (type === 'hermes') {
    // HK Hermes 平台网关智能体（spawnType: hermes）：
    // 本地 lib/hermes-run.js 经 SSH 驱动 HK 上 hermes chat -q 单次执行，
    // 完成回写 .DONE（HK 凭据在 /etc/xxsx-hermes/org.env，root 600，不落本地）
    const hermesRun = path.join(__dirname, 'hermes-run.js');
    const doneMarker = opts.donePath || path.join(path.dirname(__dirname), 'inbox', `${(name || 'task').replace(/[^a-zA-Z0-9_-]/g, '_')}.DONE`);
    args = [hermesRun, '--done', doneMarker];
    if (log) args.push('--log', log);
    if (opts.model) args.push('--model', opts.model);
    child = spawn(process.execPath, args, {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    // 任务内容经 stdin 传入（与 claude/pi 同风格）
    setTimeout(() => {
      try { child.stdin.write(prompt + '\n'); child.stdin.end(); } catch (e) {}
    }, 1000);
  } else if (type === 'node') {
    // 管家分身：spawn 一个新的 butler 进程（--spawn <group> 或直接处理任务）
    const butlerPath = path.join(__dirname, '..', 'butler.js');
    const groupId = opts.groupId || '';
    args = [butlerPath, ...(groupId ? ['--spawn', groupId] : [])];
    child = spawn(process.execPath, args, {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    // 任务内容通过 inbox 投递（butler 分身扫 inbox 处理），这里确保 inbox 存在
    try {
      const inboxDir = path.join(path.dirname(butlerPath), 'inbox');
      if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true });
      const taskName = (name || 'task').replace(/[^a-zA-Z0-9_-]/g, '_');
      fs.writeFileSync(path.join(inboxDir, `${taskName}.md`), prompt, 'utf8');
    } catch (e) {}
  } else {
    // 未知 spawn type：不 throw（2026-08-13 防崩管家——chatroom 等专用执行器类型任务不应杀死 butler）
    try { fs.appendFileSync(path.join(__dirname, '..', 'logs', 'spawn-debug.log'),
      `[${new Date().toISOString()}] UNKNOWN-SPAWN-TYPE type=${type} name=${name || '?'} donePath=${opts.donePath || '-'}\n`); } catch (_) {}
    if (opts.donePath) {
      try { fs.writeFileSync(opts.donePath, `.FAILED: 未知 spawn type ${type}（该类型由专用执行器处理，butler 不派发）`, 'utf8'); } catch (_) {}
    }
    const { EventEmitter } = require('events');
    child = new EventEmitter();
    child.pid = 0;
    child.stdin = { write() {}, end() {}, destroy() {} };
    child.stdout = { pipe() {}, on() {} };
    child.stderr = { pipe() {}, on() {} };
    process.nextTick(() => child.emit('exit', 1)); // 触发 butler 收尾（写 .FAILED 兜底）
  }

  // 防御：spawn 失败不崩管家（2026-08-13）
  child = armErrorGuard(child, opts);
  // 流式日志
  if (log) {
    const logStream = fs.createWriteStream(log, { flags: 'a' });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
  }

  return child;
}

function sendRPC(child, obj) {
  if (!child || child.killed || child.stdin.destroyed) return false;
  try { child.stdin.write(JSON.stringify(obj) + '\n'); return true; }
  catch (e) {
    try { fs.appendFileSync(path.join(__dirname, '..', 'logs', 'spawn-debug.log'),
      `[${new Date().toISOString()}] sendRPC ERROR: ${e.message}\n`); } catch (_) {}
    return false;
  }
}

module.exports = { spawnAgent, sendRPC };
