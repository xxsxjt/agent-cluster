/**
 * lib/related-agents.js — 相关智能体检索器（2026-08-12 agent-collab 落地）
 *
 * 任务派发时自动检索"相关智能体"，解决接任务智能体不知道找谁协作/避让的问题：
 *   - 领域相关：org.json 组级 keywords + agents/<id>/identity.json（label/persona/capabilities）
 *   - 历史相关：inbox（含 archive）任务文件头部 agent: 归属 + 任务名/关键词重叠（谁做过类似任务）
 *   - 冲突相关：resource-lock 活跃写集（本任务 writes: 与谁在写同一资源）
 *
 * 输出 → butler 组装 prompt 时附 `related: <agent1>, <agent2>` 提示（显式声明优先）。
 * 轻量设计：索引缓存 120s；历史扫描限量（最多 800 个文件头部）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ORG = path.join(__dirname, '..');
const INBOX = path.join(ORG, 'inbox');
const AGENTS = path.join(ORG, 'agents');

/* 通用词过滤（任务内容分词里与领域无关的高频词） */
const STOPWORDS = new Set([
  '任务','完成','标记','文件','创建','无法','原因','执行','要求','独立','等待','外部','指令','内容',
  '工作','目录','任务名','验证','目标','背景','需要','相关','智能体','信息','使用','输出','确保','问题',
  '方式','进行','是否','检查','确认','修改','添加','新增','实现','机制','落地','自动','支持','对方',
  '然后','并且','以及','或者','因为','所以','如果','可以','不能','必须','已经','没有','这个','那个',
  '根据','按照','针对','处理','处理完','查看','看看','确认下','确认一下','汇报','写回','响应','问询',
  '投递','共享','协作','冲突','协调','交流','通道','注意','说明','格式','头部','声明','模板','任务文件'
]);

/* 排除永不作为协作对象的节点（管家/分身/纯组壳） */
const SKIP_IDS = new Set(['coo', 'twin', 'butler']);
/* 组级节点只映射组主智能体（mainAgent），组壳本身不参与协作 */
const MIN_SCORE = 8;          // 领域/历史匹配最低分（一个 4 字符词命中 ≈ 6 分，需更实质命中）
const MAX_RELATED = 3;        // 输出上限
const MAX_HIST_FILES = 800;   // 历史扫描上限
const CACHE_TTL_MS = 120000;  // 索引缓存 120s

/* ── 缓存 ── */
let _idxCache = { at: 0, idx: null };
let _histCache = { at: 0, hits: null };
const now = () => Date.now();

function isStale(c) { return now() - c.at > CACHE_TTL_MS; }

/** 构建领域索引：agent → 领域文本（identity persona/label/capabilities + 组 keywords） */
function buildIndex(registry) {
  if (_idxCache.idx && !isStale(_idxCache)) return _idxCache.idx;
  const data = registry.load();
  const nodes = data.nodes || {};
  const idx = { byAgent: {}, order: [] };
  const readId = id => {
    try {
      const p = path.join(AGENTS, id, 'identity.json');
      if (!fs.existsSync(p)) return '';
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return [j.label, j.persona, (j.capabilities || []).join(' ')].filter(Boolean).join(' ');
    } catch (e) { return ''; }
  };
  for (const id of Object.keys(nodes)) {
    if (SKIP_IDS.has(id)) continue;
    const node = nodes[id];
    const isGroup = Array.isArray(node.keywords) && node.keywords.length > 0;
    if (isGroup) {
      // 组 → keywords 挂到组内执行智能体（children 优先，退而 mainAgent）
      const members = Array.isArray(node.children) && node.children.length ? node.children : (node.mainAgent ? [node.mainAgent] : []);
      for (const mem of members) {
        if (SKIP_IDS.has(mem) || !nodes[mem]) continue;
        const e = idx.byAgent[mem] || { text: '', score: 0 };
        e.text += ' ' + node.keywords.join(' ');
        idx.byAgent[mem] = e;
        if (!idx.order.includes(mem)) idx.order.push(mem);
      }
      continue;
    }
    // agent 级：identity 领域文本
    const e = idx.byAgent[id] || { text: '', score: 0 };
    e.text += ' ' + readId(id);
    idx.byAgent[id] = e;
    if (!idx.order.includes(id)) idx.order.push(id);
  }
  _idxCache = { at: now(), idx };
  return idx;
}

/** 任务关键词/任务名分词 → 与领域文本的匹配分 */
function scoreText(kw, nameWords, text) {
  const t = text.toLowerCase();
  let s = 0;
  for (const k of kw) {
    if (k.length < 2 || STOPWORDS.has(k)) continue;
    if (t.includes(k)) s += 2 + k.length;   // 长词命中权重高
  }
  for (const w of nameWords) {
    if (w.length < 3) continue;
    if (t.includes(w)) s += 1 + w.length;
  }
  return s;
}

