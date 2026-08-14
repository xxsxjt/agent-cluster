#!/usr/bin/env node
/**
 * lib/memory.js — 虚无记忆体系核心库（v1，2026-08-05）
 *
 * 设计来源（学习落地）：
 * - claude-mem 渐进式披露：检索分 3 层（索引→时间线→详情），~10x token 节省
 * - gbrain 零 LLM 实体抽取：确定性规则织知识图谱，无模型成本
 * - oh-my-cli 治理：写入限工作区（agents/<id>/memory/ 与 knowledge/），凭据不落库
 *
 * 层级（树形继承：全局 → 组 → 个人，后覆盖前）：
 *   org/knowledge/                   全局库（learning-officer 维护）
 *   org/groups/<组id>/memory/        组级共享记忆
 *   org/agents/<id>/memory/          专属记忆（diary.md + auto-notes.md + index.json）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ORG_ROOT = path.join(__dirname, '..');

/* ── 路径解析 ─────────────────────────────────────── */

/** 智能体专属记忆目录 */
function agentMemoryDir(agentId) {
  return path.join(ORG_ROOT, 'agents', agentId, 'memory');
}

/** 组级记忆目录 */
function groupMemoryDir(groupId) {
  return path.join(ORG_ROOT, 'groups', groupId, 'memory');
}

/** 全局知识库 */
function knowledgeDir() {
  return path.join(ORG_ROOT, 'knowledge');
}

/* ── 记忆写入（diary） ───────────────────────────── */

/**
 * 追加日记条目（每次会话/任务结束调用）
 * @param {string} agentId 智能体 id
 * @param {object} entry {ts, task, result, lessons[], pitfalls[]}
 */
function appendDiary(agentId, entry) {
  const dir = agentMemoryDir(agentId);
  fs.mkdirSync(dir, { recursive: true });
  const diaryPath = path.join(dir, 'diary.md');
  const line = [
    `- **${entry.ts || new Date().toISOString().slice(0, 16)}**`,
    entry.task ? ` 任务: ${entry.task}` : '',
    entry.result ? ` 结果: ${entry.result}` : '',
    entry.lessons && entry.lessons.length ? ` 经验: ${entry.lessons.join('; ')}` : '',
    entry.pitfalls && entry.pitfalls.length ? ` 踩坑: ${entry.pitfalls.join('; ')}` : ''
  ].filter(Boolean).join('\n');
  fs.appendFileSync(diaryPath, line + '\n', 'utf8');
  // 触发索引更新
  rebuildIndex(agentId);
  return diaryPath;
}

/* ── 分层检索（claude-mem 渐进式披露） ───────────── */

/**
 * 第 1 层：紧凑索引（~几十 token/条）——先看"有什么"
 * @returns {Array<{ts, task, snippet, lessons}>}
 */
function searchIndex(agentId, keyword) {
  const diary = readDiary(agentId);
  const kw = keyword ? keyword.toLowerCase() : null;
  const items = [];
  for (const block of diary.split(/\n(?=- \*\*)/)) {
    if (!block.trim().startsWith('- **')) continue;
    const ts = (block.match(/\*\*([\dT:.-]+)\*\*/) || [])[1] || '';
    const task = (block.match(/任务: (.+)/) || [])[1] || '';
    const result = (block.match(/结果: (.+)/) || [])[1] || '';
    const lessons = (block.match(/经验: (.+)/) || [])[1] || '';
    const text = (task + ' ' + result + ' ' + lessons).toLowerCase();
    if (!kw || text.includes(kw)) {
      items.push({ ts, task: task.slice(0, 40), snippet: result.slice(0, 40), lessons: lessons.slice(0, 40) });
    }
  }
  return items.slice(-30); // 最近 30 条
}

/**
 * 第 2 层：时间线——按日期分组看上下文
 * @returns {Array<{date, count, tasks[]}>}
 */
function timeline(agentId, days = 7) {
  const items = searchIndex(agentId);
  const byDate = {};
  for (const it of items) {
    const date = (it.ts || '').slice(0, 10);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(it.task);
  }
  return Object.entries(byDate)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, days)
    .map(([date, tasks]) => ({ date, count: tasks.length, tasks: tasks.slice(0, 5) }));
}

/**
 * 第 3 层：详情——按关键词取完整条目（只取相关的，省 token）
 */
function getDetails(agentId, keyword, limit = 3) {
  const diary = readDiary(agentId);
  const kw = keyword.toLowerCase();
  const blocks = diary.split(/\n(?=- \*\*)/).filter(b => b.trim().startsWith('- **') && b.toLowerCase().includes(kw));
  return blocks.slice(-limit).map(b => b.trim());
}

function readDiary(agentId) {
  try { return fs.readFileSync(path.join(agentMemoryDir(agentId), 'diary.md'), 'utf8'); }
  catch (e) { return ''; }
}

/* ── 索引重建（diary 变更后） ─────────────────────── */

/** 生成 index.json（紧凑索引，供 searchIndex 快速读取） */
function rebuildIndex(agentId) {
  const items = searchIndex(agentId);
  try {
    fs.writeFileSync(path.join(agentMemoryDir(agentId), 'index.json'),
      JSON.stringify({ updatedAt: new Date().toISOString(), count: items.length, items }, null, 2), 'utf8');
  } catch (e) {}
  return items.length;
}

/* ── 知识图谱雏形（gbrain 零 LLM 实体抽取） ───────── */

// 中文实体前缀（高精度候选）
const ENTITY_PREFIXES = ['项目', '渠道', '模型', '工具', '平台', '仓库', '服务', '服务器'];

