#!/usr/bin/env node
/**
 * lib/daily-meeting.js — 每日例会协调器（全员大会 → 管理组小会 → 汇报文档 → 自动派发）
 *
 * 触发：butler.js 每日调度器在设定时间（默认 22:00）写 inbox/daily-meeting-<date>.md（type: daily-meeting）
 *       → butler 识别 type=daily-meeting → dispatchDailyMeeting() spawn 本脚本（独立协调进程）
 *
 * 流程：
 *   Phase 1 全员大会：召集所有智能体（grp-cloud 全部 + 管理组全部 + 业务域全部）
 *                     每人发言（做了什么 / 卡点 / 明天计划），butler 并行派发，支持提问（轮次制）
 *   Phase 2 管理组小会：大会纪要给管理组（分身+pm+审核+渠道+学习+框架）
 *                     评估（完成质量/优先级/资源）→ 决策明日任务清单
 *   Phase 3 汇报文档：knowledge/meetings/<date>-daily.md（用户可读）+ 同步 output/
 *   Phase 4 自动派发：解析管理组决策中的任务行 → 写 inbox/ 任务（agent 指定）→ 次日执行
 *
 * 任务文件头部（可选，缺省用 config/daily-meeting.json）：
 *   type: daily-meeting
 *   date: 2026-08-09            # 例会日期（默认今天）
 *   participants: a, b, c       # 全员大会名单（默认 config.participants 或全部业务智能体）
 *   mgmt: a, b, c               # 管理组名单（默认 config.mgmtGroup）
 *   full-only: 1                # 只跑全员大会（跳过小会/派发），调试用
 *   timeout: 3600               # 全员大会总超时秒数（默认 3600 = 60min）
 *   ---
 *   （正文 = 例会说明，可空）
 *
 * 依赖：butler.js 常驻（发言任务由 butler 捡起并行派发）；lib/spawn.js（LLM 总结/决策解析）
 * 日志：logs/<name>.daily-meeting.log（由 butler dispatchDailyMeeting 流式写入）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ORG_ROOT = path.resolve(__dirname, '..');
const INBOX = path.join(ORG_ROOT, 'inbox');
const LOGS = path.join(ORG_ROOT, 'logs');
const AGENTS = path.join(ORG_ROOT, 'agents');
const MEETINGS_DIR = path.join(ORG_ROOT, 'knowledge', 'meetings');
const REVIEWS_DIR = path.join(ORG_ROOT, 'knowledge', 'reviews');
const CONFIG_PATH = path.join(ORG_ROOT, 'config', 'daily-meeting.json');
const OUTPUT_DIR = path.join(ORG_ROOT, '..', 'output');

const DEFAULT_TIMEOUT = 3600;   // 全员大会默认 60min
const DEFAULT_POLL = 10;        // 秒
const MGMT_TIMEOUT = 2700;      // 管理组小会默认 45min

const readIf = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const ensure = d => fs.mkdirSync(d, { recursive: true });
const now = () => new Date().toLocaleTimeString();

/** 剥离任务文件头部（type/date/agent/provider/model/thinking 等 `key: value` 行），只留正文。
 *  2026-08-09 修复：buildDailyPrompt 曾把含 `type: daily-meeting` 的整个任务文件作为 body 拼入
 *  发言任务，导致 butler parseTask 误判发言文件为 daily-meeting 类型 → 递归启动协调器并发写文件污染。 */
function stripTaskHeader(content) {
  if (!content) return '';
  const lines = content.split('\n');
  let start = 0;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    if (/^[a-zA-Z][\w-]*\s*:\s*\S+\s*$/i.test(lines[i].trim())) start = i + 1;
    else if (!lines[i].trim()) { /* 空行跳过，继续找正文起点 */ }
    else break;
  }
  return lines.slice(start).join('\n').replace(/^\s*\n+/, '').trim();
}

