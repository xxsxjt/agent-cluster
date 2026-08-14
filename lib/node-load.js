/**
 * lib/node-load.js — 全节点负载采集与保护（2026-08-11 load-quota-fix）
 *
 * 背景（用户 2026-08-11 17:4x 批评）："刚才又卡了，注意性能负载，别给机器卡死了，
 *   不只是我的电脑主机，服务器和云开发环境那些都是"——负载保护不能只看本机，
 *   要覆盖本机 / HK 服务器 / CNB 云开发空间（三节点六端）。
 *
 * 职责：
 *   - 轻量采集各节点负载：本机（cpu-gate guardian/psutil）、HK（SSH uptime/free）、
 *     CNB 空间1/2/3（SSH uptime/free，host 从 cnb-ctl.js 动态拿最新）。
 *   - 构建类任务派发前：检查【目标节点】负载（pickSide 判定目标端），
 *     目标节点 load ≥ critical(85%) 或内存 ≥ 90% → 暂缓（防卡死），负载回落自动恢复派发。
 *   - 失败容错：任何节点 SSH 失败 → unknown → 放行（fail-open，不因采集失败卡任务）。
 *   - 缓存：采集结果缓存 cacheTtlMs（默认 60s），避免每 15s 轮询都打 SSH。
 *
 * 用法（butler scanInbox 集成，cpu-gate 之后）：
 *   const nodeLoad = require('./lib/node-load');
 *   const nl = nodeLoad.evaluateForTask(task);
 *   if (nl.action === 'defer') { log(`⏸ [节点负载] ${nl.reason}`); continue; }
 *
 * 说明：本机(load 侧)负载由 cpu-gate 负责；本模块只管 hk/cnb 端（不重复本机）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFile } = require('./win-spawn');
const { execFileSync } = require('child_process');
const { pickSide } = require('./route-auto');
const cpuGate = require('./cpu-gate');   // 复用本机负载（guardian/psutil）

const ORG_ROOT = path.resolve(__dirname, '..');
const CONFIG  = path.join(ORG_ROOT, 'config', 'node-load.json');
const CNB_CTL = path.join(ORG_ROOT, 'scripts', 'cnb-ctl.js');
const NOTIFY_CFG = path.join(ORG_ROOT, 'config', 'cluster-notify.json');

/* ── 默认配置（config/node-load.json 可覆盖，改即生效） ───── */
const DEFAULTS = {
  enabled: true,
  highThreshold: 70,          // load >= 70% → high（暂缓）
  criticalThreshold: 85,      // load >= 85% → critical（任务要求阈值）
  memHighPct: 90,             // 内存使用率 >= 90% → high（防 OOM）
  cacheTtlMs: 60 * 1000,      // 负载缓存 60s（SSH 不每次打）
  sshTimeoutMs: 10000,        // SSH 超时（秒）
  cnbSpaces: ['cnb1', 'cnb2', 'cnb3'],
};

/* CNB agent → 空间编号映射（routeTask 显式绑定 cnb-dev/cnb-build/cnb-test 时定位具体空间） */
const CNB_AGENT_SPACE = { 'cnb-dev': '1', 'cnb-build': '2', 'cnb-test': '3' };
const SPACE_KEY = { '1': 'cnb1', '2': 'cnb2', '3': 'cnb3' };

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    return Object.assign({}, DEFAULTS, c || {});
  } catch (e) { return Object.assign({}, DEFAULTS); }
}

/* ── 轻量缓存 ─────────────────────────────────────────── */
const _cache = {};   // { local: {ts, load, temp}, hk: {ts,load,memPct}, cnb1: {...}, ... }
function cached(key) {
  const e = _cache[key];
  const cfg = loadConfig();
  if (e && Date.now() - e.ts < cfg.cacheTtlMs) return e.data;
  return null;
}
function putCache(key, data) { _cache[key] = { ts: Date.now(), data }; }

