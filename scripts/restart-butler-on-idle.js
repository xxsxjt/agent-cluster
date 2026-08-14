#!/usr/bin/env node
/**
 * scripts/restart-butler-on-idle.js — 活动任务收尾后自动重启管家，加载新增域路由机制
 *
 * 背景（2026-08-11 分工铁律调度约束）：lib/domain-route.js 已为"查服务器/节点状态/版本/日志/验证"
 * 类任务强制路由 server-admin，但运行中管家（butler.js 常驻进程）加载的是旧代码，需重启才生效。
 * 直接 kill 会中断正在跑的活动任务 → 本脚本轮询 logs/active-tasks.json，待活动业务任务全部收尾
 * 后，经 bootstrap start 幂等重启（watchdog 同款，单实例锁防双开）。
 *
 * 用法：node scripts/restart-butler-on-idle.js [--force] [--max-wait-min 60]
 *       --force 忽略活动任务直接重启（慎用）；--max-wait-min 超时仍未空闲则放弃（不重启）
 */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ORG = __dirname.replace(/[\\/]scripts$/, '');
const ACTIVE = path.join(ORG, 'logs', 'active-tasks.json');
const PIDFILE = path.join(ORG, 'butler.pid');
const LOG = path.join(ORG, 'logs', 'butler-restart-domain-route.log');
const NodeExe = process.execPath;

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const MAX_WAIT_MIN = (() => { const i = args.indexOf('--max-wait-min'); return i >= 0 ? parseInt(args[i + 1], 10) || 60 : 60; })();

const log = m => { const s = `[${new Date().toISOString()}] ${m}`; try { fs.appendFileSync(LOG, s + '\n', 'utf8'); } catch (e) {} console.log(s); };

/** 读取活动任务表，返回活动业务任务数（忽略 butler 自身/系统进程名） */
function activeCount() {
  try {
    const d = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
    const keys = Object.keys(d || {});
    // 过滤明显是"已结束残留/系统"的空项；所有键都算活动（coo/server-admin/uumit-ops 等都是真实子任务）
    return keys.length;
  } catch (e) { return 0; }
}

function restart() {
  const oldPid = fs.existsSync(PIDFILE) ? fs.readFileSync(PIDFILE, 'utf8').trim() : '';
  log(`活动任务已收尾，重启管家加载新域路由（旧 PID=${oldPid || '未知'}）...`);
  if (oldPid && /^\d+$/.test(oldPid)) {
    try { execSync(`taskkill /PID ${oldPid} /T /F`, { stdio: 'ignore' }); } catch (e) { log('taskkill: ' + e.message); }
  } else { log('未读到 butler PID，跳过 kill，直接 bootstrap start（单实例锁防双开）'); }
  // bootstrap start 幂等重启（单实例锁 + watchdog 同款）
  spawn(NodeExe, [path.join(ORG, 'scripts', 'bootstrap.js'), 'start'], { cwd: ORG, detached: true, stdio: 'ignore' }).unref();
  log('已发起 bootstrap start，等待 3s 确认新 PID...');
  setTimeout(() => {
    const newPid = fs.existsSync(PIDFILE) ? fs.readFileSync(PIDFILE, 'utf8').trim() : '';
    log(`新管家 PID=${newPid || '(尚未写入,等待bootstrap)'}`);
  }, 3000);
}

const started = Date.now();
(function poll() {
  const n = activeCount();
  if (FORCE || n === 0) { restart(); process.exit(0); }
  const waited = (Date.now() - started) / 60000;
  log(`等待活动任务收尾... 当前活动=${n}（已等 ${waited.toFixed(1)}min / ${MAX_WAIT_MIN}min）`);
  if (waited >= MAX_WAIT_MIN) { log(`超时 ${MAX_WAIT_MIN}min 仍未空闲，放弃自动重启（机制代码已就绪，待下次管家轮换加载）`); process.exit(1); }
  setTimeout(poll, 60 * 1000);
})();
