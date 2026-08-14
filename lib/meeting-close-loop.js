#!/usr/bin/env node
/**
 * lib/meeting-close-loop.js — 例会完整闭环转派器（2026-08-13 meeting-close-loop → meeting-full-close-loop）
 *
 * 背景（用户 2026-08-13 两次指出）：
 *   ① 8/12 例会管理组小会记录了 3 个卡点（patrol.js 缺失 / CNB 桥伪失败 / homepage-v2 状态矛盾），
 *      但例会 = 汇报 + 记录，卡点没转派修复任务 → 闭环断裂。
 *   ② 「例会不只是卡点修复的问题，不是还有后续规划吗，然后自动学习呢？」——
 *      22 个智能体例会里都有「明日计划」（规划类），但无系统转派（靠智能体自己记得，不记得就没了）；
 *      例会内容（经验/教训/新发现）→ learning-officer 提炼→进化的链路未确认。
 *   ③ 「例会=群聊形态 + 闲时智能体主动找活」：例会发现的异常（空转/无任务/低产出/重复）
 *      必须转派处理（激活智能体），不是记录完就完；例会后智能体互相评价提建议。
 *
 * 职责：例会/复盘产出 → 五通道自动闭环（不靠人记得）：
 *   A. 卡点通道：例会/复盘产出的「卡点/风险」→ 自动转派修复任务
 *   B. 计划通道：例会各智能体「明日计划」→ 自动生成待办/任务（转派给对应智能体）
 *      → 与 pending 清单/未办文档打通（计划→任务→销号）
 *   C. 异常通道：例会发现的异常（空转/无任务/低产出/重复）→ 自动转派处理
 *      （激活该智能体：分配 backlog/自查待办/评估合理性）
 *   D. 学习通道：例会内容（经验/教训/新模式/新发现）→ 学习信号落盘
 *      → 转派 learning-officer 提炼（进化/知识库，产出可见）
 *   E. 互评通道：例会后各智能体看他人汇报 → 互相评价/建议/协作提议
 *
 * 接入：
 *   - lib/daily-meeting.js：例会管理组小会后自动调用（主链路，Phase 4.5）
 *   - CLI 手动：node lib/meeting-close-loop.js <meetingFile> [--dry-run] [--force]
 *     （复盘文件 review 也可喂入——复盘卡点同样转派）
 *
 * 状态：logs/meeting-close-loop-state.json（幂等游标，meetingId → { fp: taskName }）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ORG_ROOT   = path.join(__dirname, '..');
const INBOX      = path.join(ORG_ROOT, 'inbox');
const MEETINGS   = path.join(ORG_ROOT, 'knowledge', 'meetings');
const LOGS       = path.join(ORG_ROOT, 'logs');
const STATE_FILE = path.join(LOGS, 'meeting-close-loop-state.json');

const { routeDomain } = require('./domain-route');

const readIf = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const readJsonSafe = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };

/* ── 卡点段提取（A 通道） ────────────────────────────── */

/** 卡点段标题变体：## 2. 卡点/风险 / ## 卡点 / ### 卡点 / ## 卡点 / 风险 … */
const SECTION_RE = /^#{1,4}\s*(?:[0-9]+[\.、)]?\s*)?卡点\s*[/／、]\s*风险\s*$/im;
const SECTION_RE2 = /^#{1,4}\s*(?:[0-9]+[\.、)]?\s*)?卡点\s*$/im;

/** 从会议文本提取卡点条目数组：{ text, lineNo }（支持多智能体多段，遇下一个 ## 标题退段不退出；兼容 CRLF） */
function extractBlockers(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (SECTION_RE.test(l) || SECTION_RE2.test(l)) { inSection = true; continue; }
    if (inSection && /^#{1,4}\s/.test(l)) { inSection = false; continue; }  // 下一节标题 → 退段（继续找下段卡点）
    if (inSection) {
      const m = l.match(/^\s*(?:[-*•]|\d+[\.、)])\s+(.+)$/);
      if (!m) continue;
      const t = m[1].trim();
      if (!t || t === '无' || t === '无。' || /^\(?无[）)]?$/.test(t) || /^（无/.test(t)) continue;
      if (t.length < 6) continue;                          // 过短视为无效条目
      out.push({ text: t, lineNo: i + 1 });
    }
  }
  return out;
}

/* ── 明日计划段提取（B 通道） ────────────────────────── */