/** 历史相关：inbox（含 archive）任务文件头部 agent: 归属 + 任务名重叠（谁做过类似任务） */
function findHistoric(task, agentId) {
  if (_histCache.hits && !isStale(_histCache)) return _histCache.hits;
  const name = (task.name || '').toLowerCase();
  const nameWords = name.split(/[-_]/).filter(w => w.length > 3 && !STOPWORDS.has(w));
  const kw = (task.keywords || []).filter(k => k.length > 2 && !STOPWORDS.has(k));
  const hits = {};   // agent -> score
  let scanned = 0;
  for (const dir of [INBOX, path.join(INBOX, 'archive')]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('ask-')); } catch (e) { continue; }
    for (const f of files) {
      if (scanned >= MAX_HIST_FILES) break;
      scanned++;
      const base = f.replace(/\.md$/, '').toLowerCase();
      if (base === name || base.endsWith('-improve')) continue;
      let agent = null;
      try {
        const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 500);
        const m = head.match(/^agent\s*:\s*(\S+)/m);
        if (m) agent = m[1];
      } catch (e) { continue; }
      if (!agent || SKIP_IDS.has(agent) || agent === agentId) continue;
      // 任务名词元重叠（排除纯时间戳/通用段）
      const words = base.split(/[-_]/).filter(w => w.length > 3 && !/^\d{6,}/.test(w) && !STOPWORDS.has(w));
      let s = 0;
      for (const w of words) {
        if (name.includes(w) || kw.some(k => k.includes(w) || w.includes(k))) s += w.length;
      }
      // 任务名与当前任务名有相同业务词段（如 server-/cnb-/app- 前缀同域）
      if (s > 0) hits[agent] = (hits[agent] || 0) + s;
    }
    if (scanned >= MAX_HIST_FILES) break;
  }
  _histCache = { at: now(), hits };
  return hits;
}

/** 冲突相关：任务 writes: 与 resource-lock 活跃写集重叠 → 谁在写同一资源 */
function findConflicts(task, rl, activeTable) {
  const conflicts = [];
  if (!rl || !rl.parseDeclarations) return conflicts;
  try {
    const decl = rl.parseDeclarations(task.content || '');
    if (!decl.writes.length) return conflicts;
    const res = rl.checkConflict(task.name, decl.writes);
    // 活跃写集存的是任务名 → 经 active-tasks.json 映射到 agent
    const task2agent = {};
    try {
      const act = JSON.parse(fs.readFileSync(activeTable, 'utf8') || '{}');
      for (const [tn, e] of Object.entries(act)) task2agent[tn] = (e && e.agentId) || null;
    } catch (e) {}
    for (const c of res.conflicts) {
      for (const holder of c.by) {
        const a = task2agent[holder] || null;
        if (a && a !== task.agentId && !SKIP_IDS.has(a)) {
          conflicts.push({ agent: a, resource: c.resource, byTask: holder });
        }
      }
    }
  } catch (e) {}
  return conflicts;
}

/**
 * 主入口：检索任务的相关智能体
 * @param {object} task   parseTask 输出（含 name/content/keywords/agentId）
 * @param {string} agentId 被派发智能体（排除自身）
 * @returns {{ related: [{id, reason, score}], conflicts: [{agent, resource, byTask}] }}
 */
function findRelated(task, agentId, opts = {}) {
  const registry = opts.registry || require('./registry');
  const rl = opts.rl || require('./resource-lock');
  const activeTable = opts.activeTable || path.join(ORG, 'logs', 'active-tasks.json');

  const idx = buildIndex(registry);
  const kw = (task.keywords || []).filter(k => k.length > 1 && !STOPWORDS.has(k));
  const nameWords = (task.name || '').toLowerCase().split(/[-_]/).filter(w => w.length > 2 && !STOPWORDS.has(w));

  const scores = {};   // agent -> {score, reason[]}

  // 1. 领域相关（identity/keywords 文本匹配）
  for (const id of idx.order) {
    if (id === agentId) continue;
    const s = scoreText(kw, nameWords, idx.byAgent[id].text || '');
    if (s >= MIN_SCORE) {
      scores[id] = { score: s, reason: ['领域相关'] };
    }
  }

  // 2. 历史相关（谁做过类似任务）
  let hist = {};
  try { hist = findHistoric(task, agentId); } catch (e) {}
  for (const [a, s] of Object.entries(hist)) {
    if (a === agentId) continue;   // 排除自身（findHistoric 缓存按任务聚合，不含 agentId 过滤）
    if (s < 8) continue;
    if (scores[a]) { scores[a].score += s; scores[a].reason.push('历史相关任务'); }
    else scores[a] = { score: s, reason: ['历史相关任务'] };
  }

  // 3. 冲突相关（resource-lock 活跃写集重叠）
  const conflicts = findConflicts(task, rl, activeTable);
  for (const c of conflicts) {
    if (!scores[c.agent]) scores[c.agent] = { score: 0, reason: [] };
    scores[c.agent].score += 30;   // 冲突强信号
    scores[c.agent].reason.push(`冲突(写${c.resource})`);
  }

  // 排序输出 top N（score 降序；score 相同按历史顺序）
  const related = Object.entries(scores)
    .map(([id, v]) => ({ id, score: v.score, reason: v.reason }))
    .filter(v => v.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RELATED);

  return { related, conflicts };
}

/* 供 butler 组装提示文本 */
function formatRelated(agentId, res) {
  if (!res.related.length && !res.conflicts.length) return '';
  const lines = ['【相关智能体（自动检索，可协作/避让）】'];
  if (res.related.length) {
    lines.push('相关: ' + res.related.map(r => `${r.id}（${r.reason.join('、')}）`).join('、'));
  }
  for (const c of res.conflicts) {
    lines.push(`⚠️ 冲突: ${c.resource} 正被 ${c.agent}（任务 ${c.byTask}）占用 → 先与对方确认再动，避免覆盖`);
  }
  lines.push('需要交流时走 ask 通道（见下方说明）；不相关则忽略。');
  return lines.join('\n');
}

module.exports = { findRelated, formatRelated, _resetCache: () => { _idxCache = { at: 0, idx: null }; _histCache = { at: 0, hits: null }; } };