/**
 * 零 LLM 实体抽取：从文本中确定性提取实体（中英文），写入 agent 的 entities.json
 * 借鉴 gbrain：实体前缀高精度优先 + 停用词过滤 + 隔离审核（quarantine）
 */
function extractEntities(agentId, text) {
  // 英文实体：驼峰/专名启发式（简化版：连续大写开头词）
  const enEntities = (text.match(/\b[A-Z][a-zA-Z]{2,20}\b/g) || [])
    .filter(w => !['The', 'This', 'That', 'What', 'When', 'Where', 'Who', 'How', 'And', 'But', 'For', 'With', 'From'].includes(w));
  // 中文实体：前缀词 + 后跟 2-8 字
  const cnEntities = [];
  for (const prefix of ENTITY_PREFIXES) {
    const re = new RegExp(prefix + '([\\u4e00-\\u9fa5A-Za-z0-9]{2,10})', 'g');
    let m;
    while ((m = re.exec(text)) !== null) cnEntities.push(prefix + m[1]);
  }
  const entities = [...new Set([...enEntities, ...cnEntities])].slice(0, 20);

  // 写入 entities.json（隔离通道：新实体标记 pending，待 learning-officer 审核）
  const file = path.join(agentMemoryDir(agentId), 'entities.json');
  let db = { entities: [] };
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  const now = new Date();
  const existing = new Set(db.entities.map(e => e.name));
  for (const name of entities) {
    if (!existing.has(name)) {
      db.entities.push({ name, firstSeen: now.toISOString().slice(0, 10), pendingSince: now.toISOString(), status: 'pending', count: 1 });
    } else {
      const e = db.entities.find(x => x.name === name);
      e.count = (e.count || 0) + 1;
    }
  }
  fs.writeFileSync(file, JSON.stringify(db, null, 2), 'utf8');
  return entities;
}

/** 列出某智能体全部实体（原始数据，控制台/巡检用） */
function listEntities(agentId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(agentMemoryDir(agentId), 'entities.json'), 'utf8')).entities || [];
  } catch (e) { return []; }
}

/** 审核实体（learning-officer 用）：pending → approved / rejected */
function reviewEntity(agentId, name, action) {
  const file = path.join(agentMemoryDir(agentId), 'entities.json');
  try {
    const db = JSON.parse(fs.readFileSync(file, 'utf8'));
    const e = db.entities.find(x => x.name === name);
    if (e) { e.status = action === 'reject' ? 'rejected' : 'approved'; e.reviewedAt = new Date().toISOString().slice(0, 10); }
    fs.writeFileSync(file, JSON.stringify(db, null, 2), 'utf8');
    return e || null;
  } catch (e) { return null; }
}

/* ── 树形继承读取（全局 → 组 → 个人） ───────────── */

/**
 * 按继承规则读取记忆上下文（供智能体初始化时注入）
 * @param {string} agentId
 * @param {string} [groupId]
 * @returns {{global, group, personal, entities}}
 */
function readContext(agentId, groupId) {
  const ctx = { global: {}, group: {}, personal: {}, entities: [] };
  // 全局知识库摘要（只读 key 文件，不读大文件）
  try {
    const kd = knowledgeDir();
    ctx.global = {
      conventions: fs.readFileSync(path.join(kd, 'conventions.md'), 'utf8').slice(0, 3000),
      pitfalls: fs.readFileSync(path.join(kd, 'pitfalls.md'), 'utf8').slice(0, 2000),
      assets: fs.readFileSync(path.join(kd, 'assets.md'), 'utf8').slice(0, 2000)
    };
  } catch (e) {}
  // 组级
  if (groupId) {
    try {
      ctx.group = fs.readFileSync(path.join(groupMemoryDir(groupId), 'group-diary.md'), 'utf8').slice(0, 2000);
    } catch (e) { ctx.group = ''; }
  }
  // 个人
  ctx.personal = readDiary(agentId).slice(-3000);
  try {
    const ef = path.join(agentMemoryDir(agentId), 'entities.json');
    ctx.entities = JSON.parse(fs.readFileSync(ef, 'utf8')).entities.filter(e => e.status !== 'rejected').slice(0, 15);
  } catch (e) {}
  return ctx;
}

/* ── CLI（供直接调用测试） ────────────────────────── */

const cmd = process.argv[2];
if (cmd === 'diary') {
  // node lib/memory.js diary <agentId> <task> <result> [lessons]
  const [agentId, task, result, lessons] = process.argv.slice(3);
  const p = appendDiary(agentId, { task, result, lessons: lessons ? lessons.split('|') : [] });
  console.log('✅ 日记已写:', p);
} else if (cmd === 'search') {
  const [agentId, kw] = process.argv.slice(3);
  console.log(JSON.stringify(searchIndex(agentId, kw), null, 2));
} else if (cmd === 'timeline') {
  console.log(JSON.stringify(timeline(process.argv[3]), null, 2));
} else if (cmd === 'extract') {
  const [agentId, text] = process.argv.slice(3);
  console.log('实体:', extractEntities(agentId, text).join(', '));
} else if (cmd === 'context') {
  const ctx = readContext(process.argv[3], process.argv[4]);
  console.log('全局 conventions:', (ctx.global.conventions || '').length, 'chars');
  console.log('全局 pitfalls:', (ctx.global.pitfalls || '').length, 'chars');
  console.log('组级:', (ctx.group || '').length, 'chars');
  console.log('个人:', (ctx.personal || '').length, 'chars');
  console.log('实体:', ctx.entities.map(e => `${e.name}[${e.status}]`).join(', '));
}

module.exports = { appendDiary, searchIndex, timeline, getDetails, extractEntities, listEntities, reviewEntity, readContext, rebuildIndex };