#!/usr/bin/env node
/**
 * 智能体集群（Agent Cluster）· bootstrap — 管家服务统一管理入口
 *
 * 用法：
 *   node scripts/bootstrap.js start     # 启动管家（后台，隐藏窗口）
 *   node scripts/bootstrap.js stop      # 停止管家
 *   node scripts/bootstrap.js status    # 查看状态
 *   node scripts/bootstrap.js restart   # 重启
 *   node scripts/bootstrap.js twin start|stop|status   # 分身常驻进程管理（v5.1）
 *   node scripts/bootstrap.js twin console            # 前台直接对话分身
 *   node scripts/bootstrap.js web start|stop|status|lan  # web 控制台管理
 *   node scripts/bootstrap.js install   # 注册开机自启（Windows 任务计划 / Linux systemd）
 *   node scripts/bootstrap.js uninstall # 移除自启 + 停止
 *
 * 供 scripts/install.ps1 与 scripts/install.sh 调用，逻辑单点维护。
 */
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUTLER = path.join(ROOT, 'butler.js');
const PID_FILE = path.join(ROOT, 'butler.pid');
const LOGS = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOGS, 'butler.log');
const TASK_NAME = 'pi-xuwu-boot-butler';
const WEB_DIR = path.join(ROOT, 'web');
const WEB_SERVER = path.join(WEB_DIR, 'server.js');
const WEB_PID_FILE = path.join(LOGS, 'web.pid');
const WEB_LOG = path.join(LOGS, 'web.log');
const WEB_PORT = process.env.XUWU_WEB_PORT || 8787;
const TWIN_DAEMON = path.join(ROOT, 'lib', 'twin-daemon.js');
const TWIN_PID_FILE = path.join(ROOT, 'twin.pid');
const TWIN_LOG = path.join(LOGS, 'twin-daemon.log');
const TWIN_TASK_NAME = 'pi-xuwu-boot-twin';
const NODE = process.execPath;

/* 集群对话鉴权令牌配置：config/cluster-chat-token.json
 *  - clusterToken: /api/cluster/chat 独立令牌（HK new-api AssistantTwinToken 与此一致） */
function clusterAuthConfig() {
  const p = path.join(ROOT, 'config', 'cluster-chat-token.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (e) { return {}; }
}


const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux' || process.platform === 'darwin';

function log(msg) {
  const line = `[集群 · ${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
}

function readPid() {
  try { return parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10); }
  catch (e) { return null; }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    if (isWin) {
      // 关键修复：tasklist 即使无匹配也返回退出码 0，不能只凭退出码判断。
      // 必须解析输出，确认该 PID 真实存在于输出中（否则死 PID 会被误判为存活，
      // 导致 watchdog 调 bootstrap start 永远被“已在运行”挡住、管家崩溃后拉不起）。
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { stdio: 'pipe', windowsHide: true, encoding: 'utf8' });
      // CSV 行："node.exe","46092","Console","1","153,208 K" → 匹配 ","46092","
      return out.includes(`"${pid}"`);
    } else {
      process.kill(pid, 0);
      return true;
    }
  } catch (e) { return false; }
}

function ensureLogs() { fs.mkdirSync(LOGS, { recursive: true }); }

function start() {
  ensureLogs();
  const existing = readPid();
  if (existing && isAlive(existing)) {
    log(`管家已在运行 (PID=${existing})，无需重复启动`);
    return;
  }
  try { fs.unlinkSync(PID_FILE); } catch (e) {}
  if (isWin) {
    // Windows：用 Start-Process 真正脱离父进程（detached）+ 隐藏窗口
    const ps = [
      `$p = Start-Process -FilePath '${NODE}' -ArgumentList '${BUTLER}' -WorkingDirectory '${ROOT}' ` +
      `-WindowStyle Hidden -PassThru`,
      `Write-Output $p.Id`
    ].join('; ');
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'pipe', windowsHide: true, encoding: 'utf8' });
      const pid = parseInt(out.trim().split(/\r?\n/).pop(), 10);
      if (pid && isAlive(pid)) {
        fs.writeFileSync(PID_FILE, String(pid), 'utf8');
        log(`管家已启动 (PID=${pid})，日志: logs/butler.log`);
        return;
      }
    } catch (e) {
      log(`启动失败: ${e.message}`);
      return;
    }
  } else {
    const child = spawn(NODE, [BUTLER], {
      cwd: ROOT,
      stdio: ['ignore', fs.openSync(LOG_FILE, 'a'), fs.openSync(LOG_FILE, 'a')],
      detached: true,
      windowsHide: true
    });
    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
    log(`管家已启动 (PID=${child.pid})，日志: logs/butler.log`);
  }
}

function stop() {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    log('管家未在运行');
    try { fs.unlinkSync(PID_FILE); } catch (e) {}
    return;
  }
  try {
    if (isWin) execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'pipe', windowsHide: true });
    else process.kill(pid, 'SIGTERM');
    log(`管家已停止 (PID=${pid})`);
  } catch (e) {
    log(`停止失败: ${e.message}`);
  }
  try { fs.unlinkSync(PID_FILE); } catch (e) {}
}

function status() {
  const pid = readPid();
  if (pid && isAlive(pid)) {
    log(`🟢 运行中 (PID=${pid})`);
  } else {
    log('⚪ 未运行');
  }
  // 自启状态
  if (isWin) {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue).State`], { stdio: 'pipe', windowsHide: true, encoding: 'utf8' });
      const state = out.trim();
      log(`自启任务: ${state === 'Ready' ? '✅ Ready' : '⚠️ ' + state}`);
    } catch (e) {
      log('自启任务: ❌ 未注册');
    }
  } else {
    const unit = '/etc/systemd/system/xuwu-butler.service';
    log(`自启服务: ${fs.existsSync(unit) ? '✅ 已安装' : '❌ 未安装'}`);
  }
}

