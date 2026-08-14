#!/usr/bin/env node
/**
 * lib/meeting.js — 框架内圆桌会议（议题讨论）协调器
 *
 * 职责：接收 `type: meeting` 会议任务文件 →
 *       1. 解析议题 + 参会智能体列表
 *       2. 为每个参会智能体投"议题发言"任务（inbox/meeting-<id>-<agent>.md，butler 自动并行派发）
 *       3. 轮询各发言任务 .DONE/.FAILED（收集各方观点）
 *       4. 轻量 LLM 总结（分歧/共识/结论，best-effort，失败降级）
 *       5. 写会议纪要 knowledge/meetings/<id>.md
 *       6. 写主任务 .DONE（一行摘要）
 *
 * 会议任务文件格式（头部）：
 *   type: meeting
 *   meeting: 议题标题          # 或 topic:
 *   participants: a, b, c     # 参会智能体 id 列表（逗号/空格分隔）
 *   initiator: twin           # 主持人（可选，默认 coo）
 *   timeout: 2700             # 会议总超时秒数（可选，默认 2700 = 45min）
 *   ---
 *   （正文 = 议题详情，给参会者看）
 *
 * 用法：
 *   node lib/meeting.js <会议任务.md> [--wait] [--timeout <秒>] [--poll <秒>]
 *
 * 依赖：butler.js 常驻（发言任务由 butler 捡起并行派发）；lib/spawn.js（总结用 pi 子进程）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ORG_ROOT = path.resolve(__dirname, '..');
const INBOX = path.join(ORG_ROOT, 'inbox');
const LOGS = path.join(ORG_ROOT, 'logs');
const AGENTS = path.join(ORG_ROOT, 'agents');
const MEETINGS_DIR = path.join(ORG_ROOT, 'knowledge', 'meetings');

const DEFAULT_TIMEOUT = 2700;   // 45min
const DEFAULT_POLL = 10;        // 秒
const SUMMARY_TIMEOUT = 900;    // 总结任务最多等 15min（2026-08-07 实测：deepseek-v4-flash + thinking max + 长发言 8min 不够）

const readIf = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const ensure = d => fs.mkdirSync(d, { recursive: true });
const now = () => new Date().toLocaleTimeString();

function log(...a) {
  const line = `[${now()}] [meeting] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(LOGS, 'meeting.log'), line + '\n', 'utf8'); } catch (e) {}
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 解析 ─────────────────────────────────────────────── */
function slugify(s) {
  return String(s || '')
    .trim().toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60) || 'meeting';
}

const HEADER_FIELDS = ['type', 'meeting', 'topic', 'participants', 'meeting-participants',
                       'initiator', 'host', 'timeout', 'agent', 'provider', 'model', 'thinking', 'group'];

function parseMeetingTask(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  let topic = null, participants = [], initiator = null, timeoutSec = DEFAULT_TIMEOUT;
  for (const line of lines.slice(0, 20)) {
    let m = line.match(/^(?:meeting|topic)\s*:\s*(.+)/i);
    if (m && !topic) { topic = m[1].trim(); continue; }
    m = line.match(/^(?:participants|meeting-participants|attendees)\s*:\s*(.+)/i);
    if (m && !participants.length) {
      participants = m[1].split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
      continue;
    }
    m = line.match(/^(?:initiator|host)\s*:\s*(.+)/i);
    if (m && !initiator) { initiator = m[1].trim(); continue; }
    m = line.match(/^timeout\s*:\s*(\d+)/i);
    if (m) timeoutSec = Math.max(60, parseInt(m[1], 10));
  }
  // 正文：去掉头部声明行
  const body = lines.filter(l => !new RegExp(`^(${HEADER_FIELDS.join('|')})\\s*:`, 'i').test(l))
                    .join('\n').trim();
  return { topic, participants, initiator, timeoutSec, body, content };
}