function log(...a) {
  const line = `[${now()}] [daily-meeting] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(LOGS, 'daily-meeting.log'), line + '\n', 'utf8'); } catch (e) {}
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 解析任务文件头部 ─────────────────────────────────── */
const HEADER_FIELDS = ['type', 'date', 'participants', 'mgmt', 'full-only', 'timeout', 'meeting', 'topic', 'initiator', 'agent', 'provider', 'model', 'thinking', 'group'];

function parseTask(filePath) {
  const content = readIf(filePath) || '';
  const lines = content.split('\n');
  let date = null, participants = [], mgmt = [], timeoutSec = DEFAULT_TIMEOUT, fullOnly = false;
  for (const line of lines.slice(0, 20)) {
    let m = line.match(/^date\s*:\s*(\S+)/i);
    if (m && !date) { date = m[1].trim(); continue; }
    m = line.match(/^(?:participants|attendees)\s*:\s*(.+)/i);
    if (m && !participants.length) { participants = m[1].split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean); continue; }
    m = line.match(/^mgmt\s*:\s*(.+)/i);
    if (m && !mgmt.length) { mgmt = m[1].split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean); continue; }
    m = line.match(/^full-only\s*:\s*(\d+)/i);
    if (m) { fullOnly = m[1] === '1' || m[1].toLowerCase() === 'true'; continue; }
    m = line.match(/^timeout\s*:\s*(\d+)/i);
    if (m) timeoutSec = Math.max(120, parseInt(m[1], 10));
  }
  if (!date) date = new Date().toISOString().slice(0, 10);
  return { date, participants, mgmt, timeoutSec, fullOnly, content };
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { return {}; }
}

/* ── 解析参会名单 ─────────────────────────────────────── */
/** 全部业务智能体（默认全员大会名单）：叶子 agent 节点（有 spawnType、非 grp-*、排除测试节点） */
function defaultAllParticipants() {
  const registry = require('./registry');
  const data = registry.load();
  const nodes = data.nodes || {};
  const ids = Object.keys(nodes).filter(id => {
    const n = nodes[id];
    if (!n || !n.spawnType) return false;                    // 组节点（grp-*）无 spawnType
    if (id.startsWith('grp-')) return false;
    if (['sync-test-hk', 'claude', 'ds-bridge'].includes(id)) return false;  // 测试/兜底节点
    if (n.spawnType === 'chatroom') return false;  // 观察员由聊天室系统驱动，butler 例会不派发（2026-08-13 防崩）
    return true;
  });
  return ids;
}

/** 读智能体背景（identity.json） */
function readAgentBackground(agentId) {
  const idPath = path.join(AGENTS, agentId, 'identity.json');
  const id = (() => { try { return JSON.parse(fs.readFileSync(idPath, 'utf8')); } catch (e) { return null; } })();
  if (!id) return null;
  const parts = [];
  if (id.persona) parts.push(`persona: ${id.persona}`);
  if (id.projectSummary) parts.push(`项目背景: ${id.projectSummary}`);
  if (id.capabilities && id.capabilities.length) parts.push(`能力: ${id.capabilities.join('、')}`);
  if (id.notes) parts.push(`备注: ${id.notes}`);
  return parts.join('\n');
}

/* ── 发言任务（大会：每日汇报；小会：管理评估） ─────────── */
function writeSpeechTask(taskName, agentId, prompt, donePath) {
  if (readIf(donePath)) { log(`ℹ️ 发言任务 ${taskName} 已有完成标记，跳过（幂等）`); return false; }
  fs.writeFileSync(path.join(INBOX, `${taskName}.md`), prompt, 'utf8');
  log(`📨 发言任务已投递: ${taskName} → ${agentId}`);
  return true;
}

/** 全员大会：每人做当日汇报（做了什么/卡点/明天计划） */
function buildDailyPrompt(meetingId, agentId, body, donePath) {
  const bg = readAgentBackground(agentId);
  return [
    `agent: ${agentId}`,
    `meeting-ref: ${meetingId}`,
    ``,
    `你是智能体 ${agentId}，参加「智能体集群」${meetingId} 每日例会（全员大会）。`,
    ``,
    `# 例会说明`,
    `今天是${meetingId}。请按每日例会格式做你的当日汇报，供全员交流与管理组评估。`,
    body || '(无附加说明)',
    bg ? `\n# 你的职责背景\n${bg}` : '',
    ``,
    `# 请按以下格式输出你的当日汇报（每人 2-3 条摘要级，简洁不灌水）`,
    `1. **今日做了什么**：列出 2-3 条本日实际完成/推进的事项（含成果/数据/文件路径）`,
    `2. **卡点/风险**：若有时列出（技术/资源/依赖），无则写"无"`,
    `3. **明日计划**：列出 2-3 条明日打算推进的事项`,
    `（若你今日无实际工作，如实简短说明即可，不要编造。）`,
    ``,
    `完成后创建标记文件（内容 = 你的完整当日汇报）：${donePath}`,
    `若无法完成，写 ${donePath} 内容为 .FAILED: <原因>`,
    ``,
  ].join('\n');
}