/** 计划段标题变体：明日计划 / 明天计划 / 下一步 / 后续计划 … */
const PLAN_SECTION_RE = /^#{1,4}\s*(?:[0-9]+[\.、)]?\s*)?(?:明日|明天|后续|下一步)?\s*(?:计划|规划|安排)\s*$/im;
const PLAN_SECTION_RE2 = /^\*{1,3}\s*[0-9]+\.\s*(?:明日|明天|后续)?\s*(?:计划|规划)\s*\*{1,3}\s*$/im;

/**
 * 从会议文本提取「明日计划」条目：{ agentId, text, lineNo }（按 ## <agentId> 段归属）。
 * 材料结构：## <agentId> → ## 1. 今日做了什么 / ## 2. 卡点/风险 / ## 3. 明日计划
 */
function extractPlans(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let curAgent = 'coo';
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // 智能体段落归属（## <agentId> 或 ### <agentId>）
    const am = l.match(/^#{2,4}\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*$/);
    if (am) { curAgent = am[1]; inSection = false; continue; }
    if (PLAN_SECTION_RE.test(l) || PLAN_SECTION_RE2.test(l)) { inSection = true; continue; }
    if (inSection && /^#{1,4}\s/.test(l)) { inSection = false; continue; }          // 下一节标题
    if (inSection && /^\*{1,3}\s*[0-9]+\./.test(l)) { inSection = false; continue; } // 下一段加粗编号标题
    if (inSection) {
      const m = l.match(/^\s*(?:[-*•]|\d+[\.、)])\s+(.+)$/);
      if (!m) continue;
      const t = m[1].trim();
      if (!t || t === '无' || t === '无。' || /^（无/.test(t) || /^无明日/.test(t)) continue;
      if (t.length < 6) continue;                          // 过短视为无效
      out.push({ agentId: curAgent, text: t, lineNo: i + 1 });
    }
  }
  return out;
}

/* ── 异常发现段提取（C 通道：空转/无任务/低产出/重复） ── */

/** 异常信号词：空转 / 无任务 / 无派发 / 长期无 / 待派 / 低产出 / 重复 … */
const ANOMALY_RE = /空转|无任务|无派发|无派单|没有任务|没任务|长期无|待派发|待派单|等待派单|低产出|产出低|重复(建设|工作|开发)|闲置|无事可做|没活干|未分配/;

/**
 * 从会议文本提取「异常发现」条目（空转/无任务/低产出/重复）。
 * 输出：{ agentId, text, lineNo }
 */
function extractAnomalies(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let curAgent = 'coo';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const am = l.match(/^#{2,4}\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*$/);
    if (am) { curAgent = am[1]; continue; }
    // 只扫条目行（列表项 / 加粗要点），避免整段误命中
    if (!/^\s*(?:[-*•]|\d+[\.、)]|\*\*)/.test(l)) continue;
    if (!ANOMALY_RE.test(l)) continue;
    const t = l.replace(/^\s*(?:[-*•]|\d+[\.、)])\s*/, '').replace(/^\*\*/, '').trim();
    if (t.length < 6) continue;
    out.push({ agentId: curAgent, text: t.slice(0, 200), lineNo: i + 1 });
  }
  return out;
}

/* ── 学习信号提取（D 通道：经验/教训/新模式/新发现） ─── */

/** 学习信号词：经验 / 教训 / 踩坑 / 新发现 / 新模式 / 规律 / 实证 / 结论 … */
const LESSON_RE = /经验|教训|踩坑|新发现|新模式|新方法|规律|实证|结论|沉淀|复盘|可复用|最佳实践/;

/**
 * 从会议文本提取「学习信号」条目（经验/教训/新模式/新发现）。
 * 输出：{ agentId, text, lineNo }
 */
function extractLessons(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let curAgent = 'coo';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const am = l.match(/^#{2,4}\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*$/);
    if (am) { curAgent = am[1]; continue; }
    if (!/^\s*(?:[-*•]|\d+[\.、)]|\*\*)/.test(l)) continue;
    if (!LESSON_RE.test(l)) continue;
    const t = l.replace(/^\s*(?:[-*•]|\d+[\.、)])\s*/, '').replace(/^\*\*/, '').trim();
    if (t.length < 10) continue;
    out.push({ agentId: curAgent, text: t.slice(0, 300), lineNo: i + 1 });
  }
  return out;
}

/* ── 卡点 → 智能体 路由 ─────────────────────────────── */

/** 从异常文本中提取涉及智能体 id（如 "mc-dev-earth 长期空转" → mc-dev-earth）；找不到则用汇报人 */
function anomalyAgentId(text, fallbackAgentId) {
  const m = String(text || '').match(/\b([a-z][a-z0-9_-]{2,40})\b/gi);
  if (m) {
    const reg = require('./registry');
    for (const cand of m) {
      if (reg.getNode(cand.toLowerCase())) return cand.toLowerCase();
    }
  }
  return fallbackAgentId || 'coo';
}

