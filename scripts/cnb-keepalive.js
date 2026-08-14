#!/usr/bin/env node
/**
 * cnb-keepalive.js — CNB 云开发空间保活心跳（本机侧，仿 HK cnb-keepalive）
 *
 * 背景（2026-08-11 cnb-sync-p0）：CNB 云空间闲置 10 分钟回收 / 心跳最长 18h / 凌晨 4-6 点强制回收。
 * HK 服务器当前不可达（临时），保活临时由本机承担；HK 恢复后部署 HK 侧（root 600，24/7）。
 *
 * 每 2 分钟：
 *   1. API 查三空间状态
 *   2. running → SSH 心跳（增强活跃心跳，防 10 分钟闲置回收）
 *   3. closed → 若不在凌晨 4-6 强制回收窗口 → 调 start 自动拉起 + 轮询 running + 记录新 SSH
 *   4. 凌晨 4-6 点连续失败 3 次 → 暂停到 6 点后（避免无限重启）
 *   5. 记录实例 sn 与重建周期（state.lastSn/rebuildAt）——用于观察 CNB 真实回收频率
 *
 * ⚠️ 2026-08-12 保活加固：CNB 无平台级持久盘（stash/backup/restore API 均不存在），
 *    /data 属容器本地盘，实例仍会被强制回收（闲置约 10min / 凌晨 4-6 / 实例生命周期上限）。
 *    保活只能缓解"闲置回收"，无法规避强制回收——真正兜底靠"回收自愈 + 环境镜像快恢复"
 *    （见 cnb-task.js 自愈 + cnb-env-image.sh）。本脚本聚焦：调高频率 + 增强活跃心跳。
 *
 * 用法：
 *   node scripts/cnb-keepalive.js            # 单次保活轮询
 *   node scripts/cnb-keepalive.js --loop     # 循环（每 2 分钟一次）
 *   node scripts/cnb-keepalive.js --status   # 打印三空间状态
 *
 * token 从 DPAPI 加密仓读（cnb_git_token）；SSH key ~/.ssh/id_rsa_cnb。不落明文。
 */
'use strict';
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const API = 'https://api.cnb.cool';
const KEY = path.join(os.homedir(), '.ssh', 'id_rsa_cnb');
const ORG_ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(ORG_ROOT, 'logs', 'cnb-keepalive.log');
const STATE_FILE = path.join(ORG_ROOT, 'logs', 'cnb-keepalive-state.json');

const SPACES = {
  '1': { slug: 'xxssxx.top/1', note: '开发主力' },
  '2': { slug: 'xxssxx.top/2', note: '构建机' },
  '3': { slug: 'xxssxx.top/3', note: '测试沙箱' },
};
const LOOP_INTERVAL_MS = 2 * 60 * 1000; // 2026-08-12 加固：5min→2min（贴近 10min 闲置回收阈值，留 5 倍余量）
// 凌晨 4-6 点强制回收窗口
function inForcedWindow() {
  const h = new Date().getHours();
  return h >= 4 && h < 6;
}