/** 读智能体背景（identity.json），用于给发言者提供职责上下文 */
function readAgentBackground(agentId) {
  const idPath = path.join(AGENTS, agentId, 'identity.json');
  const id = (() => { try { return JSON.parse(fs.readFileSync(idPath, 'utf8')); } catch (e) { return null; } })();
  if (!id) return null;
  const parts = [];
  if (id.persona) parts.push(`persona: ${id.persona}`);
  if (id.projectSummary) parts.push(`项目背景: ${id.projectSummary}`);
  if (id.capabilities && id.capabilities.length) parts.push(`能力: ${id.capabilities.join('、')}`);
  if (id.notes) parts.push(`备注: ${id.notes}`);
  if (id.keyPaths) parts.push(`关键路径: ${JSON.stringify(id.keyPaths)}`);
  return parts.join('\n');
}

/* ── 投递发言任务（butler 自动捡起并行派发） ─────────────── */
function writeSpeechTasks(meetingId, meta) {
  const tasks = [];
  for (const agentId of meta.participants) {
    const taskName = `meeting-${meetingId}-${agentId}`;
    const donePath = path.join(INBOX, `${taskName}.DONE`);
    if (readIf(donePath)) { log(`ℹ️ 发言任务 ${taskName} 已有完成标记，跳过投递（幂等）`); continue; }
    const bg = readAgentBackground(agentId);
    const prompt = [
      `agent: ${agentId}`,
      `meeting-ref: ${meetingId}`,
      ``,
      `你是智能体 ${agentId}，受邀参加「智能体集群」圆桌会议，就议题给出你的专业发言。`,
      ``,
      `# 会议信息`,
      `- 会议 ID: ${meetingId}`,
      `- 议题: ${meta.topic || '(无标题)'}`,
      `- 主持人: ${meta.initiator || 'coo'}`,
      ``,
      `# 议题详情`,
      meta.body || '(无正文)',
      bg ? `\n# 你的职责背景（供发言参考）\n${bg}` : '',
      ``,
      `# 你的任务`,
      `1. 基于你的职责/记忆/经验，就议题给出**专业发言**：观点 + 具体方案 + 风险（150-600 字）`,
      `2. 发言要具体可执行，不要空话套话；与议题无关的内容不要写`,
      `3. 完成后创建标记文件（内容 = 你的完整发言，可多行）：${donePath}`,
      `4. 若无法发言，写 ${donePath} 内容为 .FAILED: <原因>`,
      ``,
    ].join('\n');
    fs.writeFileSync(path.join(INBOX, `${taskName}.md`), prompt, 'utf8');
    tasks.push({ agentId, taskName, donePath });
    log(`📨 发言任务已投递: ${taskName} → ${agentId}`);
  }
  return tasks;
}

/* ── 轮询收集发言 ─────────────────────────────────────── */
async function collectSpeeches(tasks, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  const results = {};   // agentId → { taskName, ok, speech, failReason }
  while (Date.now() < deadline) {
    let allDone = true;
    for (const t of tasks) {
      if (results[t.agentId]) continue;
      const done = readIf(t.donePath);
      const failed = readIf(t.donePath.replace(/\.DONE$/, '.FAILED'));
      if (done && !done.includes('.FAILED')) {
        results[t.agentId] = { taskName: t.taskName, ok: true, speech: done.trim() };
        log(`💬 [${t.agentId}] 发言完成 (${done.trim().length} 字)`);
      } else if (done || failed) {
        results[t.agentId] = { taskName: t.taskName, ok: false, failReason: (done || failed).trim().slice(0, 200) };
        log(`⚠️ [${t.agentId}] 发言失败: ${(done || failed).trim().slice(0, 120)}`);
      } else {
        allDone = false;
      }
    }
    if (allDone) break;
    // 进度日志（每 60s 一次）
    const elapsed = Math.round((Date.now() - (deadline - timeoutSec * 1000)) / 1000);
    if (elapsed > 0 && elapsed % 60 < 10) {
      const doneCount = Object.keys(results).length;
      log(`⏳ 会议进行中… ${doneCount}/${tasks.length} 位已发言（${elapsed}s/${timeoutSec}s）`);
    }
    await sleep(DEFAULT_POLL * 1000);
  }
  // 超时未完成者
  for (const t of tasks) {
    if (!results[t.agentId]) {
      results[t.agentId] = { taskName: t.taskName, ok: false, failReason: `超时未发言（>${timeoutSec}s）` };
      log(`⚠️ [${t.agentId}] 发言超时`);
    }
  }
  return results;
}

