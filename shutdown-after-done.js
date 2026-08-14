// 虚无框架 · 完成即关机守护（2026-08-05 夜间启用）
// 规则：inbox 所有 .md 任务都有 .DONE/.FAILED 标记 → 120 秒后关机
// 安全阀：未完成任务日志 90 分钟无更新 = 卡死，也执行关机（记录原因）
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
// 环境变量覆盖（web 端 selftest 用：指向临时 inbox + echo 假关机命令，避免误关真机）
const INBOX = process.env.XUWU_INBOX || path.join(__dirname, 'inbox');
const LOGS = process.env.XUWU_LOGS || path.join(__dirname, 'logs');
const LOG = process.env.XUWU_LOG || path.join(LOGS, 'shutdown-watch.log');
const SHUTDOWN_CMD = process.env.XUWU_SHUTDOWN_CMD || 'shutdown /s /t 120 /c "XuWu: tasks done, shutting down"';
const GRACE_MS = parseInt(process.env.XUWU_GRACE_MS || '120000', 10);
const STALL_MS = 90 * 60 * 1000;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch (e) {}
}

function check() {
  const mds = fs.readdirSync(INBOX).filter(f => f.endsWith('.md'));
  let pending = [], done = 0, failed = 0;
  for (const f of mds) {
    const name = f.replace(/\.md$/, '');
    if (fs.existsSync(path.join(INBOX, name + '.DONE'))) {
      if (fs.readFileSync(path.join(INBOX, name + '.DONE'), 'utf8').includes('.FAILED')) failed++;
      else done++;
    } else pending.push(name);
  }
  if (pending.length === 0) {
    log(`全部任务终结（完成 ${done} / 失败 ${failed}）→ ${Math.round(GRACE_MS / 1000)} 秒后关机`);
    shutdown(`全部任务完成（${done} 成 / ${failed} 败）`);
    return true;
  }
  // 孤儿任务检测：active-tasks.json 记录的进程已死（但管家崩溃残留）→ 立即标记失败，不等卡死时间
  const AT = path.join(__dirname, 'logs', 'active-tasks.json');
  try {
    const at = JSON.parse(fs.readFileSync(AT, 'utf8'));
    for (const name of pending) {
      const t = at[name];
      if (!t || !t.pid) continue;
      let alive = true;
      try { process.kill(t.pid, 0); } catch (e) { alive = false; }
      if (!alive) {
        try {
          fs.writeFileSync(path.join(INBOX, name + '.DONE'),
            '.FAILED: 孤儿任务（进程 ' + t.pid + ' 已死，疑似但管家崩溃残留）', 'utf8');
        } catch (e) {}
        log(`孤儿任务标记失败: ${name}（pid ${t.pid} 已死）`);
      }
    }
  } catch (e) {}
  // 重新计算 pending（孤儿已标记）
  pending = []; done = 0; failed = 0;
  for (const f of mds) {
    const name = f.replace(/\.md$/, '');
    if (fs.existsSync(path.join(INBOX, name + '.DONE'))) {
      if (fs.readFileSync(path.join(INBOX, name + '.DONE'), 'utf8').includes('.FAILED')) failed++;
      else done++;
    } else pending.push(name);
  }
  // 卡死检测
  const stalled = pending.filter(name => {
    const lg = path.join(LOGS, name + '.log');
    try { return Date.now() - fs.statSync(lg).mtimeMs > STALL_MS; }
    catch (e) { return true; }
  });
  if (stalled.length === pending.length) {
    log(`未完成任务全部卡死 90 分钟（${stalled.join(',')}）→ ${Math.round(GRACE_MS / 1000)} 秒后关机`);
    shutdown(`任务卡死保护关机（${stalled.join(',')}）`);
    return true;
  }
  log(`进行中: ${pending.join(',')}（完成 ${done} / 失败 ${failed}）`);
  return false;
}

function shutdown(reason) {
  try { fs.writeFileSync(path.join(__dirname, 'LAST_SHUTDOWN_NOTE.txt'),
    `关机原因: ${reason}\n时间: ${new Date().toISOString()}\n`, 'utf8'); } catch (e) {}
  log(`执行关机命令: ${SHUTDOWN_CMD}`);
  exec(SHUTDOWN_CMD, err => { if (err) log('关机命令返回: ' + err.message); });
}

log('=== 完成即关机守护启动 ===');
// 首次 check 也要包 try：若读 inbox 抛异常（文件占用等）直接崩溃会导致不关机（2026-08-07 实测教训）
try {
  if (!check()) setInterval(() => { try { check(); } catch (e) { log('check error: ' + e.message); } }, 60 * 1000);
} catch (e) {
  log('首次 check 异常（10 秒后重试）: ' + e.message);
  setTimeout(() => { try { if (!check()) setInterval(() => { try { check(); } catch (e2) { log('check error: ' + e2.message); } }, 60 * 1000); } catch (e3) { log('重试仍失败: ' + e3.message); } }, 10000);
}