/** 专用卡点路由（先于通用域路由）：框架/巡检/桥类卡点精确归位 */
function routeBlocker(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  // 巡检链/学习进化官/patrol 文件 → learning-officer（自己的工具链自己修）
  if (/patrol|巡检|learning-officer|学习进化/.test(lower)) return 'learning-officer';
  // CNB 桥/执行器/伪失败/代码块判定 → night-worker（框架开发）
  if (/cnb|伪失败|代码块|执行器|投递|pi 模式|cnb-exec|cnb-task/.test(lower)) return 'night-worker';
  // 主页/网站门面/xxssxx.top → xxsx-gateway
  if (/主页|homepage|xxssxx\.top|门面|分享页/.test(lower)) return 'xxsx-gateway';
  // 通用域路由
  const routed = routeDomain({ name: text, content: text });
  return routed || 'coo';
}

/* ── 任务文件生成 ───────────────────────────────────── */

const slugify = s => String(s).replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/**
 * 生成一条卡点修复任务（写 inbox/）。
 * @returns {string} 任务文件名
 */
function dispatchBlockerTask(meetingId, idx, blocker) {
  const agentId = routeBlocker(blocker.text);
  const slug = slugify(blocker.text) || ('card-' + idx);
  const name = `meeting-card-${meetingId}-${String(idx).padStart(2, '0')}-${slug}`;
  const donePath = path.join(INBOX, `${name}.DONE`);
  if (readIf(donePath)) return null;   // 已有终态 → 不重派（幂等）

  const task = [
    `agent: ${agentId}`,
    `meeting-ref: ${meetingId}`,
    ``,
    `# 任务：例会卡点闭环转派（${meetingId} 第 ${idx} 条卡点）`,
    ``,
    `## 背景`,
    `例会/复盘产出的卡点未转派修复会导致闭环断裂（2026-08-13 用户指出）。`,
    `本条卡点由 meeting-close-loop 自动转派给你（路由：${agentId}），请独立修复。`,
    ``,
    `## 卡点原文（第 ${blocker.lineNo} 行）`,
    `> ${blocker.text}`,
    ``,
    `## 任务要求`,
    `1. 定位根因（谁导致/为什么发生）——记录证据`,
    `2. 修复 + 防再犯（机制级，不靠人记得）`,
    `3. 回归验证（修复后验证通过）`,
    `4. 产出：artifacts/${name}.md（根因/修复/验证）`,
    ``,
    `## 注意`,
    `- 禁止全盘 find；改前备份`,
    `- 若卡点已由其他任务修复，验证后如实记录并标注"已修复"`,
    ``,
  ].join('\n');
  fs.mkdirSync(INBOX, { recursive: true });
  fs.writeFileSync(path.join(INBOX, `${name}.md`), task, 'utf8');
  return name;
}

/**
 * 生成一条「明日计划」待办任务（写 inbox/）——转派给计划归属智能体本人。
 * 计划→任务→销号：任务完成 .DONE 即销号；清单同步落 pending 文档。
 * @returns {string} 任务文件名（null=已有终态不重派）
 */
function dispatchPlanTask(meetingId, idx, plan) {
  const agentId = plan.agentId || 'coo';
  const slug = slugify(plan.text) || ('plan-' + idx);
  const name = `meeting-plan-${meetingId}-${String(idx).padStart(2, '0')}-${slug}`;
  const donePath = path.join(INBOX, `${name}.DONE`);
  if (readIf(donePath)) return null;

  const task = [
    `agent: ${agentId}`,
    `meeting-ref: ${meetingId}`,
    `priority: low`,
    ``,
    `# 任务：例会明日计划转派（${meetingId} 第 ${idx} 条）`,
    ``,
    `## 背景`,
    `你在例会中提出的「明日计划」已由 meeting-full-close-loop 自动转派（2026-08-13 用户指出：`,
    `规划类无系统转派、靠智能体自己记得，不记得就没了）。`,
    ``,
    `## 计划原文（第 ${plan.lineNo} 行）`,
    `> ${plan.text}`,
    ``,
    `## 任务要求`,
    `1. 推进本条计划（执行/推进/产出均可，如实记录）`,
    `2. 若计划已因其他原因取消/变更——如实说明并标注原因（不硬做）`,
    `3. 完成后 .DONE 一行摘要（含产出路径）——自动销号`,
    `4. 产出：artifacts/${name}.md（进展/结果/验证）`,
    ``,
    `## 注意`,
    `- 禁止全盘 find；改前备份`,
    `- 本条为例会计划自动转派，若与既有任务重复可合并执行并在摘要注明`,
    ``,
  ].join('\n');
  fs.mkdirSync(INBOX, { recursive: true });
  fs.writeFileSync(path.join(INBOX, `${name}.md`), task, 'utf8');
  return name;
}

