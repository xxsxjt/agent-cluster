#!/usr/bin/env node
/**
 * lib/twin-daemon.js — 分身常驻进程（v5.1 核心）
 *
 * 把"分身=主会话窗口"升级为"分身=常驻后台进程"。命令行窗口可关，web 控制台替代交互。
 *
 * 职责：
 *   1. 常驻 pi rpc 子进程（user-twin 人格，cwd=agents/twin，读那里的 AGENTS.md）
 *   2. 可对话：stdin/stdout + 本地 TCP 双通道（JSON lines，协议与 web/server.js chat 兼容）
 *   3. 巡查循环（每 5 分钟）：inbox 新任务/新完成 → 智能体状态 → 安全异常 → activity.log 留痕
 *   4. 单实例锁（org/twin.pid），运行日志 logs/twin-daemon.log
 *
 * 用法：
 *   node lib/twin-daemon.js            # 常驻（detached 由 bootstrap 拉起）
 *   node lib/twin-daemon.js --once     # 只跑一轮巡查就退出（自检用）
 *   node lib/twin-daemon.js --console  # 前台模式：stdin/stdout 直接对话（bootstrap twin console）
 *
 * 通道协议（JSON lines，TCP / stdin 通用）：
 *   收 {"type":"chat","message":"...","id":"c-123"}            # web 控制台对话（写 history + 大脑回复）
 *   收 {"type":"chat-ext","message":"...","role":"user|assistant","id":"c-123"}  # 主会话对话（butler-bridge 转发，已落 history，只触发大脑决策）
 *   发 {"type":"reply","id":"c-123","ok":true,"reply":"...","agentId":"twin","tookMs":123}
 *   收 {"type":"ping"}   → 发 {"type":"pong","ok":true}
 *   收 {"type":"status"} → 发 {"type":"status","ok":true,"running":true,"pid":...,"since":"..."}
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { defaultRoute } = require('./model-router');
const { logActivity, readActivity } = require('./twin-log');

const ORG_ROOT = path.join(__dirname, '..');
const TWIN_DIR = path.join(ORG_ROOT, 'agents', 'twin');
const LOGS     = path.join(ORG_ROOT, 'logs');
const INBOX    = path.join(ORG_ROOT, 'inbox');
const PID_FILE = path.join(ORG_ROOT, 'twin.pid');
const LOG_FILE = path.join(LOGS, 'twin-daemon.log');
const STATE_FILE = path.join(LOGS, 'twin-scan-state.json');   // 巡查对比基线（防重启重复报警）
const BUTLER_PID = path.join(ORG_ROOT, 'butler.pid');
const WEB_PID    = path.join(LOGS, 'web.pid');
const BUTLER_LOG = path.join(LOGS, 'butler.log');
const BOOTSTRAP_JS = path.join(ORG_ROOT, 'scripts', 'bootstrap.js');
/* 管家保活参数（2026-08-10 twin-daemon-keepalive）
 * - 日志停滞阈值：butler.log 最后写入超过该时长（且进程活着）= 疑似卡死 → 触发重启
 * - 防反复窗口/上限：窗口内重启达到上限 → 停止拉起并升级（写 activity + plan） */
const BUTLER_LOG_STALE_MS   = 10 * 60 * 1000;   // 10 分钟无日志 = 疑似死/卡
const BUTLER_RESTART_WINDOW_MS = 5 * 60 * 1000; // 防反复统计窗口（5 分钟）
const BUTLER_RESTART_MAX       = 3;             // 窗口内允许的最大重启次数
const ACTIVE_TABLE = path.join(LOGS, 'active-tasks.json');   // 但管家落盘的运行中任务表（分身兜底异常检测用）
const DISC_DIR    = path.join(INBOX, 'discussion');        // 分身↔管家讨论通道（2026-08-08）
const MEETINGS_DIR = path.join(ORG_ROOT, 'knowledge', 'meetings');
/* 决策委托通道（2026-08-08 决策委托分身）
 * - 子智能体/管家遇决策点 → 写 inbox/decisions/<ts>-<task>.md（问题+上下文+选项）
 * - 分身巡查捡起 → 大脑(user-twin)决策 → 写 <ts>-<task>.decision.md（决策+理由）
 * - 红线（花钱/永久删除/法律/隐私出圈/真实资金）→ 升级用户，分身不代决策
 * - 分身 30 分钟无决策 → 记录"决策超时待用户"（不无限等） */
const DEC_DIR        = path.join(INBOX, 'decisions');
const DEC_TIMEOUT_MS = 30 * 60 * 1000;   // 分身决策超时（30 分钟）→ 待用户
/* 红线正则：分身遇到这些词绝不代决策，升级用户 */
const REDLINE_PATTERNS = [
  /花钱|付费|购买|扣费|付款|充钱|充值|收费|人民币|付款|真金白银|掏钱/i,            // 花钱/付费
  /永久.{0,6}(删除|破坏|销毁)|不可恢复|删库|drop\s+table|rm\s+-rf|清空.{0,4}(库|表|盘)/i,  // 永久删除/破坏
  /法律|违法|刑事|诉讼|侵权|超授权|越权|未授权|违规|犯罪/i,                        // 法律/超授权
  /隐私|个人信息|手机号|身份证|银行卡|支付密码|聊天记录.{0,4}(泄露|出圈)|数据.{0,4}出圈/i,  // 隐私出圈
  /真实资金|转账|打款|实际付款|挪.{0,2}(钱|款)|资金操作/i,                          // 真实资金操作
];

const TCPU_PORT = process.env.TWIN_DAEMON_PORT || 18788;
const POLL_MS   = process.env.TWIN_POLL_MS ? parseInt(process.env.TWIN_POLL_MS, 10) : 5 * 60 * 1000; // 巡查间隔 5 分钟
const REPLY_TIMEOUT_MS = 180 * 1000;   // 单轮对话超时
const SPAWN_WAIT_MS    = 3000;         // pi rpc 首条消息等待（协议要求）
const IDLE_CLOSE_MS    = 30 * 60 * 1000; // pi 子进程空闲自动重启（省夜间窗口额度）
let lastChatExtAt = 0;                 // chat-ext 节流时间戳（60s 冷却）

const PI = process.env.PI_BIN || 'C:/Users/du_ji/AppData/Roaming/npm/pi.cmd';

const readIf = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const statOf = p => { try { return fs.statSync(p); } catch (e) { return null; } };
const ensure = d => fs.mkdirSync(d, { recursive: true });
function tsISO() { return new Date().toISOString(); }
function nowLocal() { return new Date().toLocaleTimeString(); }

function log(...a) {
  const line = `[${nowLocal()}] ${a.join(' ')}`;
  console.log(line);
  try { ensure(LOGS); fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) {}
}

