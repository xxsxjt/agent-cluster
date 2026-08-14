'use strict';
/**
 * lib/session-reuse.js — 子代理会话复用（2026-08-12 用户批评：无限新开会话/上下文不延续）
 *
 * 问题实证：每次任务强制唯一 session-id（task-<agent>-<ts>），同智能体同主题任务上下文不延续，
 *           像失忆；night-worker 等智能体 291+ 会话文件全是单任务短会话，auto-compaction 从未触发。
 *
 * 方案：
 *   - 稳定主题族 id：task-<agent>-<family>-<ts>（family 从任务名提取；同族任务 id 前缀一致）
 *   - 复用规则（全部满足才复用，缺一即新开）：
 *     ① 同 agent + 同主题族（family 一致）
 *     ② 会话已空闲（mtime 距今 > IDLE_MS，防并发写坏：正在跑的任务 mtime 持续刷新）
 *     ③ 体积安全（< MAX_BYTES，防上下文爆炸——2026-08-10 上下文爆炸修复的底线不破）
 *   - pi --session-id 语义天然支持：存在即续用、不存在即创建 → 复用/新开同一入口
 *
 * 主题相关才复用（防污染）：family = 任务名前两个有效 token（滤纯数字/时间戳）。
 *   session-reuse-quality      → session-reuse
 *   nextday-2026-08-12-xxx-152618 → nextday-xxx（夜间任务族内再按主题细分，不互污染）
 *   cnb-node-test-resume-verify → cnb-node
 */
'use strict';
const fs = require('fs');
const path = require('path');

/** 会话空闲判定：mtime 距今超过此值才认为可复用（防与活跃任务并发写同一会话；
 *  同族任务串行间隔 >2min 即复用，同族并发（罕见）由 mtime 防护兜底新开） */
const IDLE_MS = 2 * 60 * 1000;
/** 可复用会话体积上限（约 512KB ≈ 5 万 token，接近 128K 窗口的一半；超限新开，由压缩兜底） */
const MAX_BYTES = 512 * 1024;
/** 会话文件名/首行 id 前缀：task-<agent>- */
const AGENT_PREFIX = 'task-';

/**
 * 从任务名提取主题族（前两个有效 token，滤纯数字段）。
 * @param {string} taskName
 * @returns {string} family（无有效 token 时回退 'default'）
 */
function familyOf(taskName) {
  const tokens = String(taskName || '')
    .split('-')
    .map(t => t.trim())
    .filter(t => t && !/^\d+$/.test(t)); // 滤纯数字段（时间戳/日期/序列号：2026-08-12 → 2026/08/12 全滤）
  if (tokens.length === 0) return 'default';
  return tokens.slice(0, 2).join('-');
}

/**
 * 扫描 sessions 目录找可复用候选（同 agent + 同 family + 空闲 + 体积安全）。
 * @param {object} opts { agentDir, agentId, family, excludeIds?, now? }
 * @returns {string|null} 会话 id（文件首行 session.id 或文件名前缀），无则 null
 */
function findReuseCandidate(opts) {
  const { agentDir, agentId, family, excludeIds = [], now = Date.now() } = opts;
  const sessionsDir = path.join(agentDir, 'sessions');
  if (!family || !fs.existsSync(sessionsDir)) return null;
  let files;
  try { files = fs.readdirSync(sessionsDir); } catch (e) { return null; }
  const prefix = `${AGENT_PREFIX}${agentId}-${family}-`;
  // 文件名可能带 ISO 时间戳前缀（<ISO>_task-...）或纯 task-...；按名字+首行 id 双匹配
  const cands = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    if (!f.includes(`${AGENT_PREFIX}${agentId}-${family}-`)) continue;
    const fp = path.join(sessionsDir, f);
    let stat = null, id = null;
    try {
      stat = fs.statSync(fp);
      // 首行 session id（比文件名可靠：--session-id 决定 id，文件名是 pi 自生成）
      const fd = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, 4096, 0);
      fs.closeSync(fd);
      const head = buf.slice(0, n).toString('utf8');
      const m = head.match(/"id":"([^"]+)"/);
      if (m && m[1].startsWith(prefix)) id = m[1];
      else if (f.startsWith(prefix)) id = f.slice(0, -'.jsonl'.length);
    } catch (e) { continue; }
    if (!id) continue;                       // 旧格式（无 family）或异常文件：不匹配
    if (excludeIds.includes(id)) continue;   // 活跃任务占用中
    if (now - stat.mtimeMs < IDLE_MS) continue; // 最近 10min 有写入 = 可能还在跑
    if (stat.size > MAX_BYTES) continue;     // 体积超限：新开（防上下文爆炸）
    cands.push({ id, mtime: stat.mtimeMs, size: stat.size });
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => b.mtime - a.mtime);   // 最近的最优先
  return cands[0].id;
}

/**
 * 计算任务的会话 id（复用或新开）。
 * @param {object} opts {
 *   agentId, taskName, agentDir,
 *   policy?: 'auto'|'reuse'|'new'|<显式 id>,   // 默认 'auto'（任务头 session: 覆盖）
 *   excludeIds?: string[], now?: number
 * }
 * @returns {{ sessionId: string, reused: boolean, family: string, reason: string }}
 */
function computeSessionId(opts) {
  const { agentId, taskName, agentDir, policy, excludeIds, now } = opts;
  const family = familyOf(taskName);
  const safeAgent = String(agentId || 'agent').replace(/[^a-zA-Z0-9_-]/g, '_');
  // 显式指定 id：直接复用（用户/任务头声明，信任）
  if (policy && policy !== 'auto' && policy !== 'reuse' && policy !== 'new') {
    return { sessionId: policy, reused: true, family, reason: '显式指定' };
  }
  if (policy !== 'new') {
    const cand = findReuseCandidate({ agentDir, agentId: safeAgent, family, excludeIds, now });
    if (cand) {
      return { sessionId: cand, reused: true, family, reason: '同族复用（最近空闲会话）' };
    }
  }
  const ts = now || Date.now();
  const fresh = `task-${safeAgent}-${family}-${ts}`;
  const reason = policy === 'new' ? '强制新开' : '无同族可复用候选（首次/超限/活跃中）';
  return { sessionId: fresh, reused: false, family, reason };
}

module.exports = { computeSessionId, findReuseCandidate, familyOf, IDLE_MS, MAX_BYTES };