/**
 * 生成一条「异常发现」处理任务（写 inbox/）——激活空转/低产出智能体。
 * 例会发现异常 = 必须处理（用户 2026-08-13：不是闲了干等的问题，而是开会发现情况没当成问题处理）。
 * @returns {string} 任务文件名（null=已有终态不重派）
 */
function dispatchAnomalyTask(meetingId, idx, anomaly) {
  const agentId = anomaly.agentId || 'coo';
  const slug = slugify(anomaly.text) || ('anomaly-' + idx);
  const name = `meeting-anomaly-${meetingId}-${String(idx).padStart(2, '0')}-${slug}`;
  const donePath = path.join(INBOX, `${name}.DONE`);
  if (readIf(donePath)) return null;

  const task = [
    `agent: ${agentId}`,
    `meeting-ref: ${meetingId}`,
    `priority: low`,
    ``,
    `# 任务：例会异常发现处理（${meetingId} 第 ${idx} 条）`,
    ``,
    `## 背景`,
    `例会发现该智能体处于异常状态（空转/无任务/低产出/重复），已自动转派处理`,
    `（用户 2026-08-13：例会发现的异常情况必须当成问题处理，不是记录完就完）。`,
    ``,
    `## 异常原文（第 ${anomaly.lineNo} 行）`,
    `> ${anomaly.text}`,
    ``,
    `## 任务要求`,
    `1. 自查：当前是否有积压 backlog/待办可做——有则承接推进`,
    `2. 无 backlog：主动列出可推进事项（向 coo 申请任务或自拟计划）`,
    `3. 若该智能体长期空转/职能重叠——评估其是否合理存在（保留/转型/合并，给出建议）`,
    `4. 产出：artifacts/${name}.md（现状/行动/结论）`,
    ``,
    `## 注意`,
    `- 禁止全盘 find；改前备份`,
    `- 异常处理 = 激活 + 行动，不要只写一句"知道了"`,
    ``,
  ].join('\n');
  fs.mkdirSync(INBOX, { recursive: true });
  fs.writeFileSync(path.join(INBOX, `${name}.md`), task, 'utf8');
  return name;
}

/**
 * 生成一条「学习信号提炼」任务（写 inbox/）——转派 learning-officer 提炼进化。
 * @returns {string} 任务文件名（null=已有终态不重派）
 */
function dispatchLearningTask(meetingId, idx, lesson) {
  const agentId = 'learning-officer';
  const slug = slugify(lesson.text) || ('lesson-' + idx);
  const name = `meeting-learn-${meetingId}-${String(idx).padStart(2, '0')}-${slug}`;
  const donePath = path.join(INBOX, `${name}.DONE`);
  if (readIf(donePath)) return null;

  const task = [
    `agent: ${agentId}`,
    `meeting-ref: ${meetingId}`,
    ``,
    `# 任务：例会学习信号提炼（${meetingId} 第 ${idx} 条）`,
    ``,
    `## 背景`,
    `例会内容中的经验/教训/新模式/新发现需要提炼沉淀（2026-08-13 用户指出：例会不只有卡点，`,
    `还有自动学习——例会内容→提炼→进化）。你是学习进化官，负责提炼与进化。`,
    ``,
    `## 信号原文（第 ${lesson.lineNo} 行，来自 ${lesson.agentId}）`,
    `> ${lesson.text}`,
    ``,
    `## 任务要求`,
    `1. 提炼：判断该信号属于经验/教训/新模式/新发现中的哪类，一句话概括`,
    `2. 沉淀：按规范写入知识库（pitfalls.md / conventions.md / 或 artifacts 学习档案），产出可见`,
    `3. 进化：若构成进化信号（用户纠正/新决策模式/可复用工作流）→ 走 pi-evolution 草稿机制`,
    `4. 产出：artifacts/${name}.md（提炼结论/沉淀位置/进化状态）`,
    ``,
    `## 注意`,
    `- 禁止全盘 find；改前备份`,
    `- 学习产出必须可见（knowledge/ 或 artifacts），不能只记在心里`,
    ``,
  ].join('\n');
  fs.mkdirSync(INBOX, { recursive: true });
  fs.writeFileSync(path.join(INBOX, `${name}.md`), task, 'utf8');
  return name;
}