/* ── 单实例锁 ──────────────────────────────────────────── */
function acquireLock() {
  try {
    const existing = readIf(PID_FILE);
    if (existing) {
      const pid = parseInt(existing.trim(), 10);
      try { process.kill(pid, 0); return false; } catch (e) { /* 锁过期 */ }
    }
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
    return true;
  } catch (e) { return false; }
}
function releaseLock() {
  try { fs.unlinkSync(PID_FILE); } catch (e) {}
}

/* ── pi rpc 子进程（分身大脑） ─────────────────────────── */
let brain = null;          // { child, spawnAt, pending, queue, dead, lastActive, stderrTail }
let brainQueue = [];

function spawnBrain() {
  ensure(path.join(TWIN_DIR, 'chat-sessions'));
  const route = defaultRoute();
  brain = {
    child: null, spawnAt: Date.now(), pending: null, queue: [],
    dead: false, lastActive: Date.now(), stderrTail: ''
  };
  const args = ['--mode', 'rpc', '--provider', route.provider, '--model', route.model,
                '--thinking', route.thinking,
                '--session-dir', path.join(TWIN_DIR, 'chat-sessions'), '--name', 'twin-daemon'];
  brain.child = spawn('cmd.exe', ['/c', PI, ...args],
                      { cwd: TWIN_DIR, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  attachBrainStdio(brain);
  log(`🧠 分身大脑启动 (PID=${brain.child.pid}) provider=${route.provider} model=${route.model} thinking=${route.thinking}`);
  return brain;
}

function killBrain(h) {
  if (!h || !h.child || h.dead) return;
  h.dead = true;
  const pid = h.child.pid;
  try { h.child.stdin.end(); } catch (e) {}
  try { h.child.kill('SIGTERM'); } catch (e) {}
  if (pid && process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
  }
}

function failBrainQueue(h, error) {
  const q = h.queue; h.queue = [];
  for (const item of q) { try { item.res({ ok: false, error }, 500); } catch (e) {} }
}

function finishBrainPending(h, result, code) {
  const p = h.pending;
  if (!p) return;
  h.pending = null;
  for (const t of ['timer', 'settleTimer', 'lastTimer']) if (p[t]) clearTimeout(p[t]);
  if (result.ok && result.reply && !p.noRecord) {
    // noRecord=true：主会话对话已由 butler-bridge 落 history，大脑决策不重复写入
    try { fs.appendFileSync(path.join(TWIN_DIR, 'chat', 'history.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), role: 'assistant', content: result.reply }) + '\n', 'utf8'); } catch (e) {}
  }
  h.lastActive = Date.now();
  result.agentId = 'twin';
  result.tookMs = Date.now() - p.startedAt;
  try { p.res(result, code); } catch (e) {}
  const next = h.queue.shift();
  if (next) startBrainTurn(h, next.message, next.res, next.opts);
}

/** 落定：有文本直接回；没文本补一次 get_last_assistant_text */
function settleBrain(h) {
  const p = h.pending;
  if (!p || p.wantLast) return;
  if (p.lastText) return finishBrainPending(h, { ok: true, reply: p.lastText, notes: p.notes.length ? p.notes : undefined });
  p.wantLast = true;
  try {
    h.child.stdin.write(JSON.stringify({ type: 'get_last_assistant_text', id: 'last-' + Date.now() }) + '\n');
  } catch (e) {
    return finishBrainPending(h, { ok: false, error: '拿不到回复内容: ' + e.message }, 500);
  }
  p.lastTimer = setTimeout(() =>
    finishBrainPending(h, { ok: false, error: p.lastErr || '拿不到回复内容（get_last_assistant_text 超时）' }, 502), 15000);
}

function onBrainEvent(h, o) {
  if (o.type === 'response') {
    const p = h.pending;
    if (o.command === 'prompt' && p && o.success === false) {
      return finishBrainPending(h, { ok: false, error: 'prompt 被拒绝: ' + String(o.error || '?').slice(0, 300) }, 500);
    }
    if (o.command === 'get_last_assistant_text' && p && p.wantLast) {
      if (p.lastTimer) { clearTimeout(p.lastTimer); p.lastTimer = null; }
      const txt = (o.success && o.data && typeof o.data.text === 'string') ? o.data.text.trim() : '';
      return finishBrainPending(h, txt ? { ok: true, reply: txt }
        : { ok: false, error: p.lastErr || '拿不到回复内容' }, txt ? undefined : 502);
    }
    return;
  }
  const p = h.pending;
  if (!p) return;
  if (o.type === 'message_end' && o.message) {
    const m = o.message;
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const txt = m.content.filter(c => c && c.type === 'text' && c.text).map(c => c.text).join('\n').trim();
      if (txt) p.lastText = txt;
      if (m.stopReason === 'error' || m.stopReason === 'aborted') {
        p.lastErr = `生成异常结束（stopReason=${m.stopReason}）`;
      }
    }
  } else if (o.type === 'message_update' && o.assistantMessageEvent && o.assistantMessageEvent.type === 'error') {
    p.lastErr = '流错误: ' + String(o.assistantMessageEvent.reason || '?').slice(0, 200);
  } else if (o.type === 'auto_retry_start') {
    p.notes.push(`API 重试第 ${o.attempt || '?'} 次`);
  } else if (o.type === 'auto_retry_end' && o.success === false) {
    p.lastErr = '自动重试失败: ' + String(o.finalError || '?').slice(0, 300);
  } else if (o.type === 'agent_end') {
    if (!o.willRetry && !p.settleTimer) {
      p.settleTimer = setTimeout(() => settleBrain(h), 5000);
    }
  } else if (o.type === 'agent_settled') {
    if (p.settleTimer) { clearTimeout(p.settleTimer); p.settleTimer = null; }
    settleBrain(h);
  }
}

function attachBrainStdio(h) {
  let buf = '';
  h.child.stdout.on('data', d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let o = null;
      try { o = JSON.parse(line); } catch (e) { continue; }
      try { onBrainEvent(h, o); } catch (e) { /* 单条事件异常不影响整体 */ }
    }
  });
  h.child.stderr.on('data', d => { h.stderrTail = (h.stderrTail + d.toString('utf8')).slice(-4000); });
  h.child.on('error', e => {
    h.dead = true;
    if (h.pending) finishBrainPending(h, { ok: false, error: '分身大脑启动失败: ' + e.message }, 500);
    failBrainQueue(h, '分身大脑启动失败');
  });
  h.child.on('exit', code => {
    h.dead = true;
    const tail = h.stderrTail ? '\nstderr 尾部: ' + h.stderrTail.slice(-800) : '';
    if (h.pending) finishBrainPending(h, { ok: false, error: `分身大脑意外退出 (code=${code})${tail}` }, 500);
    failBrainQueue(h, '分身大脑已退出');
    log(`⚠ 分身大脑退出 code=${code}，5s 后自动重启`);
    setTimeout(() => { if (brain === h) { brain = null; ensureBrain(); } }, 5000);
  });
}

function ensureBrain() {
  if (brain && brain.child && !brain.dead) return brain;
  return spawnBrain();
}

function startBrainTurn(h, message, res, opts) {
  const p = {
    message, res, startedAt: Date.now(), lastText: '', lastErr: null, notes: [], wantLast: false,
    noRecord: !!(opts && opts.noRecord),
    timer: setTimeout(() => finishBrainPending(h, { ok: false, error: '回复超时（180s）', timeout: true }, 504),
                      REPLY_TIMEOUT_MS)
  };
  h.pending = p;
  const send = () => {
    if (h.pending !== p) return;
    let ok = false;
    try {
      h.child.stdin.write(JSON.stringify({ type: 'prompt', message, id: 'c-' + Date.now(),
                                           streamingBehavior: 'steer' }) + '\n');
      ok = true;
    } catch (e) { /* 下方统一报错 */ }
    if (!ok) finishBrainPending(h, { ok: false, error: '写入分身 stdin 失败' }, 500);
  };
  const wait = SPAWN_WAIT_MS - (Date.now() - h.spawnAt);
  if (wait > 0) setTimeout(send, wait); else send();
}

/** 对外对话入口：返回 Promise<{ok, reply, ...}>。opts.noRecord=true 时不写 history.jsonl */
function brainAsk(message, opts) {
  return new Promise((resolve) => {
    const h = ensureBrain();
    const res = (obj, code) => resolve(Object.assign({ code: code || 200 }, obj));
    if (h.pending || h.queue.length) {
      if (h.queue.length >= 8) return res({ ok: false, error: '分身正忙，队列已满，稍后再试' }, 429);
      h.queue.push({ message, res, opts });
      return;
    }
    startBrainTurn(h, message, res, opts);
  });
}

/** 空闲回收：pi 子进程 30 分钟无对话自动重启（省夜间窗口额度） */
function brainSweep() {
  if (brain && !brain.pending && !brain.queue.length &&
      Date.now() - brain.lastActive > IDLE_CLOSE_MS) {
    log(`分身大脑空闲超过 ${IDLE_CLOSE_MS / 60000} 分钟，已回收（下次对话自动重启）`);
    killBrain(brain);
    brain = null;
  }
}

/* ── 巡查循环 ──────────────────────────────────────────── */
let scanState = { inbox: {}, ports: {}, startup: {}, procs: {} };
try { scanState = JSON.parse(readIf(STATE_FILE) || '{}'); } catch (e) { scanState = {}; }

function saveScanState() {
  try { ensure(LOGS); fs.writeFileSync(STATE_FILE, JSON.stringify(scanState), 'utf8'); } catch (e) {}
}

/** exec 封装（带超时，失败静默） */
function execOut(cmd, args) {
  try {
    const { execFileSync } = require('child_process');
    return String(execFileSync(cmd, args, { stdio: 'pipe', windowsHide: true, timeout: 15000, encoding: 'utf8' }));
  } catch (e) {
    return e && e.stdout ? String(e.stdout) : '';
  }
}

/** 1) inbox 扫描：新任务 / 新完成 → 决策留痕 */
function scanInbox() {
  const now = Date.now();
  const files = readIf ? (fs.existsSync(INBOX) ? fs.readdirSync(INBOX) : []) : [];
  const md = files.filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
  const doneNames = new Set(files.filter(f => f.endsWith('.DONE')).map(f => f.replace(/\.DONE$/, '')));
  const seen = scanState.inbox || {};
  const changed = [];

  for (const name of md) {
    const st = fs.statSync(path.join(INBOX, name + '.md'));
    const key = name + '@' + st.mtimeMs;
    if (seen[name] && seen[name] === key) continue;   // 已记录
    seen[name] = key;
    const doneTxt = doneNames.has(name) ? (readIf(path.join(INBOX, name + '.DONE')) || '').trim() : null;
    if (doneTxt != null) {
      const ok = !/\.FAILED/i.test(doneTxt);
      const line = logActivity(`任务 ${ok ? '✅' : '❌'} ${name} 完成，分身验收`,
        ok ? `摘要：${doneTxt.slice(0, 120)}` : doneTxt.slice(0, 120), '验收');
      changed.push(line);
      // 深度验收：结果质量 + 完善空间 → 生成讨论议题（分身-管家监督闭环）
      changed.push(...acceptTask(name, doneTxt));
      (scanState.deepAccepted || (scanState.deepAccepted = {}))[name] = tsStamp();
      // 同步记录 DONE 已验收（防 doneNames 循环重复）
      try {
        const dSt = fs.statSync(path.join(INBOX, name + '.DONE'));
        seen['__done__' + name] = name + '@done@' + dSt.mtimeMs;
      } catch (e) {}
    } else {
      const agent = (readIf(path.join(INBOX, name + '.md')) || '').split('\n')[0] || '';
      const line = logActivity(`发现新任务 ${name} → 决策：交管家按路由派发，分身盯梢验收`,
        agent.replace(/^agent\s*:\s*/i, '目标: ').slice(0, 80), '决策');
      changed.push(line);
    }
  }
  // 记录 DONE 但 md 已清（任务被归档）；或 DONE 新增但 md 未变（任务完成待验收）
  for (const name of doneNames) {
    const donePath = path.join(INBOX, name + '.DONE');
    const dSt = statOf(donePath);
    const dKey = dSt ? name + '@done@' + dSt.mtimeMs : name + '@done@?';  // DONE mtime 变化=新验收事件
    if (seen['__done__' + name] && seen['__done__' + name] === dKey) continue;  // 已验收过这份 DONE
    seen['__done__' + name] = dKey;
    const doneTxt = (readIf(donePath) || '').trim();
    if (!md.includes(name)) {
      const line = logActivity(`任务 ${name} 已归档（DONE 留存）`, doneTxt.slice(0, 100), '验收');
      changed.push(line);
    } else {
      const ok = !/\.FAILED/i.test(doneTxt);
      const line = logActivity(`任务 ${ok ? '✅' : '❌'} ${name} 完成，分身验收`,
        ok ? `摘要：${doneTxt.slice(0, 120)}` : doneTxt.slice(0, 120), '验收');
      changed.push(line);
      // 深度验收（同 md 存在路径）
      changed.push(...acceptTask(name, doneTxt));
      (scanState.deepAccepted || (scanState.deepAccepted = {}))[name] = tsStamp();
    }
  }
  scanState.inbox = seen;
  return changed;
}

/* ── 任务验收分析（2026-08-08 分身-管家监督闭环） ─────────── */
// 分身负责"看"：巡查时验收任务完成度，找完善空间/失败，生成讨论议题给管家。
function tsStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 从源任务文件推断建议执行者（agent: 头） */
function detectImprovementAgent(name) {
  const srcMd = readIf(path.join(INBOX, name + '.md')) || '';
  const m = srcMd.match(/^agent\s*:\s*(\S+)/m);
  return m ? m[1] : null;
}

/** 生成讨论议题文件内容 */
function buildDiscussionTopic(name, quality, findings, doneTxt) {
  const suggestAgent = detectImprovementAgent(name) || 'coo';
  const direction = quality === '失败需重派'
    ? `重新派发任务 ${name}：查明失败原因后按原目标重跑，并补足验证证据再收尾。`
    : `针对完善点（${findings[0] || '改进结果质量'}）安排对应智能体补做/补验，完成后回传结果。`;
  return [
    `# 讨论议题：${name} 的验收结论`,
    `- 源任务: ${name}`,
    `- 生成时间: ${tsStamp()}`,
    `- 分身判断: 任务「${name}」验收为「${quality}」。原因：${findings.join('；') || '无'}`,
    `- 原始 DONE 摘要: ${(doneTxt || '').slice(0, 200)}`,
    `- 建议执行者: ${suggestAgent}`,
    `- 建议方向: ${direction}`,
    ``,
    `请管家（butler）阅读此议题并给出响应（同意/调整/驳回+理由）。若同意，请派发完善任务。`,
  ].join('\n');
}

/** 写讨论议题到 inbox/discussion/<ts>-<task>.md */
function writeDiscussionTopic(name, quality, content) {
  try {
    ensure(DISC_DIR);
    const file = path.join(DISC_DIR, `${tsStamp()}-${name}.md`);
    fs.writeFileSync(file, content + '\n', 'utf8');
    return file;
  } catch (e) { log('写讨论议题失败:', e.message); return null; }
}

/**
 * 验收单个任务：输出 [验收] 结论；有完善空间/失败且非 -improve 循环任务 → 生成讨论议题。
 * 返回新增 activity 行数组。
 */
function acceptTask(name, doneTxt) {
  const lines = [];
  const t = (doneTxt || '').trim();
  const isFailed = /\.FAILED/i.test(t);
  const findings = [];
  let strongTrigger = false;   // 是否强信号（触发讨论议题），避免纯摘要过简刷议题
  let quality = '好';

  if (isFailed) {
    quality = '失败需重派';
    strongTrigger = true;
    findings.push('任务标记为失败/未完成');
  } else {
    // 1) 摘要是否写清楚做了什么
    const summary = t.split(/\r?\n/)[0] || '';
    if (summary.length < 15) { quality = '有完善空间'; findings.push('结果摘要过简，未说明具体做了什么'); }
    // 2) 声称完成但缺验证证据（terraria-world2-fix 教训：DONE 谎报）——仅对短摘要判定，详细 DONE 已含实质证据
    const verifyWords = ['验证', '确认', '测试', 'active', '监听', '端口', '可达', '证据', '检查', '实测', '通过', '成功', 'OK', '运行', 'done', '闭环', '渲染'];
    const hasVerify = verifyWords.some(w => t.toLowerCase().includes(w));
    const claimsDone = /完成|成功|已|搞定|生效/.test(t);
    if (claimsDone && !hasVerify && t.length < 80) {
      quality = '有完善空间'; strongTrigger = true;
      findings.push('声称完成但缺少验证证据（易谎报，如 terraria-world2-fix 教训）');
    }
    // 3) 明确遗留完善点关键词（强信号：截断/未应用/未生效等）。排除否定语境：无截断/不截断/完整/历史遗留。
    const notFlagged = /无截断|不截断|未截断|完整|已生效|不影响/.test(t);
    const improveWords = ['未做', '没做', '未应用', '未生效', '尚未', '待优化', '待办', '未验证', '截断', '没生效', '未包含', '待后续', '未完成'];
    let hit = improveWords.find(w => t.includes(w));
    if (hit === '截断' && notFlagged) hit = null;
    if (hit) {
      quality = '有完善空间'; strongTrigger = true;
      const idx = t.indexOf(hit);
      findings.push(`遗留完善点「${hit}」：…${t.slice(Math.max(0, idx - 12), idx + 16)}…`);
    }
    if (!findings.length) quality = '好';
  }

  const emoji = isFailed ? '❌' : (quality === '好' ? '✅' : '⚠️');
  lines.push(logActivity(`[验收] 任务 ${name} ${emoji} 完成质量：${quality}`,
    findings.length ? findings.join('；') : '验收通过，无完善空间', '验收'));

  // 强信号 + 非 -improve 循环任务 → 生成讨论议题（去重：同一任务只议一次）
  const seen = scanState.discussions || {};
  const discKey = 'disc:' + name;
  const isImprove = /-improve$/.test(name);   // 完善任务本身不再无限循环派发
  if (strongTrigger && !isImprove && !seen[discKey]) {
    seen[discKey] = tsStamp();
    scanState.discussions = seen;
    const topicFile = writeDiscussionTopic(name, quality, buildDiscussionTopic(name, quality, findings, doneTxt));
    if (topicFile) lines.push(logActivity(`[验收] 已为任务 ${name} 生成讨论议题`, topicFile, '验收'));
  }
  return lines;
}

/** 存量回填：对历史/已 seen 的 DONE 一次性补深度验收（避免旧代码漏验收，terraria-world2-seed 等） */
function deepAcceptExisting() {
  const lines = [];
  if (!fs.existsSync(INBOX)) return lines;
  const acc = scanState.deepAccepted || {};
  const files = fs.readdirSync(INBOX).filter(f => f.endsWith('.DONE'));
  for (const f of files) {
    const name = f.replace(/\.DONE$/, '');
    if (acc[name]) continue;
    acc[name] = tsStamp();
    lines.push(...acceptTask(name, readIf(path.join(INBOX, f)) || ''));
  }
  scanState.deepAccepted = acc;
  return lines;
}

/** 分身读取管家响应（discussion/*.reply.md）→ 记 [讨论] 并归档，闭环 */
function scanDiscussionReplies() {
  const changed = [];
  if (!fs.existsSync(DISC_DIR)) return changed;
  const files = fs.readdirSync(DISC_DIR).filter(f => f.endsWith('.reply.md'));
  for (const f of files) {
    const content = readIf(path.join(DISC_DIR, f)) || '';
    const decisionLine = content.split(/\r?\n/).find(l => /决策|响应|处理/.test(l)) || content.split(/\r?\n/)[0] || '';
    // 睡眠模式：管家把派发转计划文档（讨论照常，待启动派发）—— 在 activity 中注明
    const isPlanMode = /计划文档|睡眠模式|待启动派发/.test(content);
    changed.push(logActivity(`[讨论] 管家已响应议题 ${f.replace(/\.reply\.md$/, '')}`,
      `${decisionLine.slice(0, 120)}${isPlanMode ? '（已转计划文档，待启动派发）' : ''}`, '讨论'));
    // 归档 reply（闭环收尾）
    try {
      ensure(path.join(DISC_DIR, 'archive'));
      fs.renameSync(path.join(DISC_DIR, f), path.join(DISC_DIR, 'archive', f));
    } catch (e) {}
  }
  return changed;
}

/* ── 决策委托通道（2026-08-08 决策委托分身） ────────────── */
/* 否定语境词：红线词若被这些词修饰（紧跟其前），视为否定语境，不触发红线 */
const NEGATION = /(?:^|[\s，。；：、（"'「「])?(无|不|免|零|没|未|无需|不需要|不用|非)(?:付费|花钱|扣费|收费|购买|付款|充值|充钱|删除|破坏|清空|转账|打款)?/i;
/**
 * 判定是否触发红线（分身绝不代决策 → 升级用户）。
 * 修复：排除否定语境——如「无付费」「免费」「不需要花钱」等虽含红线词但语义非花钱。
 */
function classifyRedLine(text) {
  if (!text) return false;
  for (const re of REDLINE_PATTERNS) {
    // matchAll 需要全局正则；对定义（可能无 g）做克隆加 g
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const gre = new RegExp(re.source, flags);
    let hit = false;
    for (const m of text.matchAll(gre)) {
      if (m[0] === undefined) break;
      // 检查匹配串紧邻前是否是否定词修饰（「无付费」「不花钱」「免费」等）
      const idx = m.index || 0;
      const before = text.slice(Math.max(0, idx - 3), idx);
      // 前文出现 无/不/免/零/没/未 + 本匹配串 = 否定语境，跳过
      if (/[无不免零没未]/.test(before)) continue;
      hit = true;
      break;
    }
    if (hit) return true;
  }
  return false;
}
/** 组装决策文件内容 */
function buildDecisionFile(base, srcTask, decision, reason, type) {
  return [
    `# 分身决策：${srcTask}`,
    `- 决策时间: ${tsStamp()}`,
    `- 源任务: ${srcTask}`,
    `- 决策: ${decision}`,
    `- 理由: ${reason}`,
    `- 类型: ${type}`,   // 决策点 | 红线-升级用户 | 决策超时待用户
    `- 决策文件: ${base}.decision.md`,
  ].join('\n');
}
/** 归档决策请求 */
function archiveDecision(f, reqPath) {
  try {
    ensure(path.join(DEC_DIR, 'archive'));
    fs.renameSync(reqPath, path.join(DEC_DIR, 'archive', f));
  } catch (e) { log('归档决策请求失败:', e.message); }
}
/**
 * 决策委托：扫 inbox/decisions/*.md（待决策请求）
 *   红线 → 升级用户；超时(30min) → 待用户；决策点 → 大脑(user-twin)决策写 .decision.md。
 * 返回新增 activity 行数组。
 */
async function scanDecisions() {
  const changed = [];
  if (!fs.existsSync(DEC_DIR)) return changed;
  const files = fs.readdirSync(DEC_DIR)
    .filter(f => f.endsWith('.md') && !f.includes('.decision.'));
  for (const f of files) {
    const reqPath = path.join(DEC_DIR, f);
    const base = f.replace(/\.md$/, '');
    const decPath = path.join(DEC_DIR, base + '.decision.md');
    if (fs.existsSync(decPath)) continue;                 // 已决策
    const req = readIf(reqPath) || '';
    const srcTask = (req.match(/- 源任务\s*:\s*(\S+)/) || [])[1] || base.replace(/^[\d-]+-/, '');
    const question = (req.match(/- 问题\s*:\s*(.+)/) || [])[1] || req.slice(0, 200);
    const st = statOf(reqPath);
    // 1) 超时兜底：分身 30 分钟无决策 → 记录待用户，不无限等
    if (st && Date.now() - st.mtimeMs > DEC_TIMEOUT_MS) {
      fs.writeFileSync(decPath, buildDecisionFile(base, srcTask, '决策超时待用户',
        '分身 30 分钟未决策，已记录待用户确认（不无限等待）。执行者可先按低风险默认推进或暂停。', '超时'), 'utf8');
      changed.push(logActivity(`[决策] ${srcTask} 决策超时待用户`, '分身 30 分钟未决策，不无限等待', '决策'));
      archiveDecision(f, reqPath);
      continue;
    }
    // 2) 红线：分身绝不代决策 → 升级用户
    if (classifyRedLine(question + ' ' + req)) {
      fs.writeFileSync(decPath, buildDecisionFile(base, srcTask, '升级用户',
        '触发红线（花钱/付费/永久删除/法律/超授权/隐私出圈/真实资金），分身不代决策，需用户本人确认。', '红线'), 'utf8');
      changed.push(logActivity(`[决策] ${srcTask} 触发红线 → 升级用户`, question.slice(0, 80), '决策'));
      archiveDecision(f, reqPath);
      continue;
    }
    // 3) 决策点：交给分身大脑（user-twin 人格）代做决策
    const decPrompt = `【分身决策指令】任务执行中遇到决策点，请以分身（用户 du_ji 的思维模拟器）身份代做决策，不要卡住执行者。\n\n决策请求（源任务 ${srcTask}）：\n${req.slice(0, 1500)}\n\n请用 du_ji 的决策启发式（划算不划算/值不值/风险多高/能复用就复用/免费不如低价）输出：\n第一行：决策结论（明确选哪个选项或给可执行指示，如"选A：注册测试账号"）\n后续行：一句理由（用分身口吻，简短直接）\n总长不超过 200 字。`;
    const r = await brainAsk(decPrompt, { noRecord: true });
    if (r.ok && r.reply) {
      const txt = String(r.reply).trim();
      const decision = txt.split(/\r?\n/)[0].slice(0, 160) || '已决定';
      const reason = txt.split(/\r?\n/).slice(1).join(' ').trim().slice(0, 300) || '(无理由)';
      fs.writeFileSync(decPath, buildDecisionFile(base, srcTask, decision, reason, '决策点'), 'utf8');
      changed.push(logActivity(`[决策] ${srcTask} 分身已决策`, decision.slice(0, 100), '决策'));
    } else {
      // 大脑决策失败：记失败，留请求待下轮（不删，避免丢请求）
      changed.push(logActivity(`[决策] ${srcTask} 大脑决策失败`, String(r.error || '?').slice(0, 80), '决策'));
      continue;
    }
    archiveDecision(f, reqPath);
  }
  return changed;
}

/** 任务异常兜底扫描（2026-08-08 分身巡查增强）
 *  但管家也死时，分身兜底检测异常中断/卡死任务：读 active-tasks.json，
 *  pid 不存在（ESRCH）或日志停滞 → 标记 .DONE=.FAILED + activity [告警] 记录。
 *  仅当但管家离线时启用（但管家活着由其 15s 巡查即时处理，避免双写冲突）。 */
async function scanTaskAnomalies() {
  const changed = [];
  const butlerPid = parseInt((readIf(BUTLER_PID) || '').trim(), 10);
  if (butlerPid && alive(butlerPid)) return changed;   // 但管家在线，兜底不介入
  if (!fs.existsSync(ACTIVE_TABLE)) return changed;
  let table;
  try { table = JSON.parse(readIf(ACTIVE_TABLE)); } catch (e) { return changed; }
  const now = Date.now();
  for (const [name, info] of Object.entries(table || {})) {
    const done = readIf(path.join(INBOX, name + '.DONE')) || readIf(path.join(INBOX, name + '.FAILED'));
    if (done) continue;                                  // 已有完成/失败标记
    const pid = info.pid;
    let reason = null;
    if (!pid || Number.isNaN(pid) || !alive(pid)) {
      reason = '进程异常中断（pid 已死，分身兜底检测）';
    } else {
      // 日志停滞检测：尝试定位任务日志（pi 任务 logs/<name>.log，HK 桥 .hk.log）
      const candidates = [path.join(LOGS, name + '.log'), path.join(LOGS, name + '.hk.log')];
      const lp = candidates.find(p => statOf(p));
      if (lp) {
        const idle = now - statOf(lp).mtimeMs;
        const running = now - new Date(info.startedAt || now).getTime();
        if (running > 2 * 60 * 1000 && idle > 20 * 60 * 1000) {
          reason = '疑似卡死（日志 ' + Math.round(idle / 60000) + ' 分钟未更新，分身兜底检测）';
        }
      }
    }
    if (reason) {
      try { fs.writeFileSync(path.join(INBOX, name + '.DONE'), `.FAILED: ${reason}`, 'utf8'); } catch (e) {}
      // 写恢复决策请求（但管家重启后经 scanDecisionResults 执行重跑/归档）
      try {
        ensure(DEC_DIR);
        const ts = new Date().toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, '');
        const reqPath = path.join(DEC_DIR, `${ts}-${name}.md`);
        if (!fs.existsSync(reqPath)) {
          fs.writeFileSync(reqPath, [
            `# 决策请求：任务 ${name} 异常中断，如何恢复？（分身兜底）`,
            `- 源任务: ${name}`,
            `- 类型: 恢复`,
            `- 问题: 任务 ${name} 异常中断（${reason}），但管家当时离线由分身兜底标记，请决定是否重跑/归档。`,
            `- 选项: A. 重跑 B. 归档（不再重派）`,
            `- 重跑计数: 0`
          ].join('\n') + '\n', 'utf8');
        }
      } catch (e) {}
      changed.push(logActivity(`[告警] 任务 ${name} 异常中断，分身兜底标记失败`, reason.slice(0, 80), '任务'));
    }
  }
  return changed;
}

/** 2) 智能体/进程状态：butler/web 上线离线检测 + org.json 状态变化 */
function scanProcesses() {
  const changed = [];
  const checks = [
    { key: 'butler', pidFile: BUTLER_PID, name: '管家(butler)' },
    { key: 'web',    pidFile: WEB_PID,    name: 'web 控制台' },
    { key: 'twin',   pidFile: PID_FILE,   name: '分身(本进程)' }
  ];
  const prev = scanState.procs || {};
  for (const c of checks) {
    const pid = parseInt((readIf(c.pidFile) || '').trim(), 10);
    const alivePid = pid && alive(pid);
    const cur = pid && alivePid ? { on: true, pid } : { on: false, pid: null };
    const was = prev[c.key] || { on: false, pid: null };
    if (cur.on !== was.on) {
      const line = logActivity(cur.on ? `${c.name} 上线` : `${c.name} 离线`,
        cur.on ? `PID=${cur.pid}` : (was.pid ? `原 PID=${was.pid}` : ''), '系统');
      changed.push(line);
    }
    prev[c.key] = cur;
  }
  scanState.procs = prev;
  return changed;
}

function alive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/* ── 渠道健康恢复探测（2026-08-08 挂入，channel-manager 专职） ── */
// 冷却/失败渠道每 30 分钟轻量探测一次；成功→markRecovered（路由切回高优先级），失败→延长冷却。
// probeCoolingChannels 内部按 probedAt 节流，这里每 5 分钟巡检一次但探测间隔 30 分钟，不烧额度。
async function scanChannels() {
  const changed = [];
  try {
    const cf = require('./channel-fallback');
    const results = await cf.probeCoolingChannels();
    for (const r of results) {
      const line = logActivity(r.recovered
        ? `渠道 ${r.provider} 恢复可用，已切回高优先级`
        : `渠道 ${r.provider} 恢复探测未通过（code=${r.code || r.error}），继续冷却`,
        r.recovered ? `探测 /models → ${r.code} OK` : '下轮 30 分钟后再探', '渠道');
      changed.push(line);
    }
  } catch (e) { log('渠道恢复探测异常:', e.message); }
  return changed;
}

/** 3) 安全扫描：监听端口 + 启动项（与基线对比，新增=异常） */
function scanSecurity() {
  const changed = [];
  // 3a. 监听端口（netstat -ano -p tcp | findstr LISTENING）
  const knownPorts = new Set([8787, TCPU_PORT, 22, 80, 443, 135, 445, 3389, 5040, 49664,
                              49665, 49666, 49667, 49668, 49669, 49670, 49671, 49672, 49673, 49674, 49675]);
  const out = execOut('netstat.exe', ['-ano', '-p', 'tcp']);
  const ports = new Map();   // port -> pids
  for (const m of out.matchAll(/TCP\s+(?:\d+\.\d+\.\d+\.\d+|\*|\[::\]|0\.0\.0\.0):(\d+)\s+\S+\s+LISTENING\s+(\d+)/g)) {
    const port = parseInt(m[1], 10);
    if (!ports.has(port)) ports.set(port, new Set());
    ports.get(port).add(parseInt(m[2], 10));
  }
  const curPorts = {};
  for (const [p, pids] of ports) curPorts[p] = [...pids];
  const prevPorts = scanState.ports || {};
  const firstRun = Object.keys(prevPorts).length === 0;
  const newPorts = Object.keys(curPorts).filter(p => {
    if (knownPorts.has(parseInt(p, 10))) return false;
    if (prevPorts[p]) return false;
    return true;
  });
  if (newPorts.length && !firstRun) {
    const desc = newPorts.map(p => `:${p}(PID ${(curPorts[p] || []).join(',')})`).join(' ');
    const line = logActivity(`⚠ 安全：出现新监听端口 ${desc}`, '不在已知白名单，建议核查', '安全');
    changed.push(line);
  }
  scanState.ports = curPorts;

  // 3b. 启动项（HKCU/HKLM Run）
  const startup = {};
  for (const [hive, key] of [['hkcu', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'],
                             ['hklm', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']]) {
    const ro = execOut('reg.exe', ['query', key]);
    for (const m of ro.matchAll(/^\s*([^\s]+)\s+REG_\w+\s+(.+)$/gm)) {
      startup[hive + '/' + m[1]] = m[2].trim();
    }
  }
  const prevStartup = scanState.startup || {};
  const firstStartup = Object.keys(prevStartup).length === 0;
  const newStartup = Object.keys(startup).filter(k => !prevStartup[k]);
  if (newStartup.length && !firstStartup) {
    const line = logActivity(`⚠ 安全：发现新启动项 ${newStartup.join('、')}`,
      '新增自启动程序，请核查是否正常', '安全');
    changed.push(line);
  }
  scanState.startup = startup;
  return changed;
}

/* ── 管家保活（2026-08-10 twin-daemon-keepalive） ─────────────
 * 背景：管家(butler)反复死（8/10 当天 4 次），每次都由主会话手动拉起（越权）。
 *      保活/重启属管理组职责，但管家死时其内部任务无法执行（死循环），必须由
 *      不依赖管家的独立常驻进程 twin-daemon 接管。
 * 检测（每巡查轮 5 分钟）：
 *   ① 进程探活：butler.pid + alive()
 *   ② 日志停滞：butler.log 最后写入 >10 分钟（管家每 15s~60s 写一次，停滞即疑似卡死）
 * 拉起：node scripts/bootstrap.js start（幂等——单实例锁 + Start-Process detached）
 * 防反复：5 分钟内重启 >3 次 → 停止拉起，写 activity + plan 升级人工（不打扰用户）
 * 死因快照：拉起前把 butler.log 尾部 20 行存 logs/crash-<ts>.log */
async function scanButlerKeepalive() {
  const changed = [];
  const ks = scanState.butlerKeepalive || { restarts: [], lastEscalatedAt: 0, lastDieAt: 0 };
  const now = Date.now();
  // 只统计窗口内的重启记录
  ks.restarts = (ks.restarts || []).filter(t => now - t < BUTLER_RESTART_WINDOW_MS);

  const pidStr = (readIf(BUTLER_PID) || '').trim();
  const pid = parseInt(pidStr, 10);
  const pidAlive = pid && !Number.isNaN(pid) && alive(pid);
  const bstat = statOf(BUTLER_LOG);
  const idleMin = bstat ? Math.round((now - bstat.mtimeMs) / 60000) : 0;

  // 判定死因：进程死亡 / 日志停滞（进程活着但疑似卡死）
  let reason = null;
  if (!pidAlive) {
    reason = pid ? `进程死亡（原 PID=${pid}）` : 'PID 文件缺失或为空';
  } else if (bstat && (now - bstat.mtimeMs) > BUTLER_LOG_STALE_MS) {
    reason = `疑似卡死（butler.log ${idleMin} 分钟未更新）`;
  }

  if (reason) {
    // 防反复：窗口内已重启达上限 → 停止拉起，升级人工（节流 30 分钟一次，不刷屏）
    if (ks.restarts.length >= BUTLER_RESTART_MAX) {
      if (now - (ks.lastEscalatedAt || 0) > 30 * 60 * 1000) {
        changed.push(logActivity(`⚠ [保活] butler 异常反复重启已停止（${ks.restarts.length} 次/5分钟），需人工介入`,
          `${reason}，已写升级 plan（twin-daemon 不无限拉起）`, '保活'));
        ks.lastEscalatedAt = now;
        try { writeKeepalivePlan(reason); } catch (e) {}
      }
    } else {
      // 死因快照：拉起前保存 butler.log 尾部（供排查，如 review-loop 集成后崩溃）
      const ts = tsStamp();
      const crashPath = path.join(LOGS, `crash-${ts}.log`);
      try {
        const tail = (readIf(BUTLER_LOG) || '').split(/\r?\n/).slice(-20).join('\n');
        fs.writeFileSync(crashPath,
          `# butler crash snapshot @ ${new Date().toISOString()}\n# 触发原因: ${reason}\n# 尾部 20 行:\n${tail}\n`, 'utf8');
      } catch (e) {}
      // 拉起（bootstrap.js start 幂等）
      const oldPid = pid || 0;
      try {
        await restartButler();
      } catch (e) {
        log('管家拉起失败:', e.message);
        changed.push(logActivity(`⚠ [保活] butler 自动重启失败`, String(e.message).slice(0, 80), '保活'));
        return changed;
      }
      ks.restarts.push(now);
      ks.lastDieAt = now;
      const newPid = parseInt((readIf(BUTLER_PID) || '').trim(), 10) || '?';
      changed.push(logActivity(`[保活] butler 死亡自动重启（PID ${oldPid}→${newPid}）`,
        `死因: ${reason}，快照 logs/crash-${ts}.log`, '保活'));
    }
  }
  scanState.butlerKeepalive = ks;
  return changed;
}

/** 通过 bootstrap.js start 拉起管家（幂等：管家单实例锁 + Start-Process detached）。 */
function restartButler() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BOOTSTRAP_JS, 'start'], {
      cwd: ORG_ROOT, stdio: 'ignore', windowsHide: true
    });
    const t = setTimeout(() => { try { child.kill(); } catch (e) {} reject(new Error('bootstrap start 超时')); }, 60 * 1000);
    child.on('exit', code => { clearTimeout(t); resolve(); });
    child.on('error', e => { clearTimeout(t); reject(e); });
  });
}

/** 升级：把异常写 plan 文件（供管理组/用户查看，但只记录不打扰）。 */
function writeKeepalivePlan(reason) {
  const p = path.join(ORG_ROOT, 'artifacts', `butler-keepalive-escalate-${tsStamp()}.md`);
  ensure(path.dirname(p));
  fs.writeFileSync(p, [
    `# 管家(butler) 反复死亡需人工介入（twin-daemon 保活自动停止）`,
    `- 时间: ${new Date().toISOString()}`,
    `- 原因: ${reason}`,
    `- 说明: 5 分钟内自动重启超过 ${BUTLER_RESTART_MAX} 次，已停止拉起防循环。`,
    `- 处理建议: 查看 logs/crash-*.log 死因快照；修复 butler.js 后手动 ` + '`node scripts/bootstrap.js start`' + ` 拉起。`
  ].join('\n') + '\n', 'utf8');
}

/** 一轮巡查：返回 activity 新增行数 */
async function runPatrol() {
  const notes = [];
  try { notes.push(...scanInbox()); } catch (e) { log('巡查 inbox 失败:', e.message); }
  try { notes.push(...deepAcceptExisting()); } catch (e) { log('巡查存量验收失败:', e.message); }
  try { notes.push(...scanProcesses()); } catch (e) { log('巡查进程失败:', e.message); }
  try { notes.push(...scanSecurity()); } catch (e) { log('巡查安全失败:', e.message); }
  try { notes.push(...scanDiscussionReplies()); } catch (e) { log('巡查讨论响应失败:', e.message); }
  try { notes.push(...await scanDecisions()); } catch (e) { log('巡查决策委托失败:', e.message); }
  try { notes.push(...await scanTaskAnomalies()); } catch (e) { log('巡查任务异常失败:', e.message); }
  try { notes.push(...await scanChannels()); } catch (e) { log('巡查渠道健康失败:', e.message); }
  /* 管家保活（2026-08-10）：管家死亡/卡死自动拉起——管理组保活职责，不依赖管家自身 */
  try { notes.push(...await scanButlerKeepalive()); } catch (e) { log('巡查管家保活失败:', e.message); }
  /* 分身职责巡检（2026-08-09 twin-duty-inspector）：主动发现该干活没干的智能体并派活。
   * 与 butler auto-schedule 幂等：定时职责兜底仅 when butler 离线；业务信号/闲置派活为分身独占 + 节流防骚扰。 */
  try {
    const { scanDuties } = require('./twin-duty-inspector');
    notes.push(...await scanDuties());
  } catch (e) { log('巡查职责巡检失败:', e.message); }
  saveScanState();
  const line = logActivity('巡查完成', `本轮 ${notes.length} 条变化（inbox/进程/安全/渠道）`, '巡查');
  return line;
}

/* ── 通道：TCP + stdin/stdout ─────────────────────────── */
function handleLine(line, send) {
  let o = null;
  try { o = JSON.parse(line); } catch (e) {
    return send(JSON.stringify({ ok: false, error: '不是 JSON' }));
  }
  if (o.type === 'ping') {
    return send(JSON.stringify({ type: 'pong', ok: true, ts: tsISO() }));
  }
  if (o.type === 'status') {
    return send(JSON.stringify({
      type: 'status', ok: true, running: true, pid: process.pid,
      brainPid: brain && brain.child ? brain.child.pid : null,
      since: new Date(process.uptime() * 1000 < 0 ? Date.now() : Date.now() - process.uptime() * 1000).toISOString(),
      activity: readActivity(5).lines
    }));
  }
  if (o.type === 'chat') {
    const message = typeof o.message === 'string' ? o.message.trim() : '';
    if (!message) return send(JSON.stringify({ type: 'reply', id: o.id, ok: false, error: '缺少 message' }));
    try {
      fs.mkdirSync(path.join(TWIN_DIR, 'chat'), { recursive: true });
      fs.appendFileSync(path.join(TWIN_DIR, 'chat', 'history.jsonl'),
        JSON.stringify({ ts: new Date().toISOString(), role: 'user', content: message }) + '\n', 'utf8');
    } catch (e) {}
    logActivity('收到对话', message.slice(0, 60), '对话');
    brainAsk(message).then(r => {
      send(JSON.stringify({ type: 'reply', id: o.id, ...r }));
    });
    return;
  }
  if (o.type === 'chat-ext') {
    // 主会话对话（butler-bridge 已写 history.jsonl + activity [对话]），这里只触发大脑决策
    // 节流：60s 内只处理一次（防失控客户端/回声风暴的最后一层防线）
    const nowMs = Date.now();
    if (nowMs - lastChatExtAt < 60 * 1000) {
      return send(JSON.stringify({ type: 'reply', id: o.id, ok: true, skipped: 'throttle' }));
    }
    lastChatExtAt = nowMs;
    const raw = typeof o.message === 'string' ? o.message.trim() : '';
    if (!raw) return send(JSON.stringify({ type: 'reply', id: o.id, ok: false, error: '缺少 message' }));
    const who = o.role === 'assistant' ? '分身助手回复' : '用户对话';
    const decPrompt = `【分身决策指令】主会话收到一条新${who}（butler-bridge 转发）：\n${raw.slice(0, 600)}\n\n请以分身身份做简短决策：这条对话是否涉及需要指挥管家（butler）或智能体执行的任务/事项？\n- 涉及 → 第一行输出「已安排：<一句话要办的事>」\n- 不涉及 → 第一行输出「无需行动」\n第一行之后可加一句分身视角点评，总长不超过 100 字。`;
    brainAsk(decPrompt, { noRecord: true }).then(r => {
      if (r.ok && r.reply) {
        const lines = String(r.reply).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const first = (lines[0] || '').slice(0, 100);
        const detail = (lines[1] || '').slice(0, 100);
        logActivity(`大脑决策（${who}）：${first}`, detail, '决策');
      } else {
        logActivity('大脑决策失败', String(r.error || '?').slice(0, 80), '决策');
      }
      send(JSON.stringify({ type: 'reply', id: o.id, ...r }));
    });
    return;
  }
  send(JSON.stringify({ ok: false, error: '未知类型 ' + o.type }));
}

function startTcp() {
  const server = net.createServer(sock => {
    let buf = '';
    sock.on('data', d => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try { handleLine(line, s => { try { sock.write(s + '\n'); } catch (e) {} }); } catch (e) {}
      }
    });
    sock.on('error', () => {});
  });
  server.listen(TCPU_PORT, '127.0.0.1', () => {
    log(`🔌 分身通道已开: tcp://127.0.0.1:${TCPU_PORT}（+ stdin/stdout）`);
  });
  server.on('error', e => { log('TCP 监听失败:', e.message); });
}