function install() {
  ensureLogs();
  if (isWin) {
    // Windows：任务计划（登录时启动，隐藏窗口）——管家 + 分身常驻两个任务
    const reg = (task, script, desc) => {
      const ps = [
        `$action = New-ScheduledTaskAction -Execute '${NODE}' -Argument '${script}' -WorkingDirectory '${ROOT}'`,
        `$trigger = New-ScheduledTaskTrigger -AtLogOn`,
        `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)`,
        `Register-ScheduledTask -TaskName '${task}' -Action $action -Trigger $trigger -Settings $settings -Description '${desc}' -Force | Out-Null`,
        `Write-Output 'OK'`
      ].join('; ');
      execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'pipe', windowsHide: true, encoding: 'utf8' });
    };
    try {
      reg(TASK_NAME, BUTLER, '智能体集群管家 butler.js 登录自启');
      log(`开机自启已注册（任务计划 ${TASK_NAME}）`);
    } catch (e) {
      log(`管家自启注册失败: ${e.message}`);
    }
    try {
      reg(TWIN_TASK_NAME, TWIN_DAEMON, '智能体集群分身(虚无圣灵) twin-daemon.js 登录自启');
      log(`分身自启已注册（任务计划 ${TWIN_TASK_NAME}）`);
    } catch (e) {
      // 非管理员环境任务计划被拒 → 回退 HKCU Run（普通用户可写，效果等同登录自启）
      try {
        const runCmd = `\"${NODE}\" \"${TWIN_DAEMON}\"`;
        execFileSync('reg.exe', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
          '/v', TWIN_TASK_NAME, '/t', 'REG_SZ', '/d', runCmd, '/f'],
          { stdio: 'pipe', windowsHide: true, encoding: 'utf8' });
        log(`分身自启已注册（HKCU Run 兜底，任务计划权限不足: ${e.message.slice(0, 60)}）`);
      } catch (e2) {
        log(`分身自启注册失败: ${e2.message.slice(0, 80)}`);
      }
    }
  } else if (isLinux) {
    // Linux/macOS：systemd user 单元
    const unit = path.join(process.env.HOME || '/root', '.config', 'systemd', 'user', 'xuwu-butler.service');
    const content = `[Unit]\nDescription=Agent Cluster Butler (智能体集群管家)\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${ROOT}\nExecStart=${NODE} ${BUTLER}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
    try {
      fs.mkdirSync(path.dirname(unit), { recursive: true });
      fs.writeFileSync(unit, content, 'utf8');
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
      execFileSync('systemctl', ['--user', 'enable', 'xuwu-butler.service'], { stdio: 'pipe' });
      log(`开机自启已注册（systemd user 单元）`);
    } catch (e) {
      log(`注册失败: ${e.message}`);
    }
  }
}

function uninstall() {
  stop();
  twinStop();
  if (isWin) {
    for (const tn of [TASK_NAME, TWIN_TASK_NAME]) {
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-Command', `Unregister-ScheduledTask -TaskName '${tn}' -Confirm:$false -ErrorAction SilentlyContinue`], { stdio: 'pipe', windowsHide: true });
        log(`自启任务 ${tn} 已移除`);
      } catch (e) { log(`自启任务 ${tn} 移除失败（可能不存在）`); }
      // HKCU Run 兑底键一并清理
      try {
        execFileSync('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', tn, '/f'], { stdio: 'pipe', windowsHide: true });
      } catch (e) {}
    }
  } else if (isLinux) {
    try {
      const unit = path.join(process.env.HOME || '/root', '.config', 'systemd', 'user', 'xuwu-butler.service');
      if (fs.existsSync(unit)) {
        execFileSync('systemctl', ['--user', 'disable', 'xuwu-butler.service'], { stdio: 'pipe' });
        fs.unlinkSync(unit);
        log('systemd 单元已移除');
      }
    } catch (e) { log('移除失败'); }
  }
}

function webStart(host) {
  ensureLogs();
  const existing = readPidFile(WEB_PID_FILE);
  if (existing && isAlive(existing)) {
    log(`web 控制台已在运行 (PID=${existing}) → http://127.0.0.1:${WEB_PORT}/`);
    return;
  }
  // 智能体集群：web 控制台监听 0.0.0.0（经 Tailscale 供 HK 服务器转发分身对话）。
  // 启用集群对话独立令牌（PI_CLUSTER_TOKEN，保护 /api/cluster/chat）；
  // 不加全局 --token（保持用户现有 web 控制台访问方式不变）。
  const hostArg = '0.0.0.0'; // Tailscale 网段（HK→本机 100.103.204.86:8787）需 0.0.0.0
  const clusterCfg = clusterAuthConfig();
  const env = Object.assign({}, process.env);
  const clusterToken = typeof clusterCfg.clusterToken === 'string' ? clusterCfg.clusterToken.trim() : '';
  if (clusterToken) env.PI_CLUSTER_TOKEN = clusterToken;
  const args = [WEB_SERVER, '--port', String(WEB_PORT), '--host', hostArg];
  const child = spawn(NODE, args, {
    cwd: WEB_DIR,
    env,
    stdio: ['ignore', fs.openSync(WEB_LOG, 'a'), fs.openSync(WEB_LOG, 'a')],
    detached: true,
    windowsHide: true
  });
  child.unref();
  fs.writeFileSync(WEB_PID_FILE, String(child.pid), 'utf8');
  log(`web 控制台已启动 (PID=${child.pid}) → http://${hostArg}:${WEB_PORT}/ (cluster-token=${clusterToken ? 'on' : 'off'})`);
}