/* ── SSH 工具（win-spawn 隐藏窗口，避免弹窗；同步执行，超时兜底） ── */
function sshRunSync(host, user, port, key, remoteCmd, timeoutMs) {
  try {
    const args = ['-i', key, '-p', String(port),
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=/dev/null',
      `${user}@${host}`, remoteCmd];
    const out = execFileSync('ssh', args, { encoding: 'utf8', timeout: timeoutMs || 10000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return { ok: true, out: String(out || '').trim(), err: '' };
  } catch (e) {
    // stderr 可能含 openssh post-quantum 警告（无害），仅当真的报错才失败
    const stderr = String((e && e.stderr) || '');
    const clean = stderr.split('\n')
      .filter(l => !/post-quantum|store now|upgraded|vulnerable|attack|session may|needs to be|WARNING|^Connection|^Received|^Disconnected|^The authentication/i.test(l))
      .join('\n').trim();
    if (clean) return { ok: false, out: '', err: clean };
    // 全被过滤（纯警告）但 exit 非 0 → 视为 stdout 为空
    return { ok: false, out: String((e && e.stdout) || '').trim(), err: clean };
  }
}

/** 解析 SSH 输出：`loadavg1\nnproc\nmemTotal memUsed` → {load%, memPct%} */
function parseLoadOut(out) {
  const lines = String(out || '').split('\n').filter(l => l.trim());
  if (lines.length < 2) return { load: null, memPct: null };
  const load1 = parseFloat(lines[0]);
  const nproc = parseInt(lines[1], 10);
  let memPct = null;
  const mtok = (lines[2] || '').trim().split(/\s+/);
  const mTotal = parseFloat(mtok[0]), mUsed = parseFloat(mtok[1]);
  if (mTotal) memPct = Math.round((mUsed / mTotal) * 100);
  const load = nproc && !isNaN(load1) ? Math.round((load1 / nproc) * 100) : (isNaN(load1) ? null : 0);
  return { load, memPct };
}

const REMOTE_CMD = `awk '{print $1}' /proc/loadavg && nproc && free -m | awk 'NR==2{print $2,$3}'`;

/* ── 各节点采集 ───────────────────────────────────────── */
function getLocal() {
  const c = cached('local');
  if (c) return c;
  const r = cpuGate.getLoad();   // {load, temp, src}（readCpu 导出为 getLoad）
  const data = { load: typeof r.load === 'number' ? r.load : null, temp: r.temp, src: 'local' };
  putCache('local', data);
  return data;
}

function getHk() {
  const c = cached('hk');
  if (c) return c;
  const cfg = loadConfig();
  const data = { load: null, memPct: null, src: 'unknown', unknown: true };
  try {
    const nf = JSON.parse(fs.readFileSync(NOTIFY_CFG, 'utf8') || '{}') || {};
    const host = nf.hkHost || '103.100.159.111';
    const port = nf.hkPort || '43891';
    const user = nf.hkUser || 'root';
    const key  = path.join(require('os').homedir(), '.ssh', 'id_ed25519_xxsx_hk');
    const r = sshRunSync(host, user, port, key, REMOTE_CMD, cfg.sshTimeoutMs);
    if (r.ok && r.out) {
      const p = parseLoadOut(r.out);
      data.load = p.load; data.memPct = p.memPct; data.src = 'hk'; data.unknown = false;
    } else { data.err = r.err || 'ssh fail'; }
  } catch (e) { data.err = e.message; }
  putCache('hk', data);
  return data;
}

/** 解析 CNB 空间最新 SSH host（cnb-ctl.js，DPAPI token）→ {user,host,port} | null */
function resolveCnbHost(spaceNum) {
  try {
    const out = execFileSync('node', [CNB_CTL, 'ssh', String(spaceNum)], {
      encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 1 * 1024 * 1024,
    });
    const host = (out || '').trim().split(/\r?\n/).filter(Boolean).pop();
    if (host && host.includes('@') && host.includes('cnb.space')) {
      const i = host.indexOf('@');
      return { user: host.slice(0, i), host: host.slice(i + 1), port: '22' };
    }
  } catch (e) { /* host 解析失败 */ }
  return null;
}

function getCnb(spaceNum) {
  const key = SPACE_KEY[String(spaceNum)] || ('cnb' + spaceNum);
  const c = cached(key);
  if (c) return c;
  const cfg = loadConfig();
  const data = { load: null, memPct: null, src: 'unknown', unknown: true };
  try {
    const t = resolveCnbHost(spaceNum);
    if (!t) { data.err = 'cnb host 解析失败'; }
    else {
      const keyPath = path.join(require('os').homedir(), '.ssh', 'id_rsa_cnb');
      const r = sshRunSync(t.host, t.user, t.port, keyPath, REMOTE_CMD, cfg.sshTimeoutMs);
      if (r.ok && r.out) {
        const p = parseLoadOut(r.out);
        data.load = p.load; data.memPct = p.memPct; data.src = `cnb${spaceNum}`; data.unknown = false;
      } else { data.err = r.err || 'ssh fail'; }
    }
  } catch (e) { data.err = e.message; }
  putCache(key, data);
  return data;
}

function getNode(nodeKey) {
  if (nodeKey === 'local') return getLocal();
  if (nodeKey === 'hk') return getHk();
  if (/^cnb\d+$/.test(nodeKey)) return getCnb(nodeKey.replace('cnb', ''));
  return { load: null, memPct: null, src: 'unknown', unknown: true };
}

/** load → 等级（与 cpu-gate 对齐：critical≥85 强制、high≥70 暂缓；内存≥90 视为 high） */
function levelFrom(load, memPct, cfg) {
  const memHigh = typeof memPct === 'number' && memPct >= cfg.memHighPct;
  if (typeof load === 'number' && load >= cfg.criticalThreshold) return 'critical';
  if (memHigh || (typeof load === 'number' && load >= cfg.highThreshold)) return 'high';
  return 'normal';
}

/**
 * 对任务做目标节点负载评估（构建类任务防卡死）。
 * 判定目标端：pickSide(task) → local/hk/cnb；
 *   - local → 交给 cpu-gate（本模块不重复本机）
 *   - hk    → 查 HK 负载
 *   - cnb   → 查 task.space 指定的空间，或 agentId 对应空间，缺省空间1
 * @param {object} task {name, content, target, space, agentId}
 * @returns {{action:'dispatch'|'defer', node?, level?, load?, memPct?, reason?, note?}}
 */
function evaluateForTask(task) {
  const cfg = loadConfig();
  if (!cfg.enabled) return { action: 'dispatch', note: 'node-load 未启用' };
  if (!task || !task.name) return { action: 'dispatch' };

  // 只对构建类任务做目标节点负载门禁（任务要求「构建类任务派发前检查」）：
  //   普通任务（AI 对话/轻量）不受节点负载门禁影响——高负载也照跑，避免误伤正常任务。
  //   复用 cpu-gate 的 isBuildTask（header load-sensitive 或内容命中构建关键词）。
  if (!cpuGate.isBuildTask(task)) {
    return { action: 'dispatch', node: null, note: '非构建类任务，不受节点负载门禁' };
  }

  const side = pickSide(task);
  if (side === 'local') return { action: 'dispatch', node: 'local', note: '本机负载由 cpu-gate 负责' };

  let nodeKey = side;
  if (side === 'cnb') {
    let spaceNum = task.space || (task.agentId && CNB_AGENT_SPACE[task.agentId]) || '1';
    nodeKey = SPACE_KEY[String(spaceNum)] || 'cnb1';
  }

  const snap = getNode(nodeKey);
  if (snap.unknown || snap.load == null) {
    return { action: 'dispatch', node: nodeKey, load: snap.load, note: `${nodeKey} 负载未知（${snap.err || '未知'}）→ 放行` };
  }
  const level = levelFrom(snap.load, snap.memPct, cfg);
  if (level === 'critical' || level === 'high') {
    return {
      action: 'defer', node: nodeKey, level, load: snap.load, memPct: snap.memPct,
      reason: `${nodeKey} 负载 ${snap.load}%(${level})${snap.memPct != null ? ' / 内存 ' + snap.memPct + '%' : ''} 暂缓构建任务（防节点卡死，负载回落自动派发）`,
    };
  }
  return { action: 'dispatch', node: nodeKey, level, load: snap.load, memPct: snap.memPct };
}

/** 状态快照（CLI / 测试用）：全节点当前负载 + 缓存时间戳 */
function status() {
  const cfg = loadConfig();
  const out = { enabled: cfg.enabled, thresholds: { high: cfg.highThreshold, critical: cfg.criticalThreshold, memHighPct: cfg.memHighPct }, nodes: {} };
  out.nodes.local = getLocal();
  out.nodes.hk = getHk();
  for (const n of cfg.cnbSpaces) out.nodes[n] = getCnb(n.replace('cnb', ''));
  return out;
}

module.exports = {
  DEFAULTS, SPACE_KEY, CNB_AGENT_SPACE,
  loadConfig, getLocal, getHk, getCnb, getNode, levelFrom, parseLoadOut,
  evaluateForTask, status, pickSide,
};