function getToken() {
  try {
    return execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-Command', "& 'C:\\_dx\\_serve\\set-cred.ps1' -Get -Name cnb_git_token",
    ], { encoding: 'utf8', maxBuffer: 64 * 1024, windowsHide: true }).trim();
  } catch (e) { throw new Error('读 cnb_git_token 失败: ' + e.message); }
}
function httpGet(url, token) {
  return JSON.parse(execFileSync('curl', ['-s', '-H', `Authorization: Bearer ${token}`, url], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true }));
}
function httpPost(url, token, body) {
  const a = ['-s', '-X', 'POST', '-H', `Authorization: Bearer ${token}`, '-H', 'Content-Type: application/json', '-d', JSON.stringify(body), url];
  return JSON.parse(execFileSync('curl', a, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true }));
}
function log(msg) {
  const line = `[${new Date().toLocaleString()}] [cnb-keepalive] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) {}
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function writeState(s) {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8'); } catch (e) {}
}
function listWs(token, slug) {
  const d = httpGet(`${API}/workspace/list`, token);
  const list = (d.list || []).filter(w => w.slug === slug);
  list.sort((a, b) => (b.create_time || '').localeCompare(a.create_time || ''));
  return list;
}
function latestRunning(token, slug) {
  return listWs(token, slug).find(w => w.status === 'running') || null;
}
function sshHeartbeat(host) {
  // 2026-08-12 加固：纯 touch /tmp 可能不触发 CNB"活跃"判定（观察显示实例仍被回收）。
  // 增强为执行一段真实命令（短 CPU/IO 活动 + 心跳写盘），最大化命中"有操作"判定。
  // 同时 echo 实例 hostname/sn 便于日志核对。命令整体 <8s，不构成真实负载。
  try {
    execFileSync('ssh', ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new', '-4', host,
      'd=$(date +%s%N); for i in $(seq 1 200); do echo $((i*2)) >/dev/null; done; e=$(date +%s%N); echo "hb $(hostname) $(( (e-d)/1000000 ))ms $(date +%T)" >> /tmp/cnb-keepalive-hb'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return true;
  } catch (e) { return false; }
}

async function keepAliveOnce(token, state) {
  for (const [n, sp] of Object.entries(SPACES)) {
    const s = state[n] || { failCount: 0, pausedUntil: 0 };
    // 暂停期跳过
    if (s.pausedUntil && Date.now() < s.pausedUntil) {
      log(`空间${n} 暂停中（到 ${new Date(s.pausedUntil).toLocaleString()}）`);
      continue;
    }
    const running = latestRunning(token, sp.slug);
    if (running) {
      // 记录实例重建（sn 变化）与回收周期——供观察 CNB 真实回收频率（防回收策略依据）
      if (s.lastSn && s.lastSn !== running.sn) {
        if (s.lastSnAt) {
          const cyc = Math.round((Date.now() - s.lastSnAt) / 60000);
          log(`空间${n} ⚠️ 实例已重建 ${s.lastSn} → ${running.sn}（距上次 ${cyc} 分钟）`);
        } else { log(`空间${n} ⚠️ 实例已重建 ${s.lastSn} → ${running.sn}`); }
      }
      s.lastSn = running.sn;
      s.lastSnAt = Date.now();
      // 心跳：从 detail 拿最新 SSH host 并执行增强活跃心跳（保活，防闲置回收）
      try {
        const detail = httpGet(`${API}/${sp.slug}/-/workspace/detail/${running.sn}`, token);
        let host = (detail && (detail.sshHost || detail.ssh || detail.host) || running.pipeline_id || '').replace(/^\s*ssh\s+/, '').trim();
        if (host) {
          const ok = sshHeartbeat(host);
          log(`空间${n}(${running.sn}) running → 心跳 ${ok ? '✅' : '❌'} ${host}`);
          if (ok) { s.failCount = 0; s.heartbeatAt = Date.now(); }
        } else {
          log(`空间${n} running 但拿不到 SSH host（sn=${running.sn}）`);
        }
      } catch (e) {
        log(`空间${n} 心跳异常: ${e.message.slice(0, 120)}`);
      }
    } else {
      // closed → 自动拉起（凌晨 4-6 强制回收窗口内不无限重启）
      if (inForcedWindow()) {
        s.failCount = (s.failCount || 0) + 1;
        log(`空间${n} closed，凌晨 4-6 强制回收窗口，跳过（failCount=${s.failCount}）`);
        if (s.failCount >= 3) {
          const until = new Date(); until.setHours(6, 5, 0, 0);
          s.pausedUntil = until.getTime();
          log(`空间${n} 窗口内失败 3 次 → 暂停到 ${until.toLocaleString()}`);
          s.failCount = 0;
        }
      } else {
        try {
          const resp = httpPost(`${API}/${sp.slug}/-/workspace/start`, token, { branch: 'main' });
          if (resp && resp.sn) {
            log(`空间${n} closed → 已提交启动 ${resp.sn}，等 running…`);
            s.startingAt = Date.now();
          } else {
            log(`空间${n} 启动失败: ${resp.errmsg || JSON.stringify(resp)}`);
            s.failCount = (s.failCount || 0) + 1;
          }
        } catch (e) {
          s.failCount = (s.failCount || 0) + 1;
          log(`空间${n} 启动异常: ${e.message.slice(0, 120)}`);
        }
      }
    }
    state[n] = s;
  }
  writeState(state);
}

function status(token) {
  for (const [n, sp] of Object.entries(SPACES)) {
    const l = listWs(token, sp.slug);
    const run = l.filter(w => w.status === 'running');
    console.log(`空间${n} (${sp.note}): ${run.length} running / ${l.length} 实例; latest=${l[0] ? l[0].sn + ' (' + l[0].status + ')' : '-'}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const token = getToken();
  const state = readState();
  if (argv.includes('--status')) { status(token); process.exit(0); }

  const runOnce = async () => {
    try { await keepAliveOnce(token, state); }
    catch (e) { log(`轮询异常: ${e.message.slice(0, 160)}`); }
  };

  if (argv.includes('--loop')) {
    log(`进入保活循环（每 ${LOOP_INTERVAL_MS / 60000} 分钟）`);
    runOnce();
    setInterval(runOnce, LOOP_INTERVAL_MS);
  } else {
    runOnce();
  }
}

main();