/** 管理组小会：读大会纪要素材 → 评估 → 决策明日任务清单 */
function buildMgmtPrompt(meetingId, agentId, materialFile, donePath) {
  const bg = readAgentBackground(agentId);
  return [
    `agent: ${agentId}`,
    `meeting-ref: ${meetingId}`,
    ``,
    `你是智能体 ${agentId}（管理组成员），参加「智能体集群」${meetingId} 每日例会的**管理组小会**。`,
    ``,
    `# 会议材料`,
    `请先阅读全员大会纪要（各方发言原文）：`,
    materialFile,
    ...(function() {
      // 自动复盘材料（review-loop）：当日任务复盘 + 待验证改进项，若存在则一并给管理组阅读
      const reviewFile = path.join(REVIEWS_DIR, `daily-material-${meetingId}.md`);
      if (fs.existsSync(reviewFile)) {
        return [`\n# 复盘材料（review-loop 自动生成，请阅读并处理）`,
          reviewFile,
          ``,
          `复盘材料中的改进项请逐条核对「是否已验证/落地」：`,
          `- 已落地 → 输出 \`- DONE-IMPROVE: <改进项标题>\` 行`,
          `- 需要新增改进 → 输出 \`- IMPROVE: <标题>（owner: <负责人>）| <说明>\` 行`];
      }
      return [`\n（今日暂无 review-loop 复盘材料）`];
    })(),
    ``,
    `# 你的任务（管理组评估 + 决策明日任务清单）`,
    `基于全员发言，以你的管理职责视角（${agentId}）做评估并决策：`,
    `1. **完成质量评估**：今日整体完成情况如何？哪些做得好？哪些质量欠缺/需整改？`,
    `2. **优先级判断**：哪些事项应列为明日最高优先级？哪些可暂缓？`,
    `3. **资源/风险提示**：发现哪些资源瓶颈或风险需关注？`,
    `4. **明日任务清单**：以严格的机器可解析格式输出（供自动派发）：`,
    `   每行一条，格式：\`- [ ] <任务标题>（agent: <负责人>）| <任务目标/说明>\``,
    `   - 负责人须是真实智能体 id（如 server-admin / xxsx-gateway / night-worker / pm / reviewer 等）`,
    `   - 说明尽量具体可执行（做什么、产出什么）`,
    `   - 若某项需你自己承担，agent: 填 ${agentId}`,
    `   - 若无明日任务，写"无明日任务"`,
    bg ? `\n# 你的职责背景\n${bg}` : '',
    ``,
    `完成后创建标记文件（内容 = 你的完整小会发言）：${donePath}`,
    `若无法完成，写 ${donePath} 内容为 .FAILED: <原因>`,
    ``,
  ].join('\n');
}

/* ── 轮询收集 ────────────────────────────────────────── */
async function collectSpeeches(tasks, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  const results = {};
  while (Date.now() < deadline) {
    let allDone = true;
    for (const t of tasks) {
      if (results[t.agentId]) continue;
      const done = readIf(t.donePath);
      const failed = readIf(t.donePath.replace(/\.DONE$/, '.FAILED'));
      if (done && !done.includes('.FAILED')) {
        results[t.agentId] = { ok: true, speech: done.trim(), taskName: t.taskName };
        log(`💬 [${t.agentId}] 发言完成 (${done.trim().length} 字)`);
      } else if (done || failed) {
        results[t.agentId] = { ok: false, failReason: (done || failed).trim().slice(0, 200), taskName: t.taskName };
        log(`⚠️ [${t.agentId}] 发言失败: ${(done || failed).trim().slice(0, 120)}`);
      } else { allDone = false; }
    }
    if (allDone) break;
    await sleep(DEFAULT_POLL * 1000);
  }
  for (const t of tasks) {
    if (!results[t.agentId]) {
      results[t.agentId] = { ok: false, failReason: `超时未发言（>${timeoutSec}s）`, taskName: t.taskName };
      log(`⚠️ [${t.agentId}] 发言超时`);
    }
  }
  return results;
}