function startStdin() {
  if (process.stdin.isTTY) {
    log('进入控制台对话模式（输入消息回车发送，Ctrl+C 退出，/status 看状态）');
  }
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      if (line.trim() === '/status') {
        console.log(JSON.stringify({ type: 'status', ok: true, pid: process.pid,
          brainPid: brain && brain.child ? brain.child.pid : null,
          activity: readActivity(5).lines }, null, 2));
        continue;
      }
      handleLine(line, s => console.log(s));
    }
  });
}

/* ── 主程序 ────────────────────────────────────────────── */
async function main() {
  const argv = process.argv.slice(2);
  ensure(LOGS);

  if (argv.includes('--once')) {
    // 单轮巡查自检（不占锁，直接跑）
    const line = await runPatrol();
    console.log('巡查完成:', line);
    process.exit(0);
  }

  if (!acquireLock()) {
    console.error(`分身常驻进程已在运行（${readIf(PID_FILE)}），退出`);
    process.exit(1);
  }

  log(`=== 分身常驻启动 (PID=${process.pid}, 巡查间隔 ${POLL_MS / 60000} 分钟) ===`);
  logActivity('分身常驻上线', `PID=${process.pid}，web 控制台可对话，巡查每 ${POLL_MS / 60000} 分钟一次`, '上线');

  ensureBrain();
  startTcp();
  if (argv.includes('--console')) startStdin();

  // 首轮巡查延迟 10s（等系统稳定），之后每 POLL_MS
  setTimeout(() => { runPatrol().catch(e => log('巡查失败:', e.message)); }, 10000);
  const timer = setInterval(() => { runPatrol().catch(e => log('巡查失败:', e.message)); }, POLL_MS);
  const sweep = setInterval(brainSweep, 60 * 1000);
  sweep.unref();
  // PID 心跳：每 60s 重写 twin.pid，确保重启/进程重派后 PID 文件与当前进程始终同步
  // （web 控制台以此为在线判定依据，防止 PID 文件与实际进程脱节导致误判离线）
  const pidHeartbeat = setInterval(() => {
    try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch (e) {}
  }, 60 * 1000);
  pidHeartbeat.unref();

  process.on('SIGINT', () => {
    clearInterval(timer);
    killBrain(brain);
    logActivity('分身常驻下线', '收到停止信号', '上线');
    log('分身常驻停止');
    releaseLock();
    process.exit(0);
  });
  process.on('exit', () => {
    killBrain(brain);
    releaseLock();
  });
  setInterval(() => {}, 60000);   // 保持存活
}

if (require.main === module) main();
module.exports = { brainAsk, runPatrol, readActivity: readActivity, spawnBrain, ensureBrain };