function webStop() {
  const pid = readPidFile(WEB_PID_FILE);
  if (!pid || !isAlive(pid)) { log('web 控制台未在运行'); try { fs.unlinkSync(WEB_PID_FILE); } catch (e) {} return; }
  try {
    if (isWin) execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'pipe', windowsHide: true });
    else process.kill(pid, 'SIGTERM');
    log(`web 控制台已停止 (PID=${pid})`);
  } catch (e) { log(`停止失败: ${e.message}`); }
  try { fs.unlinkSync(WEB_PID_FILE); } catch (e) {}
}

function webStatus() {
  const pid = readPidFile(WEB_PID_FILE);
  log(pid && isAlive(pid) ? `🟢 web 控制台运行中 (PID=${pid}) → http://127.0.0.1:${WEB_PORT}/` : '⚪ web 控制台未运行');
}

function readPidFile(fp) {
  try { return parseInt(fs.readFileSync(fp, 'utf8').trim(), 10); } catch (e) { return null; }
}

/* ── 分身常驻进程（twin-daemon） ──────────────────────────
 * 同一套 detached + hidden 方案，独立 PID 文件（twin.pid），
 * 与管家（butler.pid）互不干扰。 */
function twinStart() {
  ensureLogs();
  const existing = readPidFile(TWIN_PID_FILE);
  if (existing && isAlive(existing)) {
    log(`分身已在运行 (PID=${existing})，无需重复启动`);
    return;
  }
  try { fs.unlinkSync(TWIN_PID_FILE); } catch (e) {}
  if (isWin) {
    const ps = [
      `$p = Start-Process -FilePath '${NODE}' -ArgumentList '${TWIN_DAEMON}' -WorkingDirectory '${ROOT}' ` +
      `-WindowStyle Hidden -PassThru`,
      `Write-Output $p.Id`
    ].join('; ');
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'pipe', windowsHide: true, encoding: 'utf8' });
      const pid = parseInt(out.trim().split(/\r?\n/).pop(), 10);
      if (pid && isAlive(pid)) {
        fs.writeFileSync(TWIN_PID_FILE, String(pid), 'utf8');
        log(`分身已启动 (PID=${pid})，日志: logs/twin-daemon.log，足迹: agents/twin/activity.log`);
        return;
      }
    } catch (e) {
      log(`分身启动失败: ${e.message}`);
      return;
    }
  } else {
    const child = spawn(NODE, [TWIN_DAEMON], {
      cwd: ROOT,
      stdio: ['ignore', fs.openSync(TWIN_LOG, 'a'), fs.openSync(TWIN_LOG, 'a')],
      detached: true,
      windowsHide: true
    });
    child.unref();
    fs.writeFileSync(TWIN_PID_FILE, String(child.pid), 'utf8');
    log(`分身已启动 (PID=${child.pid})`);
  }
}