/* ── 汇报文档（Phase 3） ─────────────────────────────── */
function writeReport(meetingId, meta, allResults, mgmtResults, dispatched) {
  ensure(MEETINGS_DIR);
  const ts = new Date();
  const file = path.join(MEETINGS_DIR, `${meetingId}-daily.md`);
  const allOk = Object.values(allResults).filter(r => r.ok).length;
  const mgmtOk = mgmtResults ? Object.values(mgmtResults).filter(r => r.ok).length : 0;
  const L = [];
  L.push(`# 每日例会：${meetingId}`);
  L.push('');
  L.push(`- 时间: ${ts.toISOString().slice(0, 10)} ${ts.toTimeString().slice(0, 8)}`);
  L.push(`- 全员大会: ${allOk}/${Object.keys(allResults).length} 位智能体汇报`);
  L.push(mgmtResults ? `- 管理组小会: ${mgmtOk}/${Object.keys(mgmtResults).length} 位管理组参与` : '- 管理组小会: 未召开');
  L.push('');
  L.push(`---`);
  L.push('');
  L.push(`## 一、全员大会 · 各智能体汇报`);
  L.push('');
  for (const agentId of Object.keys(allResults)) {
    const r = allResults[agentId];
    L.push(`### ${agentId}`);
    if (r && r.ok) L.push(r.speech);
    else if (r) L.push(`（未出席 — ${r.failReason || '发言失败'}）`);
    else L.push('（未收到发言）');
    L.push('');
  }
  L.push(`---`);
  L.push('');
  if (mgmtResults) {
    L.push(`## 二、管理组小会 · 评估与决策`);
    L.push('');
    for (const agentId of Object.keys(mgmtResults)) {
      const r = mgmtResults[agentId];
      L.push(`### 管理组 · ${agentId}`);
      if (r && r.ok) L.push(r.speech);
      else if (r) L.push(`（未参与 — ${r.failReason || '发言失败'}）`);
      else L.push('（未收到发言）');
      L.push('');
    }
    L.push(`---`);
    L.push('');
  }
  L.push(`## 三、自动派发 · 明日任务清单`);
  L.push('');
  if (dispatched && dispatched.length) {
    for (const d of dispatched) {
      L.push(`- [ ] **${d.title}**（@${d.agent}）— 已投递 inbox/${d.fileName}`);
    }
  } else {
    L.push('（本次未派发任务）');
  }
  L.push('');
  fs.writeFileSync(file, L.join('\n'), 'utf8');
  // 同步一份到 output/
  try {
    ensure(OUTPUT_DIR);
    const outFile = path.join(OUTPUT_DIR, `${meetingId}-daily.md`);
    fs.copyFileSync(file, outFile);
    log(`📄 汇报文档同步到 output/${path.basename(outFile)}`);
  } catch (e) { log('⚠️ 同步到 output/ 失败:', e.message); }
  return file;
}

/* ── 自动派发（Phase 4）：解析管理组任务行 → 写 inbox/ 任务 ── */
/** 从管理组发言文本中提取 - [ ] ...（agent: X）| 说明 行 */
function parseTaskLines(mgmtResults) {
  const tasks = [];
  for (const r of Object.values(mgmtResults)) {
    if (!r.ok) continue;
    for (const raw of (r.speech || '').split('\n')) {
      const line = raw.trim();
      const m = line.match(/^-\s*\[\s*\]\s+(.+)$/);   // 先只确认是任务行
      if (!m) continue;
      let title = m[1].trim();
      // 提取负责人：支持 (agent: X) / （agent：X） / @X
      let agent = null;
      let am = title.match(/[（(]\s*agent\s*[:：]\s*([a-zA-Z0-9_-]+)\s*[)）]/i);
      if (am) {
        agent = am[1];
        title = title.replace(/[（(]\s*agent\s*[:：]\s*[a-zA-Z0-9_-]+\s*[)）]/i, '').trim();
      } else {
        am = title.match(/@\s*([a-zA-Z0-9_-]+)/);
        if (am) { agent = am[1]; title = title.replace(/@\s*[a-zA-Z0-9_-]+/, '').trim(); }
      }
      // 提取说明：| 后为说明（同时兼容｜ 全角竖线）
      let detail = '';
      const dm = title.match(/^(.*?)\s*[|｜]\s*(.*)$/);
      if (dm) { title = dm[1].trim(); detail = dm[2].trim(); }
      if (!title) continue;
      tasks.push({ title, agent: agent || 'coo', detail });
    }
  }
  // 去重（同 agent+title 只留首条）
  const seen = new Set(); const uniq = [];
  for (const t of tasks) {
    const k = `${t.agent}|${t.title}`;
    if (seen.has(k)) continue;
    seen.add(k); uniq.push(t);
  }
  return uniq;
}

