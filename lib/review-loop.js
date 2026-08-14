#!/usr/bin/env node
/**
 * lib/review-loop.js — 自动复盘闭环（2026-08-10 review-loop）
 *
 * 补全"自动总结优化改进"缺失的两环之一：任务完成后自动复盘 → 改进项 → 例会核对 → 验证。
 * 与每日例会/对话蒸馏/进化合并/职责巡检并列，负责**任务结果复盘与改进沉淀**。
 *
 * 职责：
 *   1. 任务完成钩子 scanCompleted()：butler 任务 .DONE 写入 → 自动生成复盘条目 append 到
 *      knowledge/reviews/<date>.jsonl（{任务/agent/耗时/成败/问题/改进建议}）。
 *      由 butler 主循环每 5 分钟调用（幂等，游标去重）。
 *   2. 每日复盘汇总 dailyReviewMaterial()：把当日复盘条目 + 待验证改进项整理成会议材料文件，
 *      daily-meeting 管理组小会 prompt 自动带上（复用例会派发机制）。
 *   3. 改进项追踪 config/improvements.jsonl：例会决议的改进项落盘（pending），下次例会核对
 *      "上轮改进是否验证"（verifyImprovements → done）。
 *   4. LLM 改进建议：改进项由每日例会管理组小会（flash 智能体）生成/精化，通过
 *      recordImprovementsFromMgmt() 解析 `- IMPROVE: ...` 行落盘。
 *   5. self-review 反省层（2026-08-11 review-loop-v2）：每任务复盘自动生成四问
 *      （①哪里做错/走弯路 ②该问没问 ③违背原则 ④下次更好）规则基线，追加到条目
 *      selfReview 字段；例会材料先看自我审查摘要再谈改进（自我审查优先）。
 *      用户纠正后可用 associateCorrection(task, text) 串到对应条目（纠正→反省→改进闭环）。
 *
 * 配置：org/config/review-loop.json（改即生效，每轮 check 重读表）
 * 状态：org/logs/review-loop-state.json（seenDone 游标 + 汇总/核对节流）
 *
 * 用法：
 *   node lib/review-loop.js check        # 跑一轮（butler 每 5 分钟调，含钩子 + 材料生成）
 *   node lib/review-loop.js summarize    # 手动触发当日复盘汇总 → 生成会议材料
 *   node lib/review-loop.js record "标题（owner: X）| 说明"   # 手动记录一条改进项
 *   node lib/review-loop.js verify        # 手动跑一轮"上轮改进是否验证"核对
 *   node lib/review-loop.js link <task> "<纠正文本>"  # 关联纠正到任务 self-review
 *   node lib/review-loop.js test          # 内置自检
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ORG_ROOT   = path.join(__dirname, '..');
const CONFIG     = path.join(ORG_ROOT, 'config', 'review-loop.json');
const STATE_FILE = path.join(ORG_ROOT, 'logs', 'review-loop-state.json');
const INBOX      = path.join(ORG_ROOT, 'inbox');
const LOGS       = path.join(ORG_ROOT, 'logs');
const REVIEWS_DIR= path.join(ORG_ROOT, 'knowledge', 'reviews');
const IMPROVE_FILE= path.join(ORG_ROOT, 'config', 'improvements.jsonl');
const ACTIVE_FILE= path.join(ORG_ROOT, 'logs', 'active-tasks.json');

const { logActivity } = require('./twin-log');

const readIf  = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const readJsonSafe = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const writeJsonSafe = (p, o) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8'); } catch (e) {} };
const ensure = d => fs.mkdirSync(d, { recursive: true });
const statOf = p => { try { return fs.statSync(p); } catch (e) { return null; } };
const tsISO  = () => new Date().toISOString();
function today() { return new Date().toISOString().slice(0, 10); }
function tsStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function log(...a) {
  const line = `[${new Date().toLocaleTimeString()}] [review-loop] ${a.join(' ')}`;
  console.log(line);
  // 2026-08-10 修复：内部日志文件名与任务名 review-loop 的会话日志 logs/review-loop.log 撞名（agent 会话流 45K 行污染）。
  // 改名为 review-loop-runner.log，避免混写（同 auto-schedule → auto-scheduler 踩坑）。
  try { ensure(LOGS); fs.appendFileSync(path.join(LOGS, 'review-loop-runner.log'), line + '\n', 'utf8'); } catch (e) {}
}

function loadCfg() {
  const def = {
    enabled: true,
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
    thinking: 'off',
    // 隐私铁律：处理用户偏好/隐私数据的智能体任务，其复盘路由 deepseek 官方渠道（不进第三方）
    privateAgents: ['pm', 'reviewer', 'intel-gatherer', 'learning-officer', 'channel-manager', 'twin', 'coo'],
    // 永不复盘的任务前缀（控制/自动派发类，避免复盘自身/例会/验收/巡检）
    excludePrefixes: ['review-loop-', 'review-improve-', 'daily-meeting-', 'review-', 'intel-collect-', 'improve-', 'decision-', 'checkpoint-', 'duty-', 'chan-scan-', 'pm-plan-', 'learning-merge-'],
    // 秒级最小间隔：同一任务两次复盘（防重复触发）
    dedupeMinSec: 3600,
    // 会议材料文件保留最近 N 天
    materialKeepDays: 7
  };
  try { return Object.assign(def, readJsonSafe(CONFIG) || {}); } catch (e) { return def; }
}
function loadState() { return readJsonSafe(STATE_FILE) || { seenDone: {}, reviewCursor: {}, summarize: { last: 0 } }; }
function saveState(s) { writeJsonSafe(STATE_FILE, s); }

/* ── 1. 任务完成钩子：DONE → 复盘条目 ────────────────── */
/** 读取任务 .md 头部（agent/provider/model/title） */
function readTaskHeader(name) {
  const h = { title: name, agent: '', provider: '' };
  const md = readIf(path.join(INBOX, `${name}.md`));
  if (md) {
    for (const line of md.split(/\r?\n/)) {
      if (/^agent:/i.test(line)) h.agent = line.replace(/^agent:\s*/i, '').trim();
      else if (/^provider:/i.test(line)) h.provider = line.replace(/^provider:\s*/i, '').trim();
      else if (/^model:/i.test(line)) h.model = line.replace(/^model:\s*/i, '').trim();
      else if (/^#\s+/.test(line) && h.title === name) h.title = line.replace(/^#\s*/, '').trim();
    }
  }
  return h;
}

/** 从 active-tasks / 文件 mtime 估任务耗时（ms） */
function taskDuration(name) {
  const act = readJsonSafe(ACTIVE_FILE) || {};
  const a = act[name];
  if (a && a.startedAt) {
    const t = new Date(a.startedAt).getTime();
    if (!Number.isNaN(t)) return Date.now() - t;
  }
  const md = statOf(path.join(INBOX, `${name}.md`));
  const done = statOf(path.join(INBOX, `${name}.DONE`));
  if (md && done) return Math.max(0, done.mtimeMs - md.mtimeMs);
  return 0;
}

/** 问题提取：失败→FAILED 原因；成功→查日志尾部真实错误（跳过 JSON dump/超长行）；否则空 */
function extractProblem(name, ok, doneTxt) {
  if (!ok) return (doneTxt || '').replace(/^\.FAILED:\s*/i, '').slice(0, 300) || '任务失败（原因未在 DONE 中说明）';
  const lg = statOf(path.join(LOGS, `${name}.log`));
  if (lg) {
    try {
      const tail = fs.readFileSync(path.join(LOGS, `${name}.log`), 'utf8').split(/\r?\n/).slice(-120);
      const errs = tail.filter(l => /error|异常|exception|fatal/i.test(l) && l.length < 200 && !/agent_end|\{"role"/.test(l));
      if (errs.length) return errs.slice(0, 2).map(l => l.slice(0, 150)).join(' | ');
    } catch (e) {}
  }
  return '';
}

/** 规则基线改进建议（hook 阶段）；真正 LLM 精化在例会由 flash 智能体做 */
function heuristicImprovement(name, ok, agent, problem) {
  if (!ok) return `任务 ${name} 失败：${problem.slice(0, 80)}。建议：补日志/定位根因后重跑，或写决策请求恢复。`;
  return `任务 ${name} 完成${agent ? `（${agent}）` : ''}。建议：核验产物是否符合验收标准；如产出可复用，沉淀经验到 memory/distill-notes.md。`;
}

/* ── self-review（反省/自我审查层，2026-08-11 review-loop-v2） ────── */
/**
 * 规则检测：任务是否可能走了"该派对应智能体/该问用户却自己查"的弯路。
 * 轻量关键词启发式，只在强命中且缺 agent 时提示，不误报。
 */
function detectPrincipleBreach(task, title, agent, problem) {
  const text = `${task} ${title || ''} ${problem || ''}`.toLowerCase();
  // 分工铁律：查服务器/版本/状态/日志/进程/SSH → 应派 server-admin，而非自己翻
  const shouldDelegate = ['查版本', '查状态', 'ssh', '进程', '服务器', '查日志', '端口', '远程'].some(k => text.includes(k));
  if (shouldDelegate && !agent) {
    return { breach: true, note: '❌ 任务涉及查服务器/版本/状态/日志却未派 server-admin——违反分工铁律', fix: '查服务器/版本/状态/日志 → 派 server-admin；查社交/内容 → 派对应业务域智能体' };
  }
  // 调研三序：涉及"读工作记录/记忆/台账"属自身记忆，无需外查——无违规
  return { breach: false, note: '' };
}

/**
 * 生成 self-review 四问（规则基线，诚实模板，不依赖 LLM——轻量同步）。
 * 真正精化由例会管理组 flash 智能体在 reading 材料后做（与 improvement 同模式）。
 * @returns {object} { q1 哪里做错/走弯路, q2 该问没问, q3 违背原则, q4 下次更好, method, note }
 */
function buildSelfReview(entry) {
  const { task, status, problem, agent, title } = entry;
  const ok = status === 'success';
  const p = (problem || '').trim();
  const pf = detectPrincipleBreach(task, title, agent, p);
  const q1 = ok
    ? (pf.breach ? `完成但有弯路：${pf.note.slice(2)}` : '完成，尚未暴露明显错误/弯路（须例会核验产物才敢说）')
    : (p ? `任务失败：${p.slice(0, 80)}` : '任务失败，原因待查（见 problem）');
  const q2 = ok
    ? '产物是否在信息不足时硬猜？应主动问用户/派对应智能体验收，别替用户假设验收标准'
    : '失败时是否该先问用户/查对应智能体补齐信息再动手，而非硬跑消耗轮次？';
  const q3 = pf.breach
    ? pf.note
    : '本次未见明显违背已有原则（分工铁律/调研三序/投递即回/隐私）的规则信号；真伪留例会精化';
  const q4 = ok
    ? (pf.breach ? `下次同样场景：${pf.fix}` : '核验产物符合验收标准；产出可复用则沉淀经验，否则不重复造')
    : '先定位根因/补日志；信息不足先问用户或派对应智能体，再重跑';
  return {
    q1, q2, q3, q4,
    method: 'auto-heuristic',
    note: '规则基线；真正精化由例会管理组 flash 智能体读取材料后完成'
  };
}

/**
 * 关联一条用户纠正到某任务的 self-review（纠正→反省→改进闭环串联，主会话 turn 级加分）。
 * 主会话在 corrections.md 记录纠正后调用，把纠正原文串到对应任务的 self-review.corrections。
 * @returns {boolean} 是否成功关联
 */
function associateCorrection(taskName, correction) {
  if (!taskName || !correction) return false;
  const date = today();
  const file = path.join(REVIEWS_DIR, `${date}.jsonl`);
  const reviews = readReviews(date);
  let changed = false;
  const out = [];
  for (const r of reviews) {
    if (r.task === taskName) {
      r.selfReview = r.selfReview || {};
      r.selfReview.corrections = r.selfReview.corrections || [];
      r.selfReview.corrections.push({ text: String(correction).slice(0, 200), at: tsISO() });
      changed = true;
    }
    out.push(JSON.stringify(r));
  }
  if (changed) { ensure(REVIEWS_DIR); fs.writeFileSync(file, out.join('\n'), 'utf8'); }
  return changed;
}

/** 追加一条复盘条目到 knowledge/reviews/<date>.jsonl（一行 JSON） */
function appendReview(entry) {
  ensure(REVIEWS_DIR);
  const file = path.join(REVIEWS_DIR, `${today()}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  return file;
}

/**
 * 任务完成钩子：扫描 inbox 新 .DONE → 生成复盘条目。
 * @returns {string[]} 新增 activity 行
 */
function scanCompleted() {
  const cfg = loadCfg();
  if (cfg.enabled === false) return [];
  const state = loadState();
  const changed = [];
  if (!fs.existsSync(INBOX)) return changed;
  const files = fs.readdirSync(INBOX).filter(f => /\.DONE$/.test(f));
  const seen = state.seenDone || {};
  const now = Date.now();
  for (const f of files) {
    const name = f.replace(/\.DONE$/, '');
    if (cfg.excludePrefixes.some(p => name.startsWith(p))) continue;
    const st = statOf(path.join(INBOX, f));
    if (!st) continue;
    const key = f + '@' + st.mtimeMs;
    // 去重：游标已消费，或同任务在 dedupeMinSec 内复盘过
    const lastRev = (state.reviewCursor || {})[name] || 0;
    if (seen[f] === key) continue;
    if (now - lastRev < cfg.dedupeMinSec * 1000) { seen[f] = key; continue; }
    seen[f] = key;
    const doneTxt = (readIf(path.join(INBOX, f)) || '').trim();
    const ok = !/\.FAILED/i.test(doneTxt);
    const hdr = readTaskHeader(name);
    const durMs = taskDuration(name);
    const problem = extractProblem(name, ok, doneTxt);
    const entry = {
      ts: tsISO(),
      task: name,
      title: hdr.title || name,
      agent: hdr.agent || '',
      durationSec: Math.round(durMs / 1000),
      status: ok ? 'success' : 'failed',
      summary: doneTxt.slice(0, 200),
      problem: problem,
      improvement: heuristicImprovement(name, ok, hdr.agent, problem),
      improvementSource: 'auto',
      // 2026-08-11 review-loop-v2：self-review 反省层（四问，规则基线，例会精化）
      selfReview: buildSelfReview({ task: name, title: hdr.title, agent: hdr.agent, status: ok ? 'success' : 'failed', problem })
    };
    const file = appendReview(entry);
    state.reviewCursor = state.reviewCursor || {};
    state.reviewCursor[name] = now;
    changed.push(logActivity(`${name}（${entry.status}，${Math.round(durMs / 60000)}min）`,
      `已追加复盘条目 → ${file}`, '复盘'));
  }
  state.seenDone = seen;
  saveState(state);
  return changed;
}

/* ── 复盘条目读取 ───────────────────────────────────── */
function readReviews(dateStr) {
  const file = path.join(REVIEWS_DIR, `${dateStr}.jsonl`);
  if (!statOf(file)) return [];
  const out = [];
  for (const l of (readIf(file) || '').split(/\r?\n/)) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch (e) {}
  }
  return out;
}

/* ── 2. 每日复盘汇总：生成会议材料（daily-meeting 管理组小会自动带上） ── */
/**
 * 汇总当日复盘条目 + 待验证改进项 → 写 knowledge/reviews/daily-material-<date>.md。
 * 返回材料文件路径（无内容则返回 null）。
 */
function dailyReviewMaterial() {
  const cfg = loadCfg();
  ensure(REVIEWS_DIR);
  const date = today();
  const reviews = readReviews(date);
  const improves = readImprovements();
  const pending = improves.filter(i => i.status !== 'done');
  const failed = reviews.filter(r => r.status === 'failed');
  const L = [];
  L.push(`# 复盘材料：${date}（review-loop 自动生成，例会管理组小会阅读）`);
  L.push('');
  if (!reviews.length && !pending.length) {
    // 空材料不生成文件（避免例会读空）
    return null;
  }

  // ── 〇、自我审查摘要（2026-08-11 review-loop-v2）：自我审查优先，先看反省再谈改进 ──
  const selfReviews = reviews.filter(r => r.selfReview && r.selfReview.q1);
  const breached = selfReviews.filter(r => r.selfReview.q3 && /^❌|违反/.test(r.selfReview.q3));
  L.push(`## 〇、自我审查摘要（先看反省，再讨论改进）`);
  L.push('');
  if (selfReviews.length) {
    L.push(`> 规则基线生成（例会 flash 精化）。当日 ${selfReviews.length} 条 self-review：`);
    for (const r of selfReviews) {
      const sr = r.selfReview;
      L.push(`- **${r.task}**（${r.status === 'success' ? '✅' : '❌'}）`);
      L.push(`  - ③违背原则？${sr.q3.slice(0, 120)}`);
      L.push(`  - ④下次更好：${sr.q4.slice(0, 120)}`);
      if (sr.corrections && sr.corrections.length) {
        L.push(`  - 🔗 关联纠正 ×${sr.corrections.length}：${sr.corrections[sr.corrections.length - 1].text.slice(0, 100)}`);
      }
    }
    if (breached.length) {
      L.push('');
      L.push('⚠️ 检测到违反分工铁律信号，请在改进项中明确纠正：');
      for (const r of breached) L.push(`- ${r.task}：${r.selfReview.q3}`);
    }
  } else {
    L.push('（今日暂无带自我审查的复盘条目）');
  }
  L.push('');

  L.push(`## 一、当日任务复盘（${reviews.length} 条）`);
  L.push('');
  if (reviews.length) {
    for (const r of reviews) {
      const durMin = (r.durationSec || 0) / 60;
      L.push(`- [${r.status === 'success' ? '✅' : '❌'}] **${r.task}**${r.agent ? `（@${r.agent}）` : ''} ${durMin >= 1 ? `约${Math.round(durMin)}min` : '瞬时'}${r.summary ? `：${r.summary.slice(0, 120)}` : ''}`);
      // 自我审查优先于问题/改进建议
      if (r.selfReview && r.selfReview.q1) {
        L.push(`  - 🔍 反省①：${r.selfReview.q1.slice(0, 140)}`);
        L.push(`  - 🔍 反省②：${r.selfReview.q2.slice(0, 140)}`);
        L.push(`  - 🔍 反省③：${r.selfReview.q3.slice(0, 140)}`);
        L.push(`  - 🔍 反省④：${r.selfReview.q4.slice(0, 140)}`);
      }
      if (r.problem) L.push(`  - 问题：${r.problem.slice(0, 150)}`);
      L.push(`  - 改进建议：${(r.improvement || '').slice(0, 150)}`);
    }
  } else {
    L.push('（今日暂无已完成任务复盘）');
  }
  L.push('');
  L.push(`## 二、待验证/待办改进项（${pending.length} 条）`);
  L.push('');
  if (pending.length) {
    L.push('> 请逐条核对"上轮改进是否已验证/落地"。若已落地，输出对应 `- DONE-IMPROVE: <标题>` 行；有新改进项，输出 `- IMPROVE: <标题>（owner: <负责人>）| <说明>` 行。');
    L.push('');
    for (const im of pending) {
      L.push(`- [${im.status}] **${im.title}**（owner: ${im.owner || '?'}，${im.createdAt || ''}）${im.desc ? `：${im.desc.slice(0, 100)}` : ''}`);
    }
  } else {
    L.push('（暂无待办改进项）');
  }
  L.push('');
  const file = path.join(REVIEWS_DIR, `daily-material-${date}.md`);
  fs.writeFileSync(file, L.join('\n'), 'utf8');
  // 清理旧材料
  try {
    const olds = fs.readdirSync(REVIEWS_DIR).filter(f => /^daily-material-.*\.md$/.test(f));
    const keep = cfg.materialKeepDays || 7;
    for (const o of olds) {
      const m = o.match(/daily-material-(\d{4}-\d{2}-\d{2})\.md/);
      if (m && Date.now() - new Date(m[1]).getTime() > keep * 86400000) { try { fs.unlinkSync(path.join(REVIEWS_DIR, o)); } catch (e) {} }
    }
  } catch (e) {}
  return file;
}

/* ── 3. 改进项追踪 config/improvements.jsonl ────────── */
function readImprovements() {
  if (!statOf(IMPROVE_FILE)) return [];
  const out = [];
  for (const l of (readIf(IMPROVE_FILE) || '').split(/\r?\n/)) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch (e) {}
  }
  return out;
}
function appendImprovement(item) {
  ensure(path.dirname(IMPROVE_FILE));
  item.createdAt = item.createdAt || tsISO();
  item.status = item.status || 'pending';
  fs.appendFileSync(IMPROVE_FILE, JSON.stringify(item) + '\n', 'utf8');
  return item;
}

/** 记录一条改进项（owner 默认为 night-worker）。返回是否新增。 */
function recordImprovement(title, owner, desc) {
  if (!title || !title.trim()) return false;
  const improves = readImprovements();
  if (improves.some(i => i.title === title.trim())) return false;   // 去重
  const item = appendImprovement({ title: title.trim(), owner: (owner || 'night-worker').trim(), desc: (desc || '').trim() });
  logActivity(`记录改进项：${item.title}（@${item.owner}）`, `已写入 config/improvements.jsonl (pending)`, '改进');
  return true;
}

/**
 * 例会"上轮改进验证"核对：把标记为 done 的改进项状态更新。
 * @param {Array<string>} doneTitles 例会中确认已落地的改进项标题
 * @returns {string[]} 变更 activity 行
 */
function verifyImprovements(doneTitles) {
  if (!doneTitles || !doneTitles.length) return [];
  const lines = (readIf(IMPROVE_FILE) || '').split(/\r?\n/);
  const changed = [];
  let rewritten = false;
  const out = [];
  const want = new Set(doneTitles.map(t => t.trim()));
  for (const l of lines) {
    if (!l.trim()) { out.push(l); continue; }
    let o; try { o = JSON.parse(l); } catch (e) { out.push(l); continue; }
    if (want.has(o.title) && o.status !== 'done') {
      o.status = 'done';
      o.doneAt = tsISO();
      rewritten = true;
      changed.push(logActivity(`改进项已验证：${o.title}`, `状态 pending→done（config/improvements.jsonl）`, '改进'));
    }
    out.push(JSON.stringify(o));
  }
  if (rewritten) fs.writeFileSync(IMPROVE_FILE, out.join('\n'), 'utf8');
  return changed;
}

/** 从例会/复盘文本中解析改进项行（- IMPROVE: / - DONE-IMPROVE: / - IMPROVE：） */
function parseImproveLines(text) {
  const imps = [];
  const dones = [];
  if (!text) return { imps, dones };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*(?:\[.?\]\s*)?(?:IMPROVE|改进)[:：]\s*(.+)$/i);
    const d = line.match(/^\s*[-*]\s*(?:\[.?\]\s*)?(?:DONE-IMPROVE|已验证|完成改进)[:：]\s*(.+)$/i);
    if (m) {
      const titlePart = m[1].split('（owner:')[0].trim();
      const ownerM = m[1].match(/owner:\s*([\w-]+)/i);
      const sep = m[1].indexOf('|');
      const desc = sep >= 0 ? m[1].slice(sep + 1).trim() : '';
      imps.push({ title: titlePart, owner: ownerM ? ownerM[1] : '', desc });
    } else if (d) {
      dones.push(d[1].split('（')[0].trim());
    }
  }
  return { imps, dones };
}