function twinStop() {
  const pid = readPidFile(TWIN_PID_FILE);
  if (!pid || !isAlive(pid)) {
    log('分身未在运行');
    try { fs.unlinkSync(TWIN_PID_FILE); } catch (e) {}
    return;
  }
  try {
    if (isWin) execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'pipe', windowsHide: true });
    else process.kill(pid, 'SIGTERM');
    log(`分身已停止 (PID=${pid})`);
  } catch (e) {
    log(`停止失败: ${e.message}`);
  }
  try { fs.unlinkSync(TWIN_PID_FILE); } catch (e) {}
}

function twinStatus() {
  const pid = readPidFile(TWIN_PID_FILE);
  if (pid && isAlive(pid)) {
    log(`🟢 分身常驻运行中 (PID=${pid})`);
    // 读 activity.log 最近一条
    try {
      const act = require(path.join(ROOT, 'lib', 'twin-log.js')).readActivity(3);
      if (act.lines && act.lines.length) {
        const last = act.lines[act.lines.length - 1];
        log(`   最近足迹: [${last.ts}] [${last.tag}] ${last.text}`);
      }
    } catch (e) {}
  } else {
    log('⚪ 分身未运行');
  }
  if (isWin) {
    const autostart = twinAutostartState();
    log(`分身自启任务: ${autostart.state === 'Ready' ? '✅ Ready' : '⚠️ ' + autostart.state}` +
        (autostart.viaRunKey ? '（HKCU Run）' : ''));
  }
}

/** Windows 自启状态：计划任务优先，HKCU Run 注册表兜底 */
function twinAutostartState() {
  let state = '';
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-ScheduledTask -TaskName '${TWIN_TASK_NAME}' -ErrorAction SilentlyContinue).State`], { stdio: 'pipe', windowsHide: true, encoding: 'utf8' });
    state = out.trim();
    if (state) return { state, viaRunKey: false };
  } catch (e) {}
  try {
    const out = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', TWIN_TASK_NAME], { stdio: 'pipe', windowsHide: true, encoding: 'utf8' });
    if (/pi-xuwu-boot-twin/.test(out)) return { state: 'Ready', viaRunKey: true };
  } catch (e) {}
  return { state: '❌ 未注册', viaRunKey: false };
}

/** 前台对话模式：直接跑 twin-daemon --console（阻塞，Ctrl+C 退出） */
function twinConsole() {
  const pid = readPidFile(TWIN_PID_FILE);
  if (pid && isAlive(pid)) {
    log(`⚠ 分身常驻已在后台运行 (PID=${pid})，前台模式会抢不到锁。建议：`);
    log(`   node scripts/bootstrap.js twin stop   # 先停后台`);
    log(`   或直接访问 web 控制台对话（http://127.0.0.1:${WEB_PORT}/）`);
    return;
  }
  log('进入分身对话模式（Ctrl+C 退出）…');
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [TWIN_DAEMON, '--console'], {
    cwd: ROOT, stdio: 'inherit', windowsHide: false
  });
  child.on('exit', c => process.exit(c || 0));
}

const cmd = process.argv[2] || 'status';
switch (cmd) {
  case 'start': start(); break;
  case 'stop': stop(); break;
  case 'restart': stop(); start(); break;
  case 'status': status(); break;
  case 'install': install(); break;
  case 'uninstall': uninstall(); break;
  case 'web':
    const sub = process.argv[3] || 'start';
    if (sub === 'stop') webStop();
    else if (sub === 'status') webStatus();
    else webStart(sub === 'lan' ? 'lan' : 'local');
    break;
  case 'twin':
    const tsub = process.argv[3] || 'start';
    if (tsub === 'stop') twinStop();
    else if (tsub === 'status') twinStatus();
    else if (tsub === 'console') twinConsole();
    else if (tsub === 'restart') { twinStop(); setTimeout(twinStart, 800); }
    else twinStart();
    break;
  default:
    console.log('用法: node scripts/bootstrap.js <start|stop|status|restart|install|uninstall|web [start|stop|status|lan]|twin [start|stop|status|console|restart]>');
    process.exit(1);
}