function dispatchTasks(meetingId, tasks) {
  const dispatched = [];
  for (const t of tasks) {
    try {
      const slug = t.title.replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
      const ts = new Date().toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, '');
      const name = `nextday-${meetingId}-${slug}-${ts.slice(8)}`;
      const content = [
        `agent: ${t.agent}`,
        `source: daily-meeting-${meetingId}`,
        ``,
        `# 任务（每日例会明日任务清单自动派发）：${t.title}`,
        ``,
        t.detail || `（每日例会 ${meetingId} 决策派发的任务）`,
        ``,
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(INBOX, `${name}.md`), content, 'utf8');
      log(`🚀 已派发任务: ${name} → ${t.agent}（${t.title}）`);
      dispatched.push({ title: t.title, agent: t.agent, detail: t.detail, fileName: `${name}.md` });
    } catch (e) {
      log(`⚠️ 派发任务失败: ${t.title} — ${e.message}`);
    }
  }
  return dispatched;
}

/* ── 主流程 ──────────────────────────────────────────── */
async function main() {
  const taskFile = process.argv[2];
  if (!taskFile) { console.error('用法: node lib/daily-meeting.js <daily-meeting任务.md>'); process.exit(2); }
  if (!fs.existsSync(taskFile)) { console.error('任务文件不存在:', taskFile); process.exit(2); }

  const cfg = loadConfig();
  const meta = parseTask(taskFile);
  const mainDone = path.join(INBOX, `daily-meeting-${meta.date}.DONE`);
  const meetingId = meta.date;

  // 参会名单：任务头部 > 配置 > 默认全部业务智能体
  const participants = meta.participants.length ? meta.participants
    : (cfg.participants && cfg.participants.length ? cfg.participants : defaultAllParticipants());
  const mgmt = meta.mgmt.length ? meta.mgmt : (cfg.mgmtGroup || []);
  const validMgmt = mgmt.filter(id => {
    const registry = require('./registry');
    return !!registry.getNode(id);
  });

  log(`🌙 每日例会启动 [${meetingId}] 全员大会 ${participants.length} 人 | 管理组 ${validMgmt.join(',')} | 超时 ${meta.timeoutSec}s`);
  if (!validMgmt.length) log('⚠️ 管理组名单为空/无效，将只跑全员大会');

  /* ── Phase 1: 全员大会（每日汇报） ───────────────── */
  const allTasks = [];
  for (const agentId of participants) {
    const taskName = `daily-meeting-${meetingId}-${agentId}`;
    const donePath = path.join(INBOX, `${taskName}.DONE`);
    const written = writeSpeechTask(taskName, agentId, buildDailyPrompt(meetingId, agentId, stripTaskHeader(meta.content), donePath), donePath);
    if (written) allTasks.push({ agentId, taskName, donePath });
    else allTasks.push({ agentId, taskName, donePath });   // 幂等跳过也纳入等待（等已有 .DONE）
  }
  const allResults = await collectSpeeches(allTasks, meta.timeoutSec);
  log(`✅ 全员大会结束：${Object.values(allResults).filter(r => r.ok).length}/${allTasks.length} 位汇报`);

  // 写大会纪要素材文件（供管理组阅读）
  const materialFile = path.join(MEETINGS_DIR, `${meetingId}-material.md`);
  {
    ensure(MEETINGS_DIR);
    const L = [`# 全员大会纪要（${meetingId}）`, ``];
    for (const agentId of Object.keys(allResults)) {
      const r = allResults[agentId];
      L.push(`## ${agentId}`);
      L.push(r && r.ok ? r.speech : `（未出席 — ${(r && r.failReason) || '未发言'}）`);
      L.push('');
    }
    fs.writeFileSync(materialFile, L.join('\n'), 'utf8');
    log(`📄 大会纪要素材 → ${materialFile}`);
  }

  if (meta.fullOnly) {
    log(`ℹ️ full-only 模式，跳过管理组小会/派发`);
    const report = writeReport(meetingId, meta, allResults, null, []);
    fs.writeFileSync(mainDone, `例会(大会-only)完成: ${meetingId} 发言 ${Object.values(allResults).filter(r=>r.ok).length}/${allTasks.length} 位，文档 → knowledge/meetings/${path.basename(report)}\n`, 'utf8');
    process.exit(0);
  }

  /* ── Phase 2: 管理组小会（评估 + 决策） ──────────── */
  let mgmtResults = null;
  let dispatched = [];
  if (validMgmt.length) {
    log('🧠 管理组小会开始…');
    const mgmtTasks = [];
    for (const agentId of validMgmt) {
      const taskName = `daily-meeting-${meetingId}-mgmt-${agentId}`;
      const donePath = path.join(INBOX, `${taskName}.DONE`);
      writeSpeechTask(taskName, agentId, buildMgmtPrompt(meetingId, agentId, materialFile, donePath), donePath);
      mgmtTasks.push({ agentId, taskName, donePath });
    }
    mgmtResults = await collectSpeeches(mgmtTasks, MGMT_TIMEOUT);
    log(`✅ 管理组小会结束：${Object.values(mgmtResults).filter(r => r.ok).length}/${mgmtTasks.length} 位参与`);

    /* ── 复盘改进项落盘（review-loop）：例会决议的改进项 → config/improvements.jsonl，供下次例会核对 ─ */
    try {
      const rl = require('./review-loop');
      const improveChanged = rl.recordImprovementsFromMgmt(mgmtResults);
      if (improveChanged && improveChanged.length) log('📝 复盘改进项: ' + improveChanged.join(' | '));
    } catch (e) { log('⚠️ 复盘改进项落盘失败: ' + e.message); }

    /* ── Phase 4: 自动派发明日任务 ───────────────── */
    const parsed = parseTaskLines(mgmtResults);
    if (parsed.length) {
      log(`🚀 解析出 ${parsed.length} 条明日任务，开始派发…`);
      dispatched = dispatchTasks(meetingId, parsed);
    } else {
      log('ℹ️ 管理组未产出可派发的任务行（格式不符或无任务）');
    }

    /* ── Phase 4.5: 例会完整闭环转派（2026-08-13 meeting-full-close-loop）
     *  五通道：卡点→修复 / 明日计划→待办 / 异常发现→激活 / 学习信号→提炼 / 例后互评。
     *  不依赖管理组是否记得把卡点/计划/异常写进任务清单（8/12 教训 + 8/13 用户两次指出）。 ─ */
    try {
      const closeLoop = require('./meeting-close-loop');
      const r = closeLoop.runFullCloseLoop(materialFile, {
        dryRun: false,
        peerReview: true,
        peerReviewReporterIds: Object.keys(allResults).filter(id => allResults[id] && allResults[id].ok),
      });
      if (r) {
        const parts = [];
        if (r.blockers.length) parts.push(`卡点${r.blockers.length}`);
        if (r.plans.length) parts.push(`明日计划${r.plans.length}`);
        if (r.anomalies.length) parts.push(`异常${r.anomalies.length}`);
        if (r.lessons.length) parts.push(`学习信号${r.lessons.length}`);
        log(`🔁 例会完整闭环: ${parts.length ? parts.join('+') : '无条目'} ｜ 转派 ${r.dispatched.length} ｜ 跳过 ${r.skipped.length} ｜ 互评 ${r.peerTasks.length}`);
        dispatched = dispatched.concat(r.dispatched.map(d => d.taskName));
        if (r.learningFile) log(`🧠 学习信号落盘 → ${r.learningFile}`);
      }
    } catch (e) { log('⚠️ 例会完整闭环转派失败: ' + e.message); }
  }

  /* ── Phase 3: 汇报文档 ──────────────────────────── */
  const report = writeReport(meetingId, meta, allResults, mgmtResults, dispatched);

  const summaryLine = `每日例会完成: ${meetingId} 大会 ${Object.values(allResults).filter(r=>r.ok).length}/${allTasks.length} 位，管理组 ${mgmtResults ? Object.values(mgmtResults).filter(r=>r.ok).length + '/' + Object.keys(mgmtResults).length : '未开'} 位，派发任务 ${dispatched.length} 条，文档 → knowledge/meetings/${path.basename(report)}`;
  log(`✅ ${summaryLine}`);
  fs.writeFileSync(mainDone, summaryLine + '\n', 'utf8');
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => {
    console.error('daily-meeting.js 异常:', e);
    try {
      const date = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(path.join(INBOX, `daily-meeting-${date}.DONE`), '.FAILED: ' + String(e.message).slice(0, 200) + '\n', 'utf8');
    } catch (_) {}
    process.exit(1);
  });
}

module.exports = { parseTask, defaultAllParticipants, buildDailyPrompt, buildMgmtPrompt, collectSpeeches, writeReport, parseTaskLines, dispatchTasks, loadConfig, stripTaskHeader };