/** 例会管理组发言 → 记录改进项 + 核对已落地项 */
function recordImprovementsFromMgmt(mgmtResults) {
  const changed = [];
  const dones = [];
  for (const r of Object.values(mgmtResults || {})) {
    if (!r || !r.ok) continue;
    const { imps, dones: ds } = parseImproveLines(r.speech);
    for (const im of imps) { if (recordImprovement(im.title, im.owner, im.desc)) changed.push(`记录改进项: ${im.title}（@${im.owner || 'night-worker'}）`); }
    dones.push(...ds);
  }
  if (dones.length) changed.push(...verifyImprovements(dones));
  return changed;
}

/* ── 主入口（butler 每 5 分钟调用） ─────────────────── */
/**
 * 跑一轮复盘闭环：钩子（DONE→复盘）→ 生成会议材料。
 * @returns {string[]} 新增 activity 行
 */
function check() {
  const cfg = loadCfg();
  if (cfg.enabled === false) return [];
  const changed = [];
  try { changed.push(...scanCompleted()); } catch (e) { log('复盘钩子异常:', e.message); }
  try { dailyReviewMaterial(); } catch (e) { log('复盘材料生成异常:', e.message); }
  return changed;
}

/* ── CLI ───────────────────────────────────────────── */
async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'check') {
    const changed = check();
    console.log('复盘闭环本轮变更', changed.length, '条:');
    for (const l of changed) console.log('  ' + l);
    process.exit(0);
  }
  if (argv[0] === 'summarize') {
    const file = dailyReviewMaterial();
    console.log(file ? `当日复盘材料已生成 → ${file}` : '当日无复盘条目/待办改进项，未生成材料');
    process.exit(0);
  }
  if (argv[0] === 'record') {
    const text = argv.slice(1).join(' ');
    const { imps } = parseImproveLines(text);
    if (!imps.length) { console.log('格式: node lib/review-loop.js record "- IMPROVE: 标题（owner: X）| 说明"'); process.exit(2); }
    for (const im of imps) { const ok = recordImprovement(im.title, im.owner, im.desc); console.log((ok ? '✅ 记录改进项: ' : '⏭ 已存在: ') + im.title + (im.owner ? ' @' + im.owner : '')); }
    process.exit(0);
  }
  if (argv[0] === 'verify') {
    const text = argv.slice(1).join(' ');
    const { dones } = parseImproveLines(text);
    const changed = verifyImprovements(dones);
    console.log(changed.length ? changed.join('\n') : '无改进项被标记 done');
    process.exit(0);
  }
  if (argv[0] === 'link') {
    const task = argv[1];
    const text = argv.slice(2).join(' ');
    if (!task || !text) { console.log('格式: node lib/review-loop.js link <任务名> "<纠正文本>"'); process.exit(2); }
    console.log(associateCorrection(task, text) ? `✅ 已把纠正关联到 ${task} 的 self-review` : `⏭ 今日复盘未找到任务 ${task}，未关联`);
    process.exit(0);
  }
  if (argv[0] === 'test') { runSelfTest(); process.exit(0); }
  console.log('用法: node lib/review-loop.js check | summarize | record "<IMPROVE 行>" | verify "<DONE-IMPROVE 行>" | link <task> "<纠正>" | test');
}