/**
 * 生成「学习信号批量提炼」任务（写 inbox/，1 条/会议）——转派 learning-officer 一次提炼全部信号。
 * 学习信号明细已在 knowledge/meetings/meeting-learn-<meetingId>.md 落盘（产出可见）。
 * @returns {string} 任务文件名（null=已有终态不重派）
 */
function dispatchLearningBatchTask(meetingId, lessons, learningFile) {
  const agentId = 'learning-officer';
  const name = `meeting-learn-${meetingId}-batch`;
  const donePath = path.join(INBOX, `${name}.DONE`);
  if (readIf(donePath)) return null;

  const task = [
    `agent: ${agentId}`,
    `meeting-ref: ${meetingId}`,
    `priority: low`,
    ``,
    `# 任务：例会学习信号批量提炼（${meetingId}，共 ${lessons.length} 条）`,
    ``,
    `## 背景`,
    `例会内容中的经验/教训/新模式/新发现需要提炼沉淀（2026-08-13 用户指出：例会不只有卡点，`,
    `还有自动学习——例会内容→提炼→进化）。你是学习进化官，负责提炼与进化。`,
    ``,
    `## 信号明细（已落盘，产出可见）`,
    `${learningFile}`,
    ``,
    `## 任务要求`,
    `1. 读取信号明细文件，逐条判断类别（经验/教训/新模式/新发现），一句话概括`,
    `2. 分类沉淀：按规范写入知识库（pitfalls.md / conventions.md / 或 artifacts 学习档案），产出可见`,
    `3. 进化：若构成进化信号（用户纠正/新决策模式/可复用工作流）→ 走 pi-evolution 草稿机制`,
    `4. 产出：artifacts/${name}.md（提炼结论/沉淀位置/进化状态汇总表）`,
    ``,
    `## 注意`,
    `- 禁止全盘 find；改前备份`,
    `- 学习产出必须可见（knowledge/ 或 artifacts），不能只记在心里`,
    ``,
  ].join('\n');
  fs.mkdirSync(INBOX, { recursive: true });
  fs.writeFileSync(path.join(INBOX, `${name}.md`), task, 'utf8');
  return name;
}

/**
 * 生成「互评任务」——例会后每个智能体看他人汇报，互相评价/建议/协作提议（用户 2026-08-13）。
 * 为每个「有实质汇报」的智能体生成 1 条互评任务：读全员材料 → 挑 2-3 位其他智能体 → 给建议/协作提议。
 * @returns {string[]} 任务文件名列表
 */
function dispatchPeerReviewTasks(meetingId, materialFile, reporterIds) {
  const names = [];
  for (const agentId of reporterIds) {
    const name = `meeting-peer-${meetingId}-${agentId}`;
    const donePath = path.join(INBOX, `${name}.DONE`);
    if (readIf(donePath)) continue;
    const task = [
      `agent: ${agentId}`,
      `meeting-ref: ${meetingId}`,
      `priority: low`,
      ``,
      `# 任务：例会同侪互评（${meetingId}）`,
      ``,
      `## 背景`,
      `例会不只是汇报——例会后互相评价与交流建议（2026-08-13 用户：`,
      `"有没有后续各个智能体都评价一次以及交流提出建议呢"）。`,
      ``,
      `## 材料`,
      `全员大会纪要（各智能体汇报原文）：${materialFile}`,
      ``,
      `## 任务要求`,
      `1. 阅读全员材料（重点：其他智能体汇报——做了什么/卡点/明日计划）`,
      `2. 挑 2-3 位其他智能体，各给 1 条：建议（改进/优化）或协作提议（可合作事项）`,
      `3. 输出格式（写进 .DONE）：`,
      `   每条一行：@<对方id>: <建议/协作提议>`,
      `4. 也可回应他人对你有意义的提议（简短）`,
      ``,
      `## 注意`,
      `- 材料文件较大时分段读，只挑相关段`,
      `- 建议要具体可执行，不空话`,
      ``,
    ].join('\n');
    fs.mkdirSync(INBOX, { recursive: true });
    fs.writeFileSync(path.join(INBOX, `${name}.md`), task, 'utf8');
    names.push(name);
  }
  return names;
}

/* ── 幂等状态 ───────────────────────────────────────── */

function loadState() { return readJsonSafe(STATE_FILE) || { meetings: {} }; }
function saveState(st) {
  fs.mkdirSync(LOGS, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), 'utf8');
}

/* ── 主流程 ─────────────────────────────────────────── */