/* ── LLM 总结（best-effort，失败降级） ─────────────────── */
function summarizeWithLLM(meetingId, meta, results) {
  return new Promise(resolve => {
    try {
      const { spawnAgent } = require('./spawn');
      const summaryTask = `meeting-${meetingId}-summary`;
      const summaryDone = path.join(LOGS, `${summaryTask}.DONE`);
      if (fs.existsSync(summaryDone)) fs.unlinkSync(summaryDone);
      const speeches = Object.entries(results)
        .map(([agentId, r]) => r.ok
          ? `【${agentId}】\n${r.speech}`
          : `【${agentId}】（未发言: ${r.failReason || '?'}）`)
        .join('\n\n');
      const prompt = [
        `你是「智能体集群」圆桌会议记录员，请阅读会议纪要素材，输出结构化总结。`,
        ``,
        `# 议题`,
        meta.topic || '(无标题)',
        ``,
        `# 各方发言（原文）`,
        speeches,
        ``,
        `# 输出要求（严格按以下三段 Markdown 输出，其余什么都不要写）`,
        `## 分歧`,
        `列出各智能体观点明显冲突或侧重点不同的地方（无则写"无明显分歧"）`,
        `## 共识`,
        `列出各方一致或互补认可的点（无则写"无明显共识"）`,
        `## 结论与建议执行任务`,
        `给出会议结论，并列出建议转成的执行任务（格式：- [ ] 任务简述 @责任人）`,
        ``,
        `完成后创建标记文件（内容 = 上述三段总结）：${summaryDone}`,
        `若无法完成，写 ${summaryDone} 内容为 .FAILED: <原因>`,
        ``,
      ].join('\n');
      const child = spawnAgent({ type: 'pi', prompt, cwd: LOGS, name: summaryTask });
      const deadline = Date.now() + SUMMARY_TIMEOUT * 1000;
      const timer = setInterval(() => {
        const done = readIf(summaryDone);
        if (done) {
          clearInterval(timer);
          resolve(done.includes('.FAILED') ? null : done.trim());
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          try { child.kill(); } catch (e) {}
          log('⚠️ 总结任务超时，纪要跳过 LLM 总结');
          resolve(null);
        }
      }, 10000);
    } catch (e) {
      log('⚠️ 总结任务启动失败:', e.message);
      resolve(null);
    }
  });
}