/* ── 内置自检 ─────────────────────────────────────── */
function runSelfTest() {
  const assert = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) process.exitCode = 1; };
  console.log('== review-loop 自检 ==');

  // 场景1：任务完成钩子（DONE → 复盘条目）
  {
    console.log('\n[场景1] 任务完成钩子：DONE → 复盘条目');
    const tmpName = `rlst-${tsStamp()}`;
    const taskFile = path.join(INBOX, `${tmpName}.md`);
    const doneFile = path.join(INBOX, `${tmpName}.DONE`);
    fs.writeFileSync(taskFile, 'agent: mc-dev\nprovider: opencode-go\nmodel: deepseek-v4-flash\n\n# 自检任务\n\n做点东西。\n', 'utf8');
    fs.writeFileSync(doneFile, '自检完成：验证复盘闭环任务完成钩子', 'utf8');
    const state = loadState();
    state.seenDone = state.seenDone || {};
    state.reviewCursor = state.reviewCursor || {};
    delete state.seenDone[`${tmpName}.DONE`];
    delete state.reviewCursor[tmpName];
    saveState(state);
    const before = readReviews(today()).length;
    const changed = scanCompleted();
    const after = readReviews(today());
    const entry = after.find(r => r.task === tmpName);
    assert(!!entry && entry.status === 'success', `DONE → 复盘条目生成（task=${tmpName}, status=${entry && entry.status}）`);
    assert(before === after.length - 1, `复盘条目 append 到 knowledge/reviews/${today()}.jsonl`);
    assert(!!changed.length, `activity [复盘] 留痕`);
    // 幂等：立即再扫 → 不重复
    const again = scanCompleted();
    assert(again.length === 0, `同任务立即再扫不重复复盘（幂等）`);
    // 清理测试产物
    try { fs.unlinkSync(taskFile); } catch (e) {}
    try { fs.unlinkSync(doneFile); } catch (e) {}
    const state2 = loadState();
    if (state2.seenDone) delete state2.seenDone[`${tmpName}.DONE`];
    if (state2.reviewCursor) delete state2.reviewCursor[tmpName];
    saveState(state2);
    // 清理测试复盘条目
    const lines = (readIf(path.join(REVIEWS_DIR, `${today()}.jsonl`)) || '').split(/\r?\n/).filter(l => !(l.includes(tmpName)));
    fs.writeFileSync(path.join(REVIEWS_DIR, `${today()}.jsonl`), lines.join('\n'), 'utf8');
    console.log('  （测试复盘条目已清理）');
  }

  // 场景2：改进项记录 + 去重
  {
    console.log('\n[场景2] 改进项记录 + 去重');
    const title = `review-loop-selftest-改进-${Date.now()}`;
    const ok1 = recordImprovement(title, 'night-worker', '自检改进说明');
    const ok2 = recordImprovement(title, 'night-worker', '重复记录');
    assert(ok1 === true, `新增改进项成功`);
    assert(ok2 === false, `同标题重复记录被去重`);
    // 清理
    const lines = (readIf(IMPROVE_FILE) || '').split(/\r?\n/).filter(l => !l.includes(title));
    fs.writeFileSync(IMPROVE_FILE, lines.join('\n'), 'utf8');
    console.log('  （测试改进项已清理）');
  }

  // 场景3：改进项验证（pending→done）
  {
    console.log('\n[场景3] 改进项验证（例会核对上轮改进）');
    const title = `review-loop-selftest-验证-${Date.now()}`;
    recordImprovement(title, 'night-worker', '自检验证');
    const changed = verifyImprovements([title]);
    assert(changed.length === 1, `改进项被标记 done（change: ${(changed[0] || '').slice(0, 40)}）`);
    const after = readImprovements().find(i => i.title === title);
    assert(after && after.status === 'done', `状态已更新为 done`);
    const lines = (readIf(IMPROVE_FILE) || '').split(/\r?\n/).filter(l => !l.includes(title));
    fs.writeFileSync(IMPROVE_FILE, lines.join('\n'), 'utf8');
    console.log('  （测试改进项已清理）');
  }

  // 场景4：复盘材料生成
  {
    console.log('\n[场景4] 复盘材料生成（例会管理组小会材料）');
    const file = dailyReviewMaterial();
    const exists = statOf(path.join(REVIEWS_DIR, `daily-material-${today()}.md`));
    assert(!!exists, `会议材料文件已生成（${file || '无内容时返回 null，本轮可能无复盘数据'}）`);
  }

  // 场景5：IMPROVE 行解析
  {
    console.log('\n[场景5] IMPROVE/DONE-IMPROVE 行解析');
    const { imps, dones } = parseImproveLines('- IMPROVE: 优化任务超时恢复（owner: server-admin）| 增加看护\n- [x] DONE-IMPROVE: 优化任务超时恢复');
    assert(imps.length === 1 && imps[0].title === '优化任务超时恢复' && imps[0].owner === 'server-admin', `IMPROVE 行解析（title=${imps[0] && imps[0].title} owner=${imps[0] && imps[0].owner}）`);
    assert(dones.length === 1 && dones[0] === '优化任务超时恢复', `DONE-IMPROVE 行解析`);
  }

  // 场景6（2026-08-11 review-loop-v2）：self-review 四问 + 材料自我审查优先 + corrections 关联
  {
    console.log('\n[场景6] self-review 四问 + 材料自我审查优先 + corrections 关联');
    // 6a: buildSelfReview 生成四问
    const srFail = buildSelfReview({ task: 'app-fixes', status: 'failed', problem: '编译失败', agent: '', title: '修 APP 版本' });
    assert(!!srFail.q1 && !!srFail.q2 && !!srFail.q3 && !!srFail.q4, 'buildSelfReview 生成四问（q1-q4 齐全）');
    const srOk = buildSelfReview({ task: 'site-deploy', status: 'success', agent: 'server-admin', title: '部署' });
    assert(!!srOk.q4 && !/❌/.test(srOk.q3), '成功任务 self-review 无违反原则断言');
    // 6b: 违反分工铁律检测（查服务器却未派 server-admin）
    const br = buildSelfReview({ task: 'check-server-ver', status: 'failed', problem: '连不上', agent: '', title: '查服务器版本' });
    assert(/❌|违反分工铁律/.test(br.q3), `违反分工铁律被检出：${br.q3.slice(0, 40)}`);
    // 6c: DONE → 条目带 selfReview 字段
    const tmpName = `rlsr-${tsStamp()}`;
    const taskFile = path.join(INBOX, `${tmpName}.md`);
    const doneFile = path.join(INBOX, `${tmpName}.DONE`);
    fs.writeFileSync(taskFile, 'agent: mc-dev\nprovider: opencode-go\n\n# self-review 自检\n\n干活。\n', 'utf8');
    fs.writeFileSync(doneFile, '自检完成', 'utf8');
    const state = loadState();
    state.seenDone = state.seenDone || {}; state.reviewCursor = state.reviewCursor || {};
    delete state.seenDone[`${tmpName}.DONE`]; delete state.reviewCursor[tmpName];
    saveState(state);
    scanCompleted();
    const rev = readReviews(today()).find(r => r.task === tmpName);
    assert(!!rev && !!rev.selfReview && !!rev.selfReview.q1, `复盘条目带 selfReview 字段（q1=${rev && rev.selfReview && rev.selfReview.q1 && rev.selfReview.q1.slice(0, 30)}）`);
    // 6d: associateCorrection 关联
    const linked = associateCorrection(tmpName, '你该先问用户再动手');
    const rev2 = readReviews(today()).find(r => r.task === tmpName);
    assert(linked === true && rev2.selfReview.corrections.length === 1, `纠正关联到 self-review（corrections=${rev2 && rev2.selfReview.corrections && rev2.selfReview.corrections.length}）`);
    // 6e: 材料含自我审查摘要
    const mfile = dailyReviewMaterial();
    const mtxt = readIf(path.join(REVIEWS_DIR, `daily-material-${today()}.md`)) || '';
    assert(/自我审查摘要/.test(mtxt) && /反省①/.test(mtxt), '例会材料含自我审查摘要 + 反省四问（自我审查优先）');
    // 清理测试产物
    try { fs.unlinkSync(taskFile); } catch (e) {}
    try { fs.unlinkSync(doneFile); } catch (e) {}
    const state2 = loadState();
    if (state2.seenDone) delete state2.seenDone[`${tmpName}.DONE`];
    if (state2.reviewCursor) delete state2.reviewCursor[tmpName];
    saveState(state2);
    const lines = (readIf(path.join(REVIEWS_DIR, `${today()}.jsonl`)) || '').split(/\r?\n/).filter(l => !l.includes(tmpName));
    fs.writeFileSync(path.join(REVIEWS_DIR, `${today()}.jsonl`), lines.join('\n'), 'utf8');
    console.log('  （测试复盘条目已清理）');
  }
}

if (require.main === module) main();

module.exports = { check, scanCompleted, dailyReviewMaterial, recordImprovement, recordImprovementsFromMgmt,
                   verifyImprovements, parseImproveLines, readReviews, readImprovements, loadCfg, buildSelfReview, associateCorrection };