/**
 * 例会完整闭环：卡点 + 明日计划 + 异常发现 + 学习信号 四通道自动转派（幂等）+ 清单落盘
 * @param {string} meetingFile 会议文件绝对/相对路径（全员大会纪要素材）
 * @param {object} opts { dryRun, force, peerReview, peerReviewReporterIds }
 *   - peerReview: 是否同时生成互评任务（默认 true，可显式关闭）
 *   - peerReviewReporterIds: 有实质汇报的智能体 id 列表（互评对象；缺省自动从材料提取）
 * @returns {{
 *   meetingId, blockers, plans, anomalies, lessons,
 *   dispatched, skipped, existing, peerTasks, reportFile, learningFile
 * }}
 */
function runFullCloseLoop(meetingFile, opts = {}) {
  const { dryRun = false, force = false, peerReview = true, peerReviewReporterIds = null } = opts;
  const abs = path.resolve(ORG_ROOT, meetingFile);
  const text = readIf(abs);
  if (!text) throw new Error(`会议文件不存在: ${abs}`);

  const meetingId = path.basename(abs, '.md').replace(/^meeting-close-loop-/, '').replace(/-material$/, '');
  const blockers = extractBlockers(text);
  const plans = extractPlans(text);
  const anomalies = extractAnomalies(text);
  const lessons = extractLessons(text);
  const state = loadState();
  const seen = (state.meetings[meetingId] || {});
  const dispatched = [], skipped = [], existing = [];
  const crypto = require('crypto');

  // 统一幂等处理：三通道逐条（卡点/计划/异常）+ 学习批量
  const channels = [
    { key: 'card',  items: blockers,  gen: dispatchBlockerTask },
    { key: 'plan',  items: plans,     gen: dispatchPlanTask },
    { key: 'anom',  items: anomalies, gen: dispatchAnomalyTask },
  ];
  for (const ch of channels) {
    ch.items.forEach((item, i) => {
      const fp = crypto.createHash('sha1').update(ch.key + ':' + item.text).digest('hex').slice(0, 12);
      const agentId = ch.key === 'plan' ? (item.agentId || 'coo')
        : ch.key === 'anom' ? anomalyAgentId(item.text, item.agentId || 'coo')
        : routeBlocker(item.text);
      if (!force && seen[fp]) {
        skipped.push({ kind: ch.key, text: item.text, agentId, taskName: seen[fp], reason: '已转派（幂等）' });
        return;
      }
      if (dryRun) {
        dispatched.push({ kind: ch.key, text: item.text, agentId,
          taskName: `meeting-${ch.key === 'anom' ? 'anomaly' : ch.key === 'plan' ? 'plan' : 'card'}-${meetingId}-${String(i + 1).padStart(2, '0')}-${slugify(item.text).slice(0, 40)}` });
        return;
      }
      const taskName = ch.gen(meetingId, i + 1, item);
      if (!taskName) {
        skipped.push({ kind: ch.key, text: item.text, agentId, reason: '任务已有终态标记' });
        return;
      }
      seen[fp] = taskName;
      dispatched.push({ kind: ch.key, text: item.text, agentId, taskName });
    });
  }

  // 学习通道（D）：批量 1 条任务（避免 19 条信号 = 19 个任务的信号风暴）
  let learningTask = null;
  let learningFile = null;
  if (lessons.length) {
    // 学习信号明细先落盘（产出可见，learning-officer 提炼输入）
    fs.mkdirSync(MEETINGS, { recursive: true });
    learningFile = path.join(MEETINGS, `meeting-learn-${meetingId}.md`);
    const LL = [
      `# 例会学习信号（${meetingId}）——待 learning-officer 提炼`,
      ``,
      `> 由 meeting-full-close-loop 自动提取（D 通道），批量转派 \`meeting-learn-${meetingId}-batch\` 任务提炼进化。`,
      ``,
      ...lessons.map((l, i) => `## ${i + 1}. ${l.agentId}（第 ${l.lineNo} 行）\n> ${l.text}\n`),
      ``,
    ].join('\n');
    fs.writeFileSync(learningFile, LL, 'utf8');
    if (!dryRun) {
      const fp = crypto.createHash('sha1').update('learn:' + lessons.map(l => l.text).join('|')).digest('hex').slice(0, 12);
      if (!force && seen[fp]) {
        skipped.push({ kind: 'learn', text: `学习信号×${lessons.length}`, agentId: 'learning-officer', taskName: seen[fp], reason: '已转派（幂等）' });
      } else {
        const taskName = dispatchLearningBatchTask(meetingId, lessons, learningFile);
        if (taskName) { seen[fp] = taskName; dispatched.push({ kind: 'learn', text: `学习信号×${lessons.length}`, agentId: 'learning-officer', taskName }); }
        else skipped.push({ kind: 'learn', text: `学习信号×${lessons.length}`, agentId: 'learning-officer', reason: '任务已有终态标记' });
      }
    } else {
      dispatched.push({ kind: 'learn', text: `学习信号×${lessons.length}`, agentId: 'learning-officer', taskName: `meeting-learn-${meetingId}-batch` });
    }
  }

  // 互评通道（E）：生成互评任务（不占用幂等游标——按任务文件终态判断）
  let peerTasks = [];
  if (peerReview) {
    const reporterIds = peerReviewReporterIds
      || Array.from(new Set(plans.map(p => p.agentId).concat(anomalies.map(a => a.agentId)).concat(lessons.map(l => l.agentId))))
      || null;
    // 无实质汇报可评价时跳过
    if (reporterIds && reporterIds.length >= 2 && !dryRun) {
      peerTasks = dispatchPeerReviewTasks(meetingId, abs, reporterIds);
    }
  }

  if (!dryRun && dispatched.length) {
    state.meetings[meetingId] = seen;
    saveState(state);
    // 转派清单（含四通道 + 互评）
    const L = [
      `# 例会完整闭环转派清单（${meetingId}）`,
      ``,
      `由 lib/meeting-close-loop.js（meeting-full-close-loop）自动生成：例会产出 → 五通道自动闭环`, `（卡点→修复 / 明日计划→待办 / 异常发现→激活 / 学习信号→提炼 / 例后互评）。`,
      ``,
      `## 一、卡点转派 ${dispatched.filter(d => d.kind === 'card').length} 条`,
      ...dispatched.filter(d => d.kind === 'card').map(d => `- **${d.agentId}** \`${d.taskName}\` ← ${d.text.slice(0, 120)}`),
      ``,
      `## 二、明日计划转派 ${dispatched.filter(d => d.kind === 'plan').length} 条`,
      ...dispatched.filter(d => d.kind === 'plan').map(d => `- **${d.agentId}** \`${d.taskName}\` ← ${d.text.slice(0, 120)}`),
      ``,
      `## 三、异常发现转派 ${dispatched.filter(d => d.kind === 'anom').length} 条`,
      ...dispatched.filter(d => d.kind === 'anom').map(d => `- **${d.agentId}** \`${d.taskName}\` ← ${d.text.slice(0, 120)}`),
      ``,
      `## 四、学习信号转派 ${dispatched.filter(d => d.kind === 'learn').length} 条`,
      ...dispatched.filter(d => d.kind === 'learn').map(d => `- **learning-officer** \`${d.taskName}\` ← ${d.text.slice(0, 120)}`),
      ``,
      peerTasks.length ? `## 五、例后互评 ${peerTasks.length} 人\n${peerTasks.map(t => `- \`${t}\``).join('\n')}\n` : '',
      ``,
      `## 六、明日计划待办汇总（计划→任务→销号）`,
      ``,
      `> 上表「二、明日计划转派」中每条任务完成 .DONE 即自动销号；本段供 pending 清单/未办文档引用。`,
      ``,
      `| # | 负责人 | 计划（转派任务） | 状态 |`,
      `|---|--------|-----------------|------|`,
      ...dispatched.filter(d => d.kind === 'plan').map((d, i) => `| ${i + 1} | ${d.agentId} | ${d.text.slice(0, 50)}（\`${d.taskName}\`） | ⏳ 待执行 |`),
      ``,
      skipped.length ? `## 跳过 ${skipped.length} 条（幂等/已有终态）\n${skipped.map(s => `- [${s.kind}] ${s.text.slice(0, 80)}（${s.reason}）`).join('\n')}\n` : '',
    ].join('\n');
    fs.mkdirSync(MEETINGS, { recursive: true });
    const reportFile = path.join(MEETINGS, `meeting-close-loop-${meetingId}.md`);
    fs.writeFileSync(reportFile, L, 'utf8');
    return { meetingId, blockers, plans, anomalies, lessons, dispatched, skipped, existing, peerTasks, reportFile, learningFile };
  }
  return { meetingId, blockers, plans, anomalies, lessons, dispatched, skipped, existing, peerTasks, reportFile: null, learningFile };
}