/* ── 写会议纪要 ───────────────────────────────────────── */
function writeMinutes(meetingId, meta, results, summary) {
  ensure(MEETINGS_DIR);
  const ts = new Date();
  const dateStr = ts.toISOString().slice(0, 10);
  const file = path.join(MEETINGS_DIR, `${meetingId}.md`);
  const lines = [];
  lines.push(`# 会议纪要：${meta.topic || '(无标题)'}`);
  lines.push('');
  lines.push(`- 会议 ID: ${meetingId}`);
  lines.push(`- 时间: ${dateStr} ${ts.toTimeString().slice(0, 8)}`);
  lines.push(`- 主持人: ${meta.initiator || 'coo'}`);
  lines.push(`- 参会: ${meta.participants.join('、')}`);
  lines.push(`- 状态: ${Object.values(results).filter(r => r.ok).length}/${Object.keys(results).length} 位发言成功`);
  lines.push('');
  lines.push('## 议题');
  lines.push(meta.body || '(无正文)');
  lines.push('');
  lines.push('## 各方观点');
  for (const agentId of meta.participants) {
    const r = results[agentId];
    lines.push('');
    lines.push(`### ${agentId}`);
    if (r && r.ok) lines.push(r.speech);
    else if (r) lines.push(`（未出席 — ${r.failReason || '发言失败'}）`);
    else lines.push('（未收到发言）');
  }
  lines.push('');
  if (summary) {
    lines.push('## 分歧');
    lines.push('```');
    lines.push(extractSection(summary, '分歧') || '（无）');
    lines.push('```');
    lines.push('');
    lines.push('## 共识');
    lines.push('```');
    lines.push(extractSection(summary, '共识') || '（无）');
    lines.push('```');
    lines.push('');
    lines.push('## 结论与建议执行任务');
    lines.push('```');
    lines.push(extractSection(summary, '结论与建议执行任务') || '（无）');
    lines.push('```');
  } else {
    lines.push('> ⚠️ LLM 总结未生成（见 logs/meeting.log），以下部分请主持人阅读各方观点后补充：');
    lines.push('## 分歧');
    lines.push('（待主持人补充）');
    lines.push('## 共识');
    lines.push('（待主持人补充）');
    lines.push('## 结论与建议执行任务');
    lines.push('（待主持人补充 — 建议格式: - [ ] 任务简述 @责任人）');
  }
  lines.push('');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

function extractSection(text, title) {
  const m = text.match(new RegExp(`##\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`));
  return m ? m[1].trim() : null;
}

/* ── 主流程 ───────────────────────────────────────────── */
function parseArgs(argv) {
  const args = { file: null, wait: true, timeout: DEFAULT_TIMEOUT, poll: DEFAULT_POLL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wait') args.wait = true;
    else if (a === '--no-wait') args.wait = false;
    else if (a === '--timeout') args.timeout = parseInt(argv[++i], 10) || args.timeout;
    else if (a === '--poll') args.poll = Math.max(5, parseInt(argv[++i], 10) || DEFAULT_POLL);
    else if (!a.startsWith('-') && !args.file) args.file = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('用法: node lib/meeting.js <会议任务.md> [--wait] [--timeout <秒>] [--poll <秒>]');
    process.exit(2);
  }
  const taskFile = path.resolve(process.cwd(), args.file);
  if (!fs.existsSync(taskFile)) { console.error('会议任务文件不存在:', taskFile); process.exit(2); }

  const name = path.basename(taskFile, '.md');
  const mainDone = path.join(INBOX, `${name}.DONE`);
  const meta = parseMeetingTask(taskFile);

  if (!meta.topic) { log('❌ 会议任务缺少议题（头部 meeting:/topic: 声明）'); process.exit(2); }
  if (!meta.participants.length) { log('❌ 会议任务缺少参会者（头部 participants: 声明）'); process.exit(2); }

  const meetingId = `${slugify(meta.topic)}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${new Date().toTimeString().slice(0, 2)}${new Date().getMinutes().toString().padStart(2, '0')}`;
  const timeoutSec = Math.min(args.timeout, meta.timeoutSec);
  log(`🎤 会议启动 [${meetingId}] 议题="${meta.topic}" 参会=${meta.participants.join(',')} 超时=${timeoutSec}s`);

  // 1) 投递发言任务
  const tasks = writeSpeechTasks(meetingId, meta);
  if (!tasks.length) {
    log('❌ 无发言任务可投递（参会者可能已在别的会议中或参数错误）');
    fs.writeFileSync(mainDone, '.FAILED: 无发言任务可投递\n', 'utf8');
    process.exit(1);
  }

  if (!args.wait) {
    log('ℹ️ --no-wait 模式，发言任务已投递，会议进程退出（稍后可重跑 --wait 收集）');
    process.exit(0);
  }

  // 2) 轮询收集发言（butler 负责并行派发执行）
  log('⏳ 等待 butler 并行派发发言任务并收集…');
  const results = await collectSpeeches(tasks, timeoutSec);

  // 3) LLM 总结（best-effort）
  const okCount = Object.values(results).filter(r => r.ok).length;
  let summary = null;
  if (okCount > 0) {
    log('🧠 调用 LLM 做会议总结（分歧/共识/结论）…');
    summary = await summarizeWithLLM(meetingId, meta, results);
  }

  // 4) 写纪要 + 完成标记
  const minutesFile = writeMinutes(meetingId, meta, results, summary);
  const summaryLine = `会议完成: 议题="${meta.topic}" 发言 ${okCount}/${tasks.length} 位，纪要 → knowledge/meetings/${path.basename(minutesFile)}`;
  log(`✅ ${summaryLine}`);
  fs.writeFileSync(mainDone, summaryLine + '\n', 'utf8');
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => {
    console.error('meeting.js 异常:', e);
    try {
      fs.writeFileSync(path.join(INBOX, 'meeting-fatal.DONE'), '.FAILED: ' + String(e.message).slice(0, 200) + '\n', 'utf8');
    } catch (_) {}
    process.exit(1);
  });
}

module.exports = { parseMeetingTask, writeSpeechTasks, collectSpeeches, summarizeWithLLM, writeMinutes, slugify, readAgentBackground, DEFAULT_TIMEOUT };