/** 兼容旧入口：只跑卡点通道（meeting-close-loop 原行为） */
function runCloseLoop(meetingFile, opts = {}) {
  const { dryRun = false, force = false } = opts;
  const abs = path.resolve(ORG_ROOT, meetingFile);
  const text = readIf(abs);
  if (!text) throw new Error(`会议文件不存在: ${abs}`);
  const meetingId = path.basename(abs, '.md').replace(/^meeting-close-loop-/, '').replace(/-material$/, '');
  const blockers = extractBlockers(text);
  const state = loadState();
  const seen = (state.meetings[meetingId] || {});
  const dispatched = [], skipped = [], existing = [];
  const crypto = require('crypto');
  blockers.forEach((b, i) => {
    const fp = crypto.createHash('sha1').update('card:' + b.text).digest('hex').slice(0, 12);
    const agentId = routeBlocker(b.text);
    if (!force && seen[fp]) { skipped.push({ text: b.text, agentId, taskName: seen[fp], reason: '已转派（幂等）' }); return; }
    if (dryRun) { dispatched.push({ text: b.text, agentId, taskName: `meeting-card-${meetingId}-${String(i + 1).padStart(2, '0')}-${slugify(b.text).slice(0, 40)}` }); return; }
    const taskName = dispatchBlockerTask(meetingId, i + 1, b);
    if (!taskName) { skipped.push({ text: b.text, agentId, reason: '任务已有终态标记' }); return; }
    seen[fp] = taskName;
    dispatched.push({ text: b.text, agentId, taskName });
  });
  if (!dryRun && dispatched.length) {
    state.meetings[meetingId] = seen;
    saveState(state);
    const L = [
      `# 例会卡点闭环转派清单（${meetingId}）`, ``,
      `由 lib/meeting-close-loop.js 自动生成（例会/复盘卡点 → 修复任务转派，防闭环断裂）。`, ``,
      `## 转派 ${dispatched.length} 条`,
      ...dispatched.map(d => `- **${d.agentId}** \`${d.taskName}\` ← ${d.text.slice(0, 120)}`), ``,
      skipped.length ? `## 跳过 ${skipped.length} 条（幂等/已有终态）\n${skipped.map(s => `- ${s.text.slice(0, 80)}（${s.reason}）`).join('\n')}\n` : '',
    ].join('\n');
    fs.mkdirSync(MEETINGS, { recursive: true });
    const reportFile = path.join(MEETINGS, `meeting-close-loop-${meetingId}.md`);
    fs.writeFileSync(reportFile, L, 'utf8');
    return { meetingId, blockers, dispatched, skipped, existing, reportFile };
  }
  return { meetingId, blockers, dispatched, skipped, existing, reportFile: null };
}

/* ── CLI ────────────────────────────────────────────── */

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const noPeer = args.includes('--no-peer');
  const fileArg = args.find(a => !a.startsWith('--'));
  if (!fileArg) {
    console.error('用法: node lib/meeting-close-loop.js <会议文件.md> [--dry-run] [--force] [--no-peer]');
    console.error('示例: node lib/meeting-close-loop.js knowledge/meetings/2026-08-12-material.md --dry-run');
    process.exit(2);
  }
  try {
    const r = runFullCloseLoop(fileArg, { dryRun, force, peerReview: !noPeer });
    console.log(`📋 卡点 ${r.blockers.length} | 明日计划 ${r.plans.length} | 异常 ${r.anomalies.length} | 学习信号 ${r.lessons.length}`);
    console.log(`   ｜ 转派 ${r.dispatched.length} | 跳过 ${r.skipped.length} | 互评任务 ${r.peerTasks.length}`);
    r.dispatched.forEach(d => console.log(`  🚀 [${d.kind}] ${d.agentId} → inbox/${d.taskName}.md`));
    r.skipped.forEach(s => console.log(`  ⏭️  [${s.kind}] ${s.agentId}（${s.reason}）`));
    r.peerTasks.forEach(t => console.log(`  🤝 互评 → inbox/${t}.md`));
    if (r.reportFile) console.log(`📄 清单 → ${r.reportFile}`);
    if (r.learningFile) console.log(`🧠 学习信号 → ${r.learningFile}`);
    if (r.blockers.length === 0 && r.plans.length === 0 && r.anomalies.length === 0 && r.lessons.length === 0) {
      console.log('ℹ️ 未提取到任何条目（检查段落格式：## <agentId> + ## 卡点/风险 / ## 明日计划）');
    }
    process.exit(0);
  } catch (e) {
    console.error('meeting-close-loop 异常:', e.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  extractBlockers, extractPlans, extractAnomalies, extractLessons,
  routeBlocker, dispatchBlockerTask, dispatchPlanTask, dispatchAnomalyTask,
  dispatchLearningTask, dispatchLearningBatchTask, dispatchPeerReviewTasks,
  runCloseLoop, runFullCloseLoop,
};
