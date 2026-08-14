#!/usr/bin/env node
/**
 * web/server.js — v5 组织总览前端的零依赖只读后端
 *
 * 数据全部来自本地文件：org.json / agents/* / inbox/ / logs/
 * 只读业务文件，不做任何写入（唯一例外：--token 模式给浏览器下一个 cookie）。
 *
 * 用法：
 *   node server.js                                  # 127.0.0.1:8787，仅本机
 *   node server.js --port 9000
 *   node server.js --host 0.0.0.0                   # 局域网/手机可访问（无鉴权，仅限可信网络）
 *   node server.js --host 0.0.0.0 --token abc123    # 简单 token 鉴权
 *
 * API：
 *   GET /api/state                    组织树 + 任务 + 各智能体活动 + 管家小结（本地计算版）
 *   GET /api/remote/state?force=1     经 Tailscale 转发服务器集群（HK）org web 的 /api/state（15s 缓存，token 读 web/remote-config.json，不入代码）
 *   GET /api/agent?id=&task=&events=  单智能体详情 + 最新输出（解析 pi/claude stream-json 日志）
 *   GET /api/summary?real=1           真实跑 `node butler.js --summary` 的输出（30s 缓存）
 *   GET /api/butlerlog?lines=200      butler.log 尾部
 *   GET /api/file?p=<org 内相对路径>   读取单个文本文件
 *   GET /api/chat/agents              可对话智能体列表（agents/<id>/AGENTS.md 存在即可对话）
 *   GET /api/chat/<id>/history        对话历史（agents/<id>/chat/history.jsonl）
 *   GET /api/memory/<agentId>          智能体记忆（diary 时间线 + 检索 + 实体图谱，lib/memory.js）
 *   POST /api/chat/<id> {message}     发送消息并同步等待回复（常驻 pi rpc 子进程，懒启动，30 分钟空闲自动关）
 *   POST /api/shutdown/arm            睡前模式：启动完成即关机守护（detached，可 body 传测试参数）
 *   POST /api/shutdown/disarm         解除睡前模式（杀掉守护进程）
 *   GET /api/shutdown/status          守护状态 + 剩余未完成任务清单
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WEB_DIR    = __dirname;
const ORG_ROOT   = path.resolve(WEB_DIR, '..');
const ORG_JSON   = path.join(ORG_ROOT, 'org.json');
const LOGS       = path.join(ORG_ROOT, 'logs');
const INBOX      = path.join(ORG_ROOT, 'inbox');
const BUTLER_LOG = path.join(LOGS, 'butler.log');
const BUTLER_PID = path.join(ORG_ROOT, 'butler.pid');
const SEEN_FILE  = path.join(LOGS, 'tasks-seen.json');   // 任务快照（用于检测被删除的任务）
const ACTIVE_TABLE = path.join(LOGS, 'active-tasks.json');  // butler 共享表：运行中任务 + 插嘴能力（interject）
const INTERJECT_DIR = path.join(INBOX, 'interject');        // 插嘴请求队列：写 <task>.json → butler 送入 agent
/* 共享表读取：butler 把 active 子进程表落盘，这里查（跨进程无法直接拿 stdin 句柄） */
function readActiveTable() {
  try { return JSON.parse(fs.readFileSync(ACTIVE_TABLE, 'utf8')) || {}; } catch (e) { return {}; }
}
const GUARD_SCRIPT = path.join(ORG_ROOT, 'shutdown-after-done.js');
const GUARD_PID    = path.join(ORG_ROOT, 'shutdown-guard.pid');
const SLEEP_FLAG   = path.join(ORG_ROOT, 'sleep-mode.flag');   // 睡前/关机模式统一标记（讨论照常、派发转计划文档）
const TWIN_PID    = path.join(ORG_ROOT, 'twin.pid');
const TWIN_ACTIVITY = path.join(ORG_ROOT, 'agents', 'twin', 'activity.log');
const TWIN_DAO_PORT = parseInt(process.env.TWIN_DAEMON_PORT || '18788', 10);
const { readActivity } = require(path.join(ORG_ROOT, 'lib', 'twin-log.js'));
const orgMemory = require(path.join(ORG_ROOT, 'lib', 'memory.js'));
let defaultTwinRoute = null;   // 分身大脑路由（provider/model/thinking），懒加载容错
function getTwinRoute() {
  if (defaultTwinRoute) return defaultTwinRoute;
  try { defaultTwinRoute = require(path.join(ORG_ROOT, 'lib', 'model-router.js')).defaultRoute() || {}; }
  catch (e) { defaultTwinRoute = {}; }
  return defaultTwinRoute;
}

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v && !String(v).startsWith('--')) ? v : true;
}
const PORT  = parseInt(arg('port', process.env.PI_WEB_PORT || '8787'), 10);
const HOST  = String(arg('host', process.env.PI_WEB_HOST || '127.0.0.1'));
const TOKEN = String(arg('token', process.env.PI_WEB_TOKEN || '') || '');

const TAIL_BYTES = 512 * 1024;   // /api/file 最多读尾部 512KB
/* 远端（服务器集群）org web 代理：Tailscale 转发 + token，见 fetchRemoteState() */
const REMOTE_CFG_FILE = path.join(WEB_DIR, 'remote-config.json');
const REMOTE_CACHE_MS = 15000;      // 缓存窗口：本地前端 5s 轮询不每次都打 HK
const REMOTE_TIMEOUT  = 8000;       // Tailscale DERP 兜底延迟高，超时保护
/* 任务日志窗口取 2MB：pi stream-json 每行携带累积全文（单行可达上百 KB），
 * 256KB 窗口往往只容得下 1-2 行；2MB 对上百 MB 文件仍只是 1% 量级，不算全量读。 */
const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 120;          // 单次最多返回事件数
const MAX_TEXT   = 4000;         // 单条文本上限
/* ── 小工具 ─────────────────────────────────────────────── */
const readIf = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const statOf = p => { try { return fs.statSync(p); } catch (e) { return null; } };
const listOf = p => { try { return fs.readdirSync(p); } catch (e) { return []; } };
const rel    = p => path.relative(ORG_ROOT, p).replace(/\\/g, '/');
const iso    = ms => (ms ? new Date(ms).toISOString() : null);

/* 误杀归档标记检测（2026-08-09 misjudged-cleanup）：<name>.DONE.misjudged-* 存在
 * → 该任务已归档（空转误杀，不参与失败/待处理统计）。 */
function misjudgedArchived(name) {
  try {
    return listOf(INBOX).some(f => f.startsWith(name + '.DONE.misjudged'));
  } catch (e) { return false; }
}

function clip(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + `\n…（截断，原文 ${s.length} 字符）` : s;
}

/** 进程是否存活（Windows 下 EPERM 说明进程在、只是没权限） */
function alive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function loadOrg() {
  const raw = readIf(ORG_JSON);
  if (raw == null) return { error: '读不到 org.json', root: null, nodes: {} };
  try {
    const d = JSON.parse(raw);
    d.nodes = d.nodes || {};
    return d;
  } catch (e) {
    return { error: 'org.json 解析失败: ' + e.message, root: null, nodes: {} };
  }
}

/** 读文件尾部 maxBytes 字节（大日志不整体载入内存） */
function tailBytes(file, maxBytes) {
  const st = statOf(file);
  if (!st || !st.isFile()) return { text: '', size: 0, mtime: 0, truncated: false };
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = fs.readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return { text: buf.slice(0, read).toString('utf8'), size: st.size, mtime: st.mtimeMs, truncated: start > 0 };
  } catch (e) {
    return { text: '', size: st.size, mtime: st.mtimeMs, truncated: false, error: e.message };
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (e) {}
  }
}
/* ── stream-json 日志解析 ───────────────────────────────── */
/** 工具调用的一行摘要 */
function toolBrief(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (input.command)   return clip(String(input.command), 600);
  if (input.file_path) return String(input.file_path);
  if (input.path)      return String(input.path);
  if (input.notebook_path) return String(input.notebook_path);
  if (input.query)     return clip(String(input.query), 300);
  if (input.pattern)   return clip(String(input.pattern), 300);
  if (input.url)       return String(input.url);
  if (input.prompt)    return clip(String(input.prompt), 300);
  if (input.description) return clip(String(input.description), 300);
  try { return clip(JSON.stringify(input), 500); } catch (e) { return ''; }
}

// 纯遥测类 system 事件：数量极大（实测占日志 90%+），全丢会话就剩噪音，不展示
const SKIP_SYSTEM = new Set(['thinking_tokens']);

/** pi 时间戳可能在顶层也可能在 message 里 */
const tsOf = obj => obj.timestamp || (obj.message && obj.message.timestamp) || null;

/** pi tool_execution_end 的 result → 纯文本 */
function piResultText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result.content)) {
    return result.content.map(c => (c && c.type === 'text') ? c.text : (c && c.type === 'image') ? '[图片]' : '')
                         .filter(Boolean).join('\n');
  }
  return '';
}

/** 单条 stream-json 记录 → 0..N 条 UI 事件（就地 push） */
function normalizeEvent(obj, out, meta, fullText) {
  const ts = obj.timestamp || null;
  const BIG = fullText ? Number.MAX_SAFE_INTEGER : 1200;
  const BIG2 = fullText ? Number.MAX_SAFE_INTEGER : MAX_TEXT;

  if (obj.type === 'system') {
    if (SKIP_SYSTEM.has(obj.subtype)) { meta.skipped = (meta.skipped || 0) + 1; return; }
    if (obj.subtype === 'init') {
      meta.sessionId = obj.session_id || meta.sessionId;
      meta.model = obj.model || meta.model;
      meta.cwd = obj.cwd || meta.cwd;
      meta.permissionMode = obj.permissionMode || meta.permissionMode;
      out.push({ kind: 'system', ts, text: `会话开始 · model=${obj.model || '?'} · cwd=${obj.cwd || '?'}` });
    } else if (obj.subtype === 'api_retry') {
      out.push({ kind: 'system', ts, error: true,
                 text: `API 重试${obj.attempt ? ` 第 ${obj.attempt} 次` : ''}` +
                       (obj.delayMs ? `（等待 ${Math.round(obj.delayMs / 1000)}s）` : '') +
                       (obj.error ? ` — ${clip(String(obj.error), 300)}` : '') });
    } else if (obj.subtype === 'task_started') {
      out.push({ kind: 'system', ts, text: `子任务启动: ${obj.description || obj.agentType || obj.taskId || '?'}` });
    } else if (obj.subtype === 'task_notification') {
      out.push({ kind: 'system', ts, text: `子任务回报: ${clip(String(obj.message || obj.description || '?'), 600)}` });
    } else if (obj.subtype) {
      out.push({ kind: 'system', ts, text: `system/${obj.subtype}` });
    }
    return;
  }

  /* ── pi stream-json（--mode rpc 的 delta 流）──
   * 只取 *_end 事件（自带完整内容），跳过所有 *_delta / *_start：
   * delta 行数量巨大且每行携带累积全文，只读 end 事件既全又不重。 */
  if (obj.type === 'message_update' && obj.assistantMessageEvent) {
    const ev = obj.assistantMessageEvent;
    const ts = tsOf(obj);
    if (ev.type === 'thinking_end' && ev.content && String(ev.content).trim()) {
      out.push({ kind: 'thinking', ts, text: clip(ev.content, BIG) });
    } else if (ev.type === 'text_end' && ev.content && String(ev.content).trim()) {
      out.push({ kind: 'text', ts, text: clip(ev.content, BIG2) });
    } else if (ev.type === 'toolcall_end' && ev.toolCall) {
      out.push({ kind: 'tool', ts, tool: ev.toolCall.name || 'tool', id: ev.toolCall.id || null,
                 text: toolBrief(ev.toolCall.name, ev.toolCall.arguments) });
    } else if (ev.type === 'error') {
      out.push({ kind: 'system', ts, error: true,
                 text: '生成错误: ' + clip(String(ev.reason || ev.error || '?'), 300) });
    }
    return;
  }
  if (obj.type === 'tool_execution_end') {
    out.push({ kind: 'result', ts: tsOf(obj), id: obj.toolCallId || null, tool: obj.toolName || null,
               error: !!obj.isError, text: clip(piResultText(obj.result).trim() || '(空)', MAX_TEXT) });
    return;
  }
  if (obj.type === 'auto_retry_start') {
    out.push({ kind: 'system', ts: tsOf(obj), error: true,
               text: `API 自动重试 第 ${obj.attempt || '?'} 次` +
                     (obj.delayMs ? `（等待 ${Math.round(obj.delayMs / 1000)}s）` : '') +
                     (obj.errorMessage ? ` — ${clip(String(obj.errorMessage), 300)}` : '') });
    return;
  }
  if (obj.type === 'auto_retry_end' && obj.success === false) {
    out.push({ kind: 'system', ts: tsOf(obj), error: true,
               text: '自动重试最终失败: ' + clip(String(obj.finalError || '?'), 400) });
    return;
  }
  if (obj.type === 'agent_end') {
    if (obj.willRetry) {
      out.push({ kind: 'system', ts: tsOf(obj), text: 'agent_end · 准备自动重试' });
    }
    // willRetry=false 时不展示，等紧随其后的 agent_settled 统一收尾
    return;
  }
  if (obj.type === 'agent_settled') {
    out.push({ kind: 'final', ts: tsOf(obj), text: '本轮执行结束（agent_settled）' });
    return;
  }
  // message_start / message_end / turn_start / turn_end / tool_execution_start /
  // tool_execution_update / queue_update：内容已被 *_end 事件覆盖，跳过
  if (obj.type === 'message_start' || obj.type === 'message_end' ||
      obj.type === 'turn_start' || obj.type === 'turn_end' ||
      obj.type === 'tool_execution_start' || obj.type === 'tool_execution_update' ||
      obj.type === 'agent_start' || obj.type === 'queue_update' ||
      obj.type === 'compaction_start' || obj.type === 'compaction_end') {
    return;
  }

  /* ── claude stream-json（-p --output-format stream-json）── */
  if (obj.type === 'assistant' && obj.message) {
    for (const c of (obj.message.content || [])) {
      if (c.type === 'text' && c.text && c.text.trim()) {
        out.push({ kind: 'text', ts, text: clip(c.text, MAX_TEXT) });
      } else if (c.type === 'thinking' && c.thinking && c.thinking.trim()) {
        out.push({ kind: 'thinking', ts, text: clip(c.thinking, 1200) });
      } else if (c.type === 'tool_use') {
        out.push({ kind: 'tool', ts, tool: c.name || 'tool', id: c.id || null, text: toolBrief(c.name, c.input) });
      }
    }
    if (obj.message.usage) meta.usage = obj.message.usage;
    return;
  }
  if (obj.type === 'user' && obj.message) {
    for (const c of (obj.message.content || [])) {
      if (c.type === 'tool_result') {
        const body = typeof c.content === 'string' ? c.content
          : Array.isArray(c.content)
            ? c.content.map(x => (x && x.type === 'text') ? x.text : (x && x.type === 'image') ? '[图片]' : '')
                       .filter(Boolean).join('\n')
            : '';
        out.push({ kind: 'result', ts, id: c.tool_use_id || null, error: !!c.is_error,
                   text: clip(body.trim() || '(空)', MAX_TEXT) });
      } else if (c.type === 'text' && c.text && c.text.trim()) {
        out.push({ kind: 'user', ts, text: clip(c.text, MAX_TEXT) });
      }
    }
    return;
  }

  if (obj.type === 'result') {
    meta.result = {
      subtype: obj.subtype || null, isError: !!obj.is_error,
      durationMs: obj.duration_ms || null, numTurns: obj.num_turns || null,
      costUsd: obj.total_cost_usd || null
    };
    const secs = obj.duration_ms ? ` · ${Math.round(obj.duration_ms / 1000)}s` : '';
    const turns = obj.num_turns ? ` · ${obj.num_turns} 轮` : '';
    out.push({ kind: 'final', ts, error: !!obj.is_error,
               text: `任务结束 (${obj.subtype || 'done'})${turns}${secs}` +
                     (obj.result ? `\n${clip(String(obj.result), MAX_TEXT)}` : '') });
  }
}

/** 会话元信息（model/cwd/sessionId）只在日志头部出现一次，大日志时尾部窗口读不到，
 *  所以单独读文件头 64KB 取一次，按文件路径缓存（同一智能体的 model/cwd 不变）。 */
const headCache = new Map();
function headMeta(file, size) {
  const hit = headCache.get(file);
  // 日志是追加写的，头部不变；只有文件变小（被重建）才需要重读
  if (hit && size >= hit.size) return hit.meta;
  const readSize = size || 0;
  let meta = {};
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    let fbModel = null, fbSid = null, fbCwd = null;
    for (const line of buf.slice(0, n).toString('utf8').split(/\r?\n/)) {
      const s = line.trim();
      if (s[0] !== '{') continue;
      try {
        const o = JSON.parse(s);
        // Claude Code stream-json: {"type":"system","subtype":"init",...}
        if (o.type === 'system' && o.subtype === 'init') {
          meta = { sessionId: o.session_id || null, model: o.model || null,
                   cwd: o.cwd || null, permissionMode: o.permissionMode || null };
          break;
        }
        // pi 会话格式：头部 {"type":"session",...}，model 在 message 对象里
        if (o.type === 'session') { fbSid = fbSid || o.id || null; fbCwd = fbCwd || o.cwd || null; }
        if (!fbModel) fbModel = o.model || (o.message && o.message.model) || null;
      } catch (e) { /* 半行，忽略 */ }
    }
    if (!meta.model && fbModel) {
      meta = { sessionId: fbSid, model: fbModel, cwd: fbCwd, permissionMode: null };
    }
  } catch (e) { /* 读不到就算了 */ }
  finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) {} }
  // 没读到 init（日志刚建、还没落盘）就不缓存，下次再试
  if (Object.keys(meta).length) headCache.set(file, { meta, size: readSize });
  return meta;
}

/** 解析日志尾部 → 规范化事件；非 JSONL 的普通日志按纯文本返回 */
/** 解析日志 → 规范化事件；非 JSONL 的普通日志按纯文本返回。
 * 核心：倒序扫描（跳过 delta 洪流，只收集 *_end 有效事件），直到凑够 maxEvents 或到文件头。
 * 解决：日志尾部 2MB 全是 thinking_delta/toolcall_delta 导致有效事件只有几条的问题。 */
function parseLogTail(file, maxEvents, fullText) {
  const st = statOf(file);
  if (!st || !st.isFile()) return null;
  const limit = (maxEvents || MAX_EVENTS) > 0 ? (maxEvents || MAX_EVENTS) : MAX_EVENTS;
  const events = [];
  const meta = {};
  let jsonLines = 0, plain = [];
  const flush = () => {
    if (!plain.length) return;
    events.push({ kind: 'raw', ts: null, text: clip(plain.join('\n'), fullText ? Number.MAX_SAFE_INTEGER : MAX_TEXT) });
    plain = [];
  };

  // ── 倒序块读：从文件尾向前，跨块拼行 ──
  const CHUNK = 256 * 1024;
  let fd = null, tail = '';
  let size = st.size;
  try {
    fd = fs.openSync(file, 'r');
    while (size > 0 && events.length < limit) {
      const start = Math.max(0, size - CHUNK);
      const buf = Buffer.alloc(size - start);
      let read = 0;
      while (read < buf.length) {
        const n = fs.readSync(fd, buf, read, buf.length - read, start + read);
        if (n <= 0) break;
        read += n;
      }
      const chunk = buf.slice(0, read).toString('utf8') + tail;
      const lines = chunk.split('\n');
      tail = lines.shift();                 // 块首可能是不完整行，留给上一块
      // 本块内的行：倒序处理（最新在前）
      for (let i = lines.length - 1; i >= 0; i--) {
        const s = lines[i].trim();
        if (!s) continue;
        if (s[0] === '{') {
          let obj = null;
          try { obj = JSON.parse(s); } catch (e) { obj = null; }
          if (obj) {
            jsonLines++;
            // 只收集有效事件：delta/start 被 normalizeEvent 跳过
            const before = events.length;
            try { normalizeEvent(obj, events, meta, fullText); }
            catch (e) { /* 单条解析异常不影响整体 */ }
            if (events.length - before > 0 && events.length >= limit) break;
          }
          continue;
        }
        plain.push(s);
        if (plain.length > 300) plain.splice(0, plain.length - 300);
      }
      if (events.length >= limit) break;
      size = start;
    }
  } catch (e) { /* 读日志失败不阻塞 */ }
  finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) {} }

  // 普通文本日志：保持时间序（收集到的 plain 是倒序的）
  if (jsonLines === 0) { plain.reverse(); flush(); }
  else flush();

  const merged = jsonLines > 0 ? Object.assign({}, headMeta(file, st.size), meta) : meta;
  const total = events.length;
  return {
    file: rel(file), size: st.size, mtime: st.mtimeMs, truncated: size > 0 && events.length >= limit,
    format: jsonLines > 0 ? 'stream-json' : 'text',
    events, total, dropped: 0, meta: merged
  };
}

/* ── 任务归属：butler.log 派发记录 + inbox 头部声明 ────── */
/** taskName → agentId（来自 butler.log 的“🚀 派发 [x] → y”行） */
function dispatchMap() {
  const map = {};
  const t = tailBytes(BUTLER_LOG, 256 * 1024);
  const re = /派发\s*\[([^\]]+)\]\s*(?:→|->)\s*([^\s(]+)/g;
  let m;
  while ((m = re.exec(t.text))) map[m[1]] = m[2];
  return map;
}

/** 任务文件头部的 agent: / group: 声明（group 解析成组主智能体） */
function declaredAgent(org, mdPath) {
  const raw = readIf(mdPath);
  if (!raw) return null;
  for (const line of raw.split('\n').slice(0, 10)) {
    const a = line.match(/^agent\s*:\s*(\S+)/i);
    if (a) return a[1];
    const g = line.match(/^group\s*:\s*(\S+)/i);
    if (g) {
      const n = org.nodes[g[1]];
      return (n && n.mainAgent) || g[1];
    }
  }
  return null;
}
/* ── inbox 任务列表 ────────────────────────────────────── */
/** 状态：running（有 PID 且进程活着）/ done / failed / stale / pending */
function listTasks(org) {
  const names = new Set();
  for (const f of listOf(INBOX)) {
    const m = f.match(/^(.+)\.(md|DONE|PID)$/);
    if (m) names.add(m[1]);
  }
  // 误杀归档任务（<name>.DONE.misjudged-*）不参与统计
  for (const name of [...names]) if (misjudgedArchived(name)) names.delete(name);
  const dispatched = dispatchMap();
  const activeTable = readActiveTable();   // 插嘴能力标记（butler 共享表）
  const out = [];
  for (const name of names) {
    const mdPath = path.join(INBOX, name + '.md');
    const donePath = path.join(INBOX, name + '.DONE');
    const pidPath = path.join(INBOX, name + '.PID');
    const logPath = path.join(LOGS, name + '.log');
    const mdSt = statOf(mdPath), doneSt = statOf(donePath);
    const pidSt = statOf(pidPath), logSt = statOf(logPath);
    const doneTxt = doneSt ? (readIf(donePath) || '').trim() : null;
    const pid = pidSt ? parseInt((readIf(pidPath) || '').trim(), 10) : NaN;

    let status;
    if (doneTxt != null) status = /\.FAILED/i.test(doneTxt) ? 'failed' : 'done';
    else if (pidSt) status = alive(pid) ? 'running' : 'stale';
    else status = 'pending';

    const logMtime = logSt ? logSt.mtimeMs : 0;
    const touched = Math.max(logMtime, doneSt ? doneSt.mtimeMs : 0,
                             pidSt ? pidSt.mtimeMs : 0, mdSt ? mdSt.mtimeMs : 0);
    out.push({
      name,
      agentId: dispatched[name] || declaredAgent(org, mdPath) || null,
      status,
      pid: Number.isNaN(pid) ? null : pid,
      result: doneTxt != null ? clip(doneTxt, 400) : null,
      createdAt: iso(mdSt && mdSt.mtimeMs),
      startedAt: iso(pidSt ? pidSt.mtimeMs : 0) || iso(mdSt && mdSt.mtimeMs),
      runningMinutes: status === 'running' && pidSt
        ? Math.round((Date.now() - pidSt.mtimeMs) / 60000) : null,
      doneAt: iso(doneSt && doneSt.mtimeMs),
      touchedAt: iso(touched),
      touched,
      hasBrief: !!mdSt,
      runningMinutes: status === 'running' && pidSt
        ? Math.round((Date.now() - pidSt.mtimeMs) / 60000) : null,
      log: logSt ? rel(logPath) : null,
      logSize: logSt ? logSt.size : 0,
      logMtime,
      interjectable: !!(activeTable[name] && activeTable[name].interjectable)   // 运行中 pi RPC 任务可插嘴
    });
  }
  out.sort((a, b) => b.touched - a.touched);
  trackTaskSeen(out);
  return out;
}

/* ── 最近被删除的任务追踪 ────────────────────────
 * 每次 listTasks 时用当前 inbox 任务名与快照比对：
 * 快照里有、文件没了 → 记为已删除（首次发现时记 deletedAt）。
 * 快照持久化到 logs/tasks-seen.json（有变化才写，10s 节流）。 */
let seenTasks = {};          // name -> {firstSeen, lastSeenAt, lastStatus, agentId, deletedAt?}
let seenDirty = false;
let seenLastWrite = 0;
try { seenTasks = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')) || {}; } catch (e) { seenTasks = {}; }

/** 启动回填：butler.log 派发过、logs/ 里有日志，但 inbox 里已没有文件的任务 → 视为已删除。
 *  这样功能上线前就被删掉的任务也能补录进来（deletedAt 记为首次发现时间）。 */
function seedSeenFromLogs() {
  let changed = false;
  const t = tailBytes(BUTLER_LOG, 512 * 1024);
  const re = /派发\s*\[([^\]]+)\]\s*(?:→|->)\s*([^\s(]+)/g;
  let m;
  const dispatched = {};
  while ((m = re.exec(t.text))) dispatched[m[1]] = m[2];
  const inboxNames = new Set(listOf(INBOX).map(f => f.replace(/\.(md|DONE|PID)$/, '')));
  for (const [name, agentId] of Object.entries(dispatched)) {
    if (seenTasks[name]) continue;
    const logSt = statOf(path.join(LOGS, name + '.log'));
    const ts = logSt ? logSt.mtimeMs : Date.now();
    const gone = !inboxNames.has(name);
    seenTasks[name] = { firstSeen: ts, lastSeenAt: ts, lastStatus: gone ? 'unknown' : 'running', agentId };
    if (gone) seenTasks[name].deletedAt = Date.now();
    changed = true;
  }
  if (changed) {
    try { fs.mkdirSync(LOGS, { recursive: true }); fs.writeFileSync(SEEN_FILE, JSON.stringify(seenTasks), 'utf8'); }
    catch (e) {}
  }
}
seedSeenFromLogs();

function trackTaskSeen(tasks) {
  const now = Date.now();
  const names = new Set(tasks.map(t => t.name));
  for (const t of tasks) {
    const e = seenTasks[t.name];
    if (!e) {
      seenTasks[t.name] = { firstSeen: now, lastSeenAt: now, lastStatus: t.status, agentId: t.agentId };
      seenDirty = true;
    } else {
      if (e.deletedAt) { delete e.deletedAt; seenDirty = true; }   // 同名任务重新出现 → 复活
      e.lastSeenAt = now; e.lastStatus = t.status; e.agentId = t.agentId;
    }
  }
  for (const [name, e] of Object.entries(seenTasks)) {
    if (!names.has(name) && !e.deletedAt) {
      e.deletedAt = now;
      seenDirty = true;
    }
  }
  if (seenDirty && now - seenLastWrite > 10000) {
    seenLastWrite = now;
    seenDirty = false;
    try {
      fs.mkdirSync(LOGS, { recursive: true });
      fs.writeFileSync(SEEN_FILE, JSON.stringify(seenTasks), 'utf8');
    } catch (e) { /* 写失败下轮重试 */ }
  }
}

/** 最近 20 个被删除的任务（按删除时间倒序） */
function recentDeleted(limit) {
  const out = [];
  for (const [name, e] of Object.entries(seenTasks)) {
    if (e.deletedAt) out.push({ name, agentId: e.agentId || null, lastStatus: e.lastStatus || null,
                                lastSeenAt: iso(e.lastSeenAt), deletedAt: iso(e.deletedAt) });
  }
  out.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  return out.slice(0, limit || 20);
}
/* ── 各智能体活动概览 ──────────────────────────────────── */
function agentActivity(org, tasks) {
  const act = {};
  const now = Date.now();
  for (const [id, node] of Object.entries(org.nodes || {})) {
    if (node.type !== 'agent') continue;
    const mine = tasks.filter(t => t.agentId === id);
    const running = mine.filter(t => t.status === 'running');
    const doneT = mine.filter(t => t.status === 'done');
    const failT = mine.filter(t => t.status === 'failed');
    const withLog = mine.filter(t => t.log).sort((a, b) => b.logMtime - a.logMtime);
    const latest = withLog[0] || null;
    const ms = v => (typeof v === 'string' ? (Date.parse(v) || 0) : 0);   // Date.parse(0) 会得到 2000 年，必须挡住
    const lastMs = Math.max(latest ? latest.logMtime : 0, ms(node.lastTaskAt), ms(node.lastDoneAt));
    // 最近完成 / 最近失败（按 DONE 文件时间，找不到时退回日志 mtime）
    const tm = t => ms(t.doneAt) || t.logMtime || 0;
    const pickLatest = list => list.length ? list.reduce((a, b) => tm(a) >= tm(b) ? a : b) : null;
    const lastDone = pickLatest(doneT);
    const lastFail = pickLatest(failT);
    // busy 兜底：进程状态探测可能失效（管家/权限）导致 running 被误判 stale/pending →
    // 用「任务日志最近仍在写入」判『疑似在跑』，避免在跑任务被显示成灰色空闲（宁可标 ⚠ 也不误导）
    let busyUnknown = false, runningFallback = null;
    if (running.length === 0) {
      const staleT = mine.filter(t => t.status === 'stale' || t.status === 'pending');
      const recent = staleT.filter(t => t.logMtime && (now - t.logMtime) < 90 * 1000);
      if (recent.length) { busyUnknown = true; runningFallback = recent[0].name; }
    }
    act[id] = {
      id,
      component: !!node.component,
      busy: running.length > 0,
      busyUnknown,
      runningFallback,
      running: running.map(t => t.name),
      taskCount: mine.length,
      doneCount: doneT.length,
      failedCount: failT.length,
      latestTask: latest ? latest.name : null,
      latestLog: latest ? latest.log : null,
      latestDoneName: lastDone ? lastDone.name : null,
      latestDoneMs: lastDone ? tm(lastDone) : 0,
      latestFailedName: lastFail ? lastFail.name : null,
      latestFailMs: lastFail ? tm(lastFail) : 0,
      lastActivityAt: iso(lastMs) || null,
      lastActivityMs: lastMs
    };
  }
  return act;
}
/* ── 管家小结（本地计算版，无副作用） ─────────────────── */
/** 回退检测：PID 文件缺失/失效时查进程列表（butler.js 命令行匹配），防止文件丢失误报离线 */
function butlerPidFallback() {
  try {
    const { execFileSync } = require('child_process');
    const ps = String(execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -like '*butler.js*' } | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" })"],
      { stdio: 'pipe', windowsHide: true, timeout: 15000, encoding: 'utf8' }));
    const m = /(\d+)\s+[^\r\n]*butler\.js/.exec(ps);
    const pid = parseInt(m && m[1], 10);
    if (pid && alive(pid)) return pid;
  } catch (e) { /* 静默 */ }
  return null;
}

function butlerState() {
  const pid = parseInt((readIf(BUTLER_PID) || '').trim(), 10);
  const st = statOf(BUTLER_PID);
  const pidAlive = alive(pid);
  const fallbackPid = (!pidAlive) ? butlerPidFallback() : null;
  return {
    pid: Number.isNaN(pid) ? (fallbackPid || null) : (pidAlive ? pid : (fallbackPid || pid)),
    running: pidAlive || !!fallbackPid,
    since: st ? iso(st.mtimeMs) : null,
    viaFallback: !!fallbackPid
  };
}

function computeSummary(org, tasks, activity) {
  const lines = [];
  const counts = { agents: 0, groups: 0, active: 0, sleeping: 0, busy: 0, components: 0 };
  const seen = new Set();
  const walk = (id, depth) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const node = id === 'root' ? org.root : org.nodes[id];
    if (!node) { lines.push('  '.repeat(Math.max(0, depth - 1)) + `⚠ 缺失节点 ${id}`); return; }
    if (node.type === 'group') counts.groups++;
    // 系统组件（管家执行器 coo）不入智能体统计——它无 AI 大脑，只是机械执行器
    const isComponent = node.type === 'agent' && node.component === true;
    if (node.type === 'agent' && !isComponent) {
      counts.agents++;
      if (node.status === 'active') counts.active++;
      else if (node.status === 'sleeping') counts.sleeping++;
      if (activity[id] && activity[id].busy) counts.busy++;
    }
    if (isComponent) counts.components++;
    if (node.type !== 'root') {
      const busy = activity[id] && activity[id].busy;
      const icon = isComponent ? '⚙️' : (node.type === 'group' ? '📁' : (busy ? '⚡' : '🤖'));
      const status = node.status ? ` [${node.status}]` : '';
      // 系统组件不显示伪活动的「最后任务」（执行器无大脑，不标榜活动）
      const last = (!isComponent && node.lastTaskAt) ? ` 最后任务 ${String(node.lastTaskAt).slice(0, 16).replace('T', ' ')}` : '';
      const tag = isComponent ? '（系统组件·非AI）' : '';
      lines.push('  '.repeat(Math.max(0, depth - 1)) + `${icon} ${node.label || id}${tag}${status}${last}`);
    }
    for (const c of (node.children || [])) walk(c, depth + 1);
  };
  walk('root', 0);

  const running = tasks.filter(t => t.status === 'running');
  const pending = tasks.filter(t => t.status === 'pending');
  const failed  = tasks.filter(t => t.status === 'failed');
  const b = butlerState();
  const out = ['=== 管家小结 ===',
    `管家进程: ${b.running ? `运行中 (PID=${b.pid})` : '未运行'}`,
    `智能体 ${counts.agents} 个（active ${counts.active} / sleeping ${counts.sleeping} / 正在干活 ${counts.busy}）· 组 ${counts.groups} 个${counts.components ? ` · 系统组件 ${counts.components} 个（非 AI）` : ''}`,
    '', ...lines, '',
    `活动任务: ${running.length} 个`,
    ...running.map(t => `  ▸ [${t.name}] → ${t.agentId || '?'}（已跑 ${t.runningMinutes != null ? t.runningMinutes : '?'} 分钟）`),
    `待处理: ${pending.length} 个 · 失败: ${failed.length} 个`
  ];
  return { text: out.join('\n'), counts, butler: b, generatedAt: new Date().toISOString() };
}
/* ── 真实 butler --summary（显式触发，30s 缓存） ─────────
 * 注意：butler.js 的 printSummary 会往 butler.log 追加日志，属于副作用，
 * 所以只在前端点"跑一次真实小结"时才调用，默认走 computeSummary。   */
let realCache = { at: 0, text: '', code: null, running: false };
function realSummary(cb) {
  if (Date.now() - realCache.at < 30000 && realCache.text) {
    return cb(null, { text: realCache.text, cached: true, at: iso(realCache.at), exitCode: realCache.code });
  }
  if (realCache.running) return cb(null, { text: realCache.text || '（正在执行…）', cached: true, at: iso(realCache.at), exitCode: null });
  realCache.running = true;
  let out = '', done = false;
  const child = spawn(process.execPath, [path.join(ORG_ROOT, 'butler.js'), '--summary'],
    { cwd: ORG_ROOT, windowsHide: true });
  const finish = (code) => {
    if (done) return; done = true;
    realCache = { at: Date.now(), text: out.trim() || '(无输出)', code, running: false };
    cb(null, { text: realCache.text, cached: false, at: iso(realCache.at), exitCode: code });
  };
  child.stdout.on('data', d => { out += d.toString(); });
  child.stderr.on('data', d => { out += d.toString(); });
  child.on('error', e => { out += '\n[spawn 失败] ' + e.message; finish(-1); });
  child.on('close', finish);
  setTimeout(() => { if (!done) { try { child.kill(); } catch (e) {} out += '\n[超时 15s，已终止]'; finish(-2); } }, 15000);
}

/* ── 整体快照 ───────────────────────────────────────────── */
function snapshot() {
  const org = loadOrg();
  const tasks = listTasks(org);
  const activity = agentActivity(org, tasks);
  const summary = computeSummary(org, tasks, activity);
  const twinAct = readActivity(50);
  return {
    ok: true,
    now: new Date().toISOString(),
    chatAgents: chatAgentsList(),
    orgRoot: ORG_ROOT.replace(/\\/g, '/'),
    org: { error: org.error || null, version: org.version || null, updatedAt: org.updatedAt || null,
           root: org.root || null, nodes: org.nodes || {} },
    tasks, activity, summary,
    twin: Object.assign({}, twinDaemonStatus(), {
      activityMtime: twinAct.mtime, activitySize: twinAct.size,
      lastActivity: twinAct.lines[twinAct.lines.length - 1] || null
    }),
    recentDeleted: recentDeleted(20)
  };
}
/* ── 集群健康摘要（供 xxsx-admin-android 后端轮询 / APP 集群卡片）── */
function clusterHealth() {
  const snap = snapshot();
  const runningTasks = (snap.tasks || []).filter(t => t.status === 'running');
  const recentTasks = (snap.tasks || [])
    .filter(t => t.status === 'done' || t.status === 'failed')
    .sort((a, b) => (b.finishedAt || b.mtime || 0) - (a.finishedAt || a.mtime || 0))
    .slice(0, 10)
    .map(t => ({
      name: t.name,
      status: t.status,
      agentId: t.agentId || null,
      finishedAt: t.finishedAt || null,
    }));
  // 模型渠道健康 + 全挂告警（model-fallback-chain 落盘：logs/channel-health.json / channel-outage.json）
  let health = {};
  let outage = [];
  try { health = JSON.parse(readIf(path.join(LOGS, 'channel-health.json')) || '{}') || {}; } catch (e) { health = {}; }
  try {
    const raw = readIf(path.join(LOGS, 'channel-outage.json'));
    if (raw) {
      outage = raw.trim().split(/\r?\n/)
        .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
        .filter(Boolean);
    }
  } catch (e) { outage = []; }
  const last = outage.length ? outage[outage.length - 1] : null;
  return {
    ok: true,
    generatedAt: snap.now,
    butler: (snap.summary && snap.summary.butler) || { running: false },
    twin: snap.twin || { running: false },
    agents: (snap.summary && snap.summary.counts) || { agents: 0, active: 0, sleeping: 0, busy: 0 },
    runningTasks: runningTasks.map(t => ({ name: t.name, agentId: t.agentId, runningMinutes: t.runningMinutes })),
    recentTasks,
    channel: {
      health,
      outage: outage.slice(-20),
      allChannelsFailed: !!(last && last.allChannelsFailed),
      lastOutageAt: last ? last.ts : null,
      lastOutageTask: last ? (last.task || null) : null,
    },
  };
}

/* ── 集群握手（GET/POST /api/cluster/handshake，2026-08-11 P1）────────────
 * 两阶段语义：
 *   1) 无 token → 识别阶段：返回集群身份（is_cluster/cluster_name/version/
 *      required_fields），不含任何敏感数据（token/密钥/路径都不外泄）。
 *   2) 带 token（x-pi-token / ?token= / Bearer，含 CLUSTER_TOKEN）→ 正式握手：auth:true。
 * 非集群（本 org web 未在运行编排：无 butler/twin/agents）→ is_cluster:false 明确标记。
 * 与 /api/cluster/health 同一鉴权体系（x-pi-token / ?token=），但识别阶段不强制鉴权。 */
function clusterHandshake(req, res, q) {
  const snap = snapshot();
  const org = loadOrg();
  const butler = (snap.summary && snap.summary.butler) || { running: false };
  const twin = snap.twin || { running: false };
  const counts = (snap.summary && snap.summary.counts) || { agents: 0 };
  const agents = counts.agents || 0;
  const isCluster = !!(butler.running || twin.running || agents > 0);
  const clusterName = (org && typeof org.name === 'string' && org.name.trim())
    ? org.name.trim() : 'xxsx 智能体集群';
  const version = (org && org.version) ? String(org.version) : '';
  const bearerTok = (/^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '') || [])[1] || '';
  const tokenValid = authOk(req, q, res)
    || (CLUSTER_TOKEN && (req.headers['x-pi-token'] === CLUSTER_TOKEN || bearerTok === CLUSTER_TOKEN));
  return sendJson(res, {
    ok: true,
    endpoint: '/api/cluster/handshake',
    is_cluster: isCluster,
    cluster_name: clusterName,
    version: version,
    required_fields: isCluster ? ['token'] : [],
    auth: !!tokenValid,
    auth_type: 'x-pi-token / ?token= / Bearer',
    generatedAt: snap.now,
  });
}

/* ── 集群文档列表/下载（2026-08-08）────────────────────── */
/** 只暴露 agents 下 artifacts 与 knowledge 目录里的 .md（非敏感，隐私铁律：不碰微信/隐私数据）。 */
function clusterDocs() {
  const list = [];
  const fmtSize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const push = (absPath, agent) => {
    try {
      const st = fs.statSync(absPath);
      if (!st.isFile()) return;
      const relPath = path.relative(ORG_ROOT, absPath).split(path.sep).join('/');
      list.push({
        name: path.basename(absPath),
        path: relPath,
        agent,
        size: st.size,
        sizeText: fmtSize(st.size),
        mtime: st.mtimeMs,
        mtimeText: new Date(st.mtimeMs).toLocaleString('zh-CN'),
      });
    } catch (e) {}
  };
  const agentsDir = path.join(ORG_ROOT, 'agents');
  try {
    for (const a of fs.readdirSync(agentsDir)) {
      const artDir = path.join(agentsDir, a, 'artifacts');
      if (!fs.existsSync(artDir)) continue;
      for (const f of fs.readdirSync(artDir)) {
        if (f.toLowerCase().endsWith('.md')) push(path.join(artDir, f), a);
      }
    }
  } catch (e) {}
  const knowDir = path.join(ORG_ROOT, 'knowledge');
  const walk = dir => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) push(full, 'knowledge');
      }
    } catch (err) {}
  };
  try { if (fs.existsSync(knowDir)) walk(knowDir); } catch (e) {}
  list.sort((a, b) => b.mtime - a.mtime);
  return { ok: true, docs: list, count: list.length, generatedAt: Date.now() };
}

/** 智能体回复附带最近文档（对话内附件，2026-08-08 v1.7.10）
 * 复用 clusterDocs 的数据源（各 agent 的 artifacts 目录 + knowledge 下的 .md，非敏感）。
 * 优先附「回复文本里被提及文件名」匹配上的文档；不足再补最近文档补齐到 n 篇。
 * 返回 [{name, path, size, sizeText, kind, url}]，url 走既有 /api/cluster/docs/content 下载接口。 */
function clusterChatAttachments(replyText, n) {
  const all = clusterDocs().docs || [];   // 已按 mtime 倒序
  const limit = Math.max(0, Math.min(6, Number(n) || 3));
  if (all.length === 0) return [];
  const kindOf = name => {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return { md: 'md', markdown: 'md', txt: 'txt', pdf: 'pdf', doc: 'doc', docx: 'docx',
             apk: 'apk', html: 'html', htm: 'html', json: 'json', csv: 'csv' }[ext] || ext;
  };
  const toAtt = d => ({
    name: d.name, path: d.path, size: d.size, sizeText: d.sizeText,
    kind: kindOf(d.name), url: '/api/cluster/docs/content?path=' + encodeURIComponent(d.path),
  });
  const mentioned = [];
  const rest = [];
  if (replyText) {
    const text = String(replyText);
    for (const d of all) {
      // 回复里出现文件名（含 .md 后缀）或反引号包裹的名字 → 视为引用
      const base = (d.name || '').replace(/\.[a-z0-9]+$/i, '');
      if (text.includes(d.name) || (base.length >= 3 && text.includes(base))) mentioned.push(toAtt(d));
      else rest.push(toAtt(d));
    }
  } else {
    rest.push(...all.map(toAtt));
  }
  const out = mentioned.slice(0, limit);
  for (const a of rest) {
    if (out.length >= limit) break;
    if (!out.some(o => o.path === a.path)) out.push(a);
  }
  return out;
}

/** 下载单篇文档（仅允许 agents 下 artifacts 与 knowledge 目录里的 .md） */
function handleClusterDocContent(req, res, p) {
  if (!p) return sendJson(res, { ok: false, error: '缺少 path' }, 400);
  const abs = safeOrgPath(p);
  if (!abs) return sendJson(res, { ok: false, error: '路径不合法' }, 400);
  const relPath = path.relative(ORG_ROOT, abs).split(path.sep).join('/');
  const okArtifact = /^agents\/[^\/]+\/artifacts\/[\w.\- ]+\.md$/i.test(relPath);
  const okKnowledge = /^knowledge\/(?:[\w.\- ]+\/)*[\w.\- ]+\.md$/i.test(relPath);
  if (!okArtifact && !okKnowledge) {
    return sendJson(res, { ok: false, error: '仅支持 agents artifacts 与 knowledge 下的 Markdown 文档' }, 403);
  }
  const st = statOf(abs);
  if (!st || !st.isFile()) return sendJson(res, { ok: false, error: '文档不存在' }, 404);
  const content = readIf(abs) || '';
  res.writeHead(200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(abs))}"`,
    'X-XXSX-Doc-Size': String(st.size),
  });
  res.end(content);
}

/* ── 单个智能体详情 ─────────────────────────────────────── */

/* ── 远端（服务器集群）代理 ─────────────────────────────── */
let _remoteCache = { at: 0, data: null };

/** 读本地远端配置（web/remote-config.json；环境变量可覆盖，均不入代码） */
function loadRemoteCfg() {
  let url = process.env.PI_REMOTE_URL || null;
  let token = process.env.PI_REMOTE_TOKEN || null;
  let name = process.env.PI_REMOTE_NAME || null;
  if (!url || !token) {
    try {
      const c = JSON.parse(readIf(REMOTE_CFG_FILE) || '{}');
      url = url || c.url || null;
      token = token || c.token || null;
      name = name || c.name || null;
    } catch (e) { return null; }
  }
  if (!url || !token) return null;
  return { url, token, name: name || '服务器集群' };
}

/**
 * 经 Tailscale 转发远端 org web 的 /api/state（带 x-pi-token）。
 * 15s 缓存；?force=1 跳过缓存。返回 Promise<远端快照或 {ok:false,error,code}>。
 */
function fetchRemoteState(force) {
  return new Promise(resolve => {
    const cfg = loadRemoteCfg();
    if (!cfg) {
      return resolve({ ok: false, code: 'NO_CFG', error: '远端未配置：web/remote-config.json 缺失或字段不全（或设 PI_REMOTE_URL/PI_REMOTE_TOKEN）' });
    }
    const now = Date.now();
    if (!force && _remoteCache.data && now - _remoteCache.at < REMOTE_CACHE_MS) {
      return resolve(Object.assign({ cached: true, from: cfg.name }, _remoteCache.data));
    }
    const req = http.get(cfg.url, {
      timeout: REMOTE_TIMEOUT,
      headers: { 'x-pi-token': cfg.token, accept: 'application/json' }
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; if (body.length > 8 * 1024 * 1024) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return resolve({ ok: false, code: 'HTTP_' + res.statusCode, error: `远端 ${cfg.url} 返回 HTTP ${res.statusCode}` });
        }
        try {
          const d = JSON.parse(body);
          _remoteCache = { at: Date.now(), data: d };
          resolve(Object.assign({ cached: false, from: cfg.name }, d));
        } catch (e) {
          resolve({ ok: false, code: 'BAD_JSON', error: '远端响应解析失败: ' + e.message });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, code: 'TIMEOUT', error: `远端超时（${REMOTE_TIMEOUT}ms，Tailscale 链路可能未通）` });
    });
    req.on('error', e => resolve({ ok: false, code: 'NET', error: '远端请求失败: ' + e.message }));
  });
}

/** 角色 fallback 日志（2026-08-07 console-activity-fix）
 * 常驻角色（分身/管家/学习进化官）不依赖任务日志：节点没有任务日志时，
 * 按角色读各自的常驻活动源，让控制台“最新输出”显示真实活动。 */
function roleFallbackLog(id, maxEvents) {
  const limit = (maxEvents || MAX_EVENTS) > 0 ? (maxEvents || MAX_EVENTS) : MAX_EVENTS;

  /* ── 分身：activity.log 常驻活动流（[巡查]/[对话]/[决策]/[验收]） ── */
  if (id === 'twin') {
    const act = readActivity(Math.min(limit, 500));
    if (!act.lines.length) return null;
    return {
      file: rel(TWIN_ACTIVITY), size: act.size, mtime: act.mtime, format: 'activity',
      events: act.lines.slice().reverse().map(l => ({ kind: 'activity', tag: l.tag, ts: l.ts, text: l.text })),  // 最新在前
      total: act.lines.length, dropped: 0,
      meta: { note: '分身常驻活动流（activity.log：巡查/对话/决策/验收）' }
    };
  }

  /* ── 管家（及管家分身）：butler.log 常驻派发/摘要日志 ── */
  if (id === 'coo' || id === 'butler') {
    const t = tailBytes(BUTLER_LOG, 512 * 1024);
    const lines = t.text.split(/\r?\n/).filter(Boolean).slice(-limit);
    if (!lines.length) return null;
    return {
      file: rel(BUTLER_LOG), size: t.size, mtime: t.mtime, format: 'text',
      events: lines.map(l => ({ kind: 'raw', ts: null, text: l })),
      total: lines.length, dropped: 0,
      meta: { note: '管家常驻日志（butler.log：派发/摘要/巡检）' }
    };
  }

  /* ── 学习进化官：patrol 巡检记录（entity-review-log.md + 巡检运行日志） ── */
  if (id === 'learning-officer') {
    const revLog = path.join(ORG_ROOT, 'agents', 'learning-officer', 'memory', 'entity-review-log.md');
    const patrolLog = path.join(LOGS, 'learning-officer-patrol.log');
    const revSt = statOf(revLog), patSt = statOf(patrolLog);
    if (!revSt && !patSt) {
      return {
        file: null, size: 0, mtime: 0, format: 'text',
        events: [{ kind: 'raw', ts: null, text: '常驻巡查待启用（patrol.js 尚未产生活动记录，管家每小时会自动拉起）' }],
        total: 1, dropped: 0,
        meta: { note: '学习进化官（patrol.js 巡检产出）' }
      };
    }
    const events = [];
    if (patSt) {
      const t = tailBytes(patrolLog, 128 * 1024);
      const lines = t.text.split(/\r?\n/).filter(Boolean).slice(-Math.min(limit, 200));
      if (lines.length) events.push({ kind: 'raw', ts: null, text: lines.join('\n') });
    }
    if (revSt) {
      const t = tailBytes(revLog, 128 * 1024);
      const raw = t.text.split(/\r?\n/).filter(Boolean);
      // 只取最近 limit 行，保留巡检节结构
      const lines = raw.slice(-Math.min(limit, 200));
      if (lines.length) events.push({ kind: 'raw', ts: null, text: lines.join('\n') });
    }
    if (!events.length) return null;
    return {
      file: rel(revSt ? revLog : patrolLog), size: (revSt ? revSt.size : 0) + (patSt ? patSt.size : 0),
      mtime: Math.max(revSt ? revSt.mtimeMs : 0, patSt ? patSt.mtimeMs : 0),
      format: 'text', events, total: events.length, dropped: 0,
      meta: { note: '学习进化官巡检记录（patrol.js 产出）' }
    };
  }

  return null;
}

function agentDetail(id, taskName, maxEvents, fullText) {
  const org = loadOrg();
  const node = (id === 'root') ? org.root : org.nodes[id];
  if (!node) return { ok: false, error: `未知节点: ${id}` };

  const tasks = listTasks(org);
  const activity = agentActivity(org, tasks);
  const mine = tasks.filter(t => t.agentId === id);
  const dir = path.join(ORG_ROOT, node.agentDir || node.groupDir || ('agents/' + id));

  // 选哪个日志：显式指定 task > 最近有日志的任务
  let pick = null;
  if (taskName) pick = mine.find(t => t.name === taskName) || null;
  if (!pick) pick = mine.filter(t => t.log).sort((a, b) => b.logMtime - a.logMtime)[0] || null;

  const log = pick ? parseLogTail(path.join(LOGS, pick.name + '.log'), maxEvents, fullText)
                   : roleFallbackLog(id, maxEvents);

  const memDir = path.join(dir, 'memory');
  const tkDir = path.join(dir, 'tasks');
  const fileList = d => listOf(d).map(f => {
    const st = statOf(path.join(d, f));
    return { name: f, path: rel(path.join(d, f)), size: st ? st.size : 0, mtime: iso(st ? st.mtimeMs : 0) };
  }).sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));

  const identityRaw = readIf(path.join(dir, 'identity.json'));
  let identity = null;
  if (identityRaw) { try { identity = JSON.parse(identityRaw); } catch (e) { identity = { parseError: e.message }; } }

  return {
    ok: true, id, node,
    activity: activity[id] || null,
    dir: rel(dir), dirExists: !!statOf(dir),
    identity,
    tasks: mine,
    selectedTask: pick ? pick.name : null,
    log,
    memory: fileList(memDir),
    taskFiles: fileList(tkDir),
    now: new Date().toISOString()
  };
}
/* ── HTTP ───────────────────────────────────────────────── */
/* ── 与智能体对话（常驻 pi rpc 子进程池，懒启动） ────────────
 * 协议照抄 lib/spawn.js 的 pi 分支（已验证）：spawn 后 3 秒直接发 prompt，不等 READY。
 * 回复完成信号以 docs/rpc.md 为准：agent_settled（完全落定）；agent_end 后 5s 宽限。
 * 拿不到文本时兼容用 get_last_assistant_text 补一次。 */
const PI_BIN = process.env.PI_BIN || 'C:/Users/du_ji/AppData/Roaming/npm/pi.cmd';
const CHAT_PROVIDER = process.env.PI_CHAT_PROVIDER || 'aliyun-tokenplan';
const CHAT_MODEL    = process.env.PI_CHAT_MODEL || 'qwen3.8-max-preview';
const CHAT_THINKING = process.env.PI_CHAT_THINKING || 'max';
const CHAT_SPAWN_WAIT_MS   = 3000;            // 新进程首条 prompt 等待（协议要求）
const CHAT_IDLE_CLOSE_MS   = 30 * 60 * 1000;  // 空闲 30 分钟自动关闭
const CHAT_REPLY_TIMEOUT_MS = 180 * 1000;     // 单轮回复超时
const CHAT_MAX_BODY = 64 * 1024;
const CHAT_MAX_MSG  = 8000;

/* ── 集群对话接口（/api/cluster/chat）───────────────────
 * 供服务器集群（HK）new-api assistant 的「分身」后端转发到本机分身。
 * 鉴权用独立 CLUSTER_TOKEN（env PI_CLUSTER_TOKEN，x-pi-token 头）；
 * 未配置时回退全局 TOKEN。自带简单限流防刷。 */
const CLUSTER_TOKEN = String(process.env.PI_CLUSTER_TOKEN || '');
const CLUSTER_RATE_WINDOW_MS = 30 * 1000;
const CLUSTER_RATE_BURST     = 20;    // 30s 内最多 20 条（突发容忍）
const clusterHits = new Map();        // ip -> {count, resetAt}
function clusterRateOK(ip) {
  const now = Date.now();
  const rec = clusterHits.get(ip);
  if (!rec || now >= rec.resetAt) {
    clusterHits.set(ip, { count: 1, resetAt: now + CLUSTER_RATE_WINDOW_MS });
    return true;
  }
  if (rec.count >= CLUSTER_RATE_BURST) return false;
  rec.count++;
  return true;
}

const chatPool = new Map();   // id -> handle

/* ── 分身常驻进程（twin-daemon）桥接 ────────────────────
 * v5.1：分身是常驻后台进程（lib/twin-daemon.js，TCP 127.0.0.1:18788）。
 * 对话 twin 时优先转发给它（不另起 pi 子进程）；通道不可用才回退懒启动。 */
const net = require('net');

/* ── 分身在线判定（双因子，2026-08-09 console-chat-optimize） ──
 * 历史问题：web 只查 twin.pid 的 PID 存活，PID 文件与实际进程脱节就误判「离线」。
 * 现改为双因子：PID 存活 AND（activity.log 近 10 分钟在输出 OR TCP 18788 可连）。
 *   - PID 过期但 activity.log 仍在输出 → 推断活跃（inferred=true）
 *   - 僵死进程（PID 在但日志停滞且 TCP 不通）→ 标离线
 * TCP 探测用异步缓存，避免同步 connect 阻塞请求线程。 */
const TWIN_ACT_FRESH_MS = (process.env.TWIN_ACT_FRESH_MS ? parseInt(process.env.TWIN_ACT_FRESH_MS, 10) : 10) * 60 * 1000;
let twinTcp = { alive: false, at: 0 };   // 最近一次 TCP 探测结果缓存
function probeTwinTcp() {
  const now = Date.now();
  if (now - twinTcp.at < 3000) return;   // 节流：3 秒最多探一次，避免频繁建连
  const sock = net.connect(TWIN_DAO_PORT, '127.0.0.1', () => {
    twinTcp = { alive: true, at: Date.now() };
    try { sock.end(); } catch (e) {}
  });
  sock.on('error', () => { twinTcp = { alive: false, at: Date.now() }; });
}
function twinTcpAlive() { probeTwinTcp(); return twinTcp.alive; }

function twinDaemonStatus() {
  const now = Date.now();
  const pidRaw = (readIf(TWIN_PID) || '').trim();
  const pid = parseInt(pidRaw, 10);
  const pidOk = !Number.isNaN(pid) && alive(pid);
  const st = statOf(TWIN_PID);

  // 活跃信号 1：activity.log 近 10 分钟仍在输出（分身巡查/对话/决策/验收都会写）
  const act = statOf(TWIN_ACTIVITY);
  const actFresh = !!(act && act.isFile() && (now - act.mtimeMs) < TWIN_ACT_FRESH_MS);
  const actMtime = act && act.isFile() ? iso(act.mtimeMs) : null;
  // 活跃信号 2：TCP 18788 可连（缓存探测结果）
  const tcpOk = twinTcpAlive();

  let running;
  let inferred = false;
  let reason = '';
  if (pidOk && (actFresh || tcpOk)) {
    running = true; reason = 'pid+active';                    // 双因子健康 → 在线
  } else if (!pidOk && (actFresh || tcpOk)) {
    running = true; inferred = true;                          // PID 过期但足迹/端口仍在输出 → 推断活跃
    reason = actFresh ? 'infer-activity' : 'infer-tcp';
  } else if (pidOk && !actFresh && !tcpOk) {
    running = false; reason = 'zombie';                       // 僵死：PID 在但日志停滞+TCP 不通
  } else {
    running = false; reason = 'no-signal';                    // 无 PID 且无活跃信号 → 离线
  }

  return {
    running, pid: running ? pid : null, since: st && st.isFile() ? iso(st.mtimeMs) : null,
    pidAlive: pidOk, activityFresh: actFresh, activityMtime: actMtime,
    tcpAlive: tcpOk, inferred, reason
  };
}

/** 向常驻分身发一条 JSON lines 请求，等匹配 id 的 reply/tpong 回复 */
function twinDaemonRequest(obj, timeoutMs) {
  return new Promise((resolve) => {
    const id = obj.id || ('w-' + Date.now());
    const sock = net.connect(TWIN_DAO_PORT, '127.0.0.1', () => {
      try { sock.write(JSON.stringify(Object.assign({}, obj, { id })) + '\n'); } catch (e) { resolve({ ok: false, error: '写入分身通道失败: ' + e.message }); }
    });
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve({ ok: false, error: '分身回复超时' }); }
    }, timeoutMs || 200000);
    sock.on('data', d => {
      if (done) return;
      const line = d.toString('utf8').trim();
      if (!line) return;
      try {
        const o = JSON.parse(line);
        if ((o.type === 'reply' || o.type === 'pong') && o.id === id) {
          done = true; clearTimeout(timer);
          try { sock.end(); } catch (e) {}
          resolve(o);
        }
      } catch (e) { /* 非 JSON 静默 */ }
    });
    sock.on('error', e => {
      if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, error: '分身通道不可用: ' + e.message }); }
    });
  });
}

/* ── 集群对话：POST /api/cluster/chat ───────────────────
 * {message, session?} → 转发分身常驻 daemon（18788）→ 返回 {reply,...}。
 * 分身对话仅走脱敏人格（user-twin），不包含微信原始数据（隐私铁律）。 */
/* ── 集群对话：POST /v1/chat/completions（OpenAI 兼容） ────
 * 把分身（虚无圣灵）暴露为 OpenAI 兼容端点，供 new-api 以「渠道」方式接入
 * （channel → http://100.103.204.86:8787/v1/chat/completions，Bearer=cluster token）。
 * 取消息里最后一条 user/assistant 内容作为分身输入，返回标准 choices 结构。 */
function handleClusterOpenAICompat(req, res) {
  let size = 0;
  const chunks = [];
  req.on('data', d => {
    size += d.length;
    if (size > CHAT_MAX_BODY) { req.destroy(); return; }
    chunks.push(d);
  });
  req.on('end', () => {
    if (size > CHAT_MAX_BODY) return sendJson(res, { ok: false, error: 'body 过大' }, 400);
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch (e) { return sendJson(res, { ok: false, error: 'body 不是 JSON' }, 400); }
    const ip = req.socket.remoteAddress || 'unknown';
    if (!clusterRateOK(ip)) return sendJson(res, { error: { message: '请求过于频繁' }, type: 'rate_limit' }, 429);
    let message = '';
    if (Array.isArray(body.messages)) {
      const last = body.messages.filter(m => m && typeof m.content === 'string' && m.content.trim()).pop();
      if (last) message = last.content.trim();
    }
    if (!message && typeof body.prompt === 'string') message = body.prompt.trim();
    if (!message) return sendJson(res, { error: { message: '缺少 messages/prompt' }, type: 'invalid_request' }, 400);
    if (!twinDaemonStatus().running) return sendJson(res, { error: { message: '本机分身未在运行' }, type: 'server_error' }, 503);
    twinDaemonRequest({ type: 'chat', message }).then(r => {
      if (r && r.ok && typeof r.reply === 'string') {
        const attachments = clusterChatAttachments(r.reply, 3);
        const msg = { role: 'assistant', content: r.reply };
        if (attachments.length) msg.attachments = attachments;
        return sendJson(res, {
          id: 'chatcmpl-twin-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: (body.model || 'twin') + '',
          choices: [{ index: 0, message: msg, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          backend: 'twin'
        });
      }
      const err = (r && r.error) || '分身无回复';
      sendJson(res, { error: { message: err }, type: 'server_error' }, 502);
    });
  });
  req.on('error', () => {});
}

function handleClusterChatPost(req, res) {
  let size = 0;
  const chunks = [];
  req.on('data', d => {
    size += d.length;
    if (size > CHAT_MAX_BODY) { req.destroy(); return; }
    chunks.push(d);
  });
  req.on('end', () => {
    if (size > CHAT_MAX_BODY) return sendJson(res, { ok: false, error: 'body 过大' }, 400);
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch (e) { return sendJson(res, { ok: false, error: 'body 不是 JSON' }, 400); }
    const msg = typeof body.message === 'string' ? body.message.trim() : '';
    if (!msg) return sendJson(res, { ok: false, error: '缺少 message' }, 400);
    if (msg.length > CHAT_MAX_MSG) return sendJson(res, { ok: false, error: 'message 过长（>8000 字符）' }, 400);
    const ip = req.socket.remoteAddress || 'unknown';
    if (!clusterRateOK(ip)) return sendJson(res, { ok: false, error: '请求过于频繁，请稍后再试' }, 429);
    if (!twinDaemonStatus().running) return sendJson(res, { ok: false, error: '本机分身未在运行' }, 503);
    twinDaemonRequest({ type: 'chat', message: msg, id: body.id || undefined }).then(r => {
      if (r && r.ok && typeof r.reply === 'string') {
        const out = { ok: true, reply: r.reply, tookMs: r.tookMs, via: 'twin-daemon', backend: 'twin' };
        const attachments = clusterChatAttachments(r.reply, 3);
        if (attachments.length) out.attachments = attachments;
        return sendJson(res, out);
      }
      sendJson(res, { ok: false, error: (r && r.error) || '分身无回复' }, (r && r.code) || 500);
    });
  });
  req.on('error', () => {});
}

/** 全链路时间线：分身指示 → 管家派发 → 执行 → 完成 → 分身验收 */
function taskTrace(taskName) {
  const ev = [];
  const name = String(taskName || '').replace(/[\/\\]/g, '');
  if (!name) return { ok: false, error: '缺少 task' };
  const mdPath = path.join(INBOX, name + '.md');
  const donePath = path.join(INBOX, name + '.DONE');
  const logPath = path.join(LOGS, name + '.log');
  const mdSt = statOf(mdPath), doneSt = statOf(donePath), logSt = statOf(logPath);

  if (!mdSt && !doneSt && !logSt) return { ok: true, task: name, events: [], note: 'inbox/logs 里找不到该任务' };

  // 1. 投递（分身/入口）
  if (mdSt) ev.push({ stage: 'twin-order', ts: iso(mdSt.mtimeMs),
    text: `分身/入口投递 → inbox/${name}.md`, detail: '任务文件创建' });
  // 2. 管家派发（butler.log 匹配）
  const bl = tailBytes(BUTLER_LOG, 512 * 1024).text;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dm = new RegExp('派发\\s*\\[' + esc + '\\]\\s*(?:→|->)\\s*(\\S+)').exec(bl);
  if (dm) {
    const det = bl.split(/\r?\n/).filter(l => l.includes('派发') && l.includes(name)).pop() || '';
    ev.push({ stage: 'butler-dispatch', ts: null, text: `管家派发 → ${dm[1]}`, detail: det.trim().slice(0, 160) });
  }
  // 3. 执行
  if (logSt) ev.push({ stage: 'execute', ts: iso(logSt.mtimeMs),
    text: `执行中 → logs/${name}.log`, detail: logSt.size > 0 ? `日志 ${fmtByte(logSt.size)}` : '日志为空' });
  // 4. 完成
  if (doneSt) {
    const txt = (readIf(donePath) || '').trim();
    ev.push({ stage: 'done', ts: iso(doneSt.mtimeMs),
      text: /\.FAILED/i.test(txt) ? '❌ 失败' : '✅ 完成', detail: txt.slice(0, 200) || '(空 DONE)' });
  }
  // 5. 分身验收（activity.log 匹配）
  const acc = readActivity(600).lines.filter(l => l.text && l.text.includes(name));
  const lastAcc = acc[acc.length - 1];
  if (lastAcc) ev.push({ stage: 'twin-accept', ts: lastAcc.ts, text: `分身验收：${lastAcc.text.slice(0, 120)}`, detail: lastAcc.tag });
  return { ok: true, task: name, events: ev };
}

function fmtByte(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** 可对话智能体 = org.json 里的 agent 节点且 agents/<id>/AGENTS.md（人格文件）存在 */
function chatAgentsList() {
  const org = loadOrg();
  const out = [];
  for (const [id, node] of Object.entries(org.nodes || {})) {
    if (node.type !== 'agent') continue;
    // 系统组件（管家执行器 coo）无 AI 大脑，不可对话，排除出聊天列表
    if (node.component === true) continue;
    const dir = path.join(ORG_ROOT, node.agentDir || ('agents/' + id));
    // 目录存在即可对话（不再要求 AGENTS.md——所有智能体都可聊，persona 由后端默认补充）
    if (statOf(dir)) out.push({ id, label: node.label || id });
  }
  return out;
}
const chatAgentOk = id => /^[\w-]+$/.test(String(id)) && chatAgentsList().some(a => a.id === id);

function appendChatHistory(id, role, content) {
  try {
    const d = path.join(ORG_ROOT, 'agents', id, 'chat');
    fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, 'history.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), role, content }) + '\n', 'utf8');
  } catch (e) { /* 历史记录失败不影响对话 */ }
}

function readChatHistory(id, limit) {
  const t = tailBytes(path.join(ORG_ROOT, 'agents', id, 'chat', 'history.jsonl'), 512 * 1024);
  const lines = t.text.split(/\r?\n/);
  if (t.truncated && lines.length) lines.shift();
  const out = [];
  for (const l of lines) {
    const s = l.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && (o.role === 'user' || o.role === 'assistant') && o.content != null) out.push(o);
    } catch (e) { /* 环行忽略 */ }
  }
  return limit ? out.slice(-limit) : out;
}

function killChatTree(h) {
  if (!h.child || h.dead) return;
  h.dead = true;
  const pid = h.child.pid;
  try { h.child.stdin.end(); } catch (e) {}
  try { h.child.kill('SIGTERM'); } catch (e) {}
  // Windows 下 cmd /c 包了一层，杀进程树
  if (pid && process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
  }
}

function failQueue(h, error) {
  const q = h.queue; h.queue = [];
  for (const item of q) { try { item.res({ ok: false, error }, 500); } catch (e) {} }
}

function finishPending(h, result, code) {
  const p = h.pending;
  if (!p) return;
  h.pending = null;
  for (const t of ['timer', 'settleTimer', 'lastTimer']) if (p[t]) clearTimeout(p[t]);
  if (result.ok && result.reply) appendChatHistory(h.id, 'assistant', result.reply);
  h.lastActive = Date.now();
  result.agentId = h.id;
  result.tookMs = Date.now() - p.startedAt;
  try { p.res(result, code); } catch (e) {}
  const next = h.queue.shift();
  if (next) startChatTurn(h, next.message, next.res);
}

/** 落定：有文本直接回；没文本就补一次 get_last_assistant_text */
function settleChat(h) {
  const p = h.pending;
  if (!p || p.wantLast) return;
  if (p.lastText) return finishPending(h, { ok: true, reply: p.lastText, notes: p.notes.length ? p.notes : undefined });
  p.wantLast = true;
  try {
    h.child.stdin.write(JSON.stringify({ type: 'get_last_assistant_text', id: 'last-' + Date.now() }) + '\n');
  } catch (e) {
    return finishPending(h, { ok: false, error: '拿不到回复内容: ' + e.message }, 500);
  }
  p.lastTimer = setTimeout(() =>
    finishPending(h, { ok: false, error: p.lastErr || '拿不到回复内容（get_last_assistant_text 超时）' }, 502), 15000);
}

function onChatEvent(h, o) {
  if (o.type === 'response') {
    const p = h.pending;
    if (o.command === 'prompt' && p && o.success === false) {
      return finishPending(h, { ok: false, error: 'prompt 被拒绝: ' + clip(String(o.error || '?'), 300) }, 500);
    }
    if (o.command === 'get_last_assistant_text' && p && p.wantLast) {
      if (p.lastTimer) { clearTimeout(p.lastTimer); p.lastTimer = null; }
      const txt = (o.success && o.data && typeof o.data.text === 'string') ? o.data.text.trim() : '';
      return finishPending(h, txt ? { ok: true, reply: txt }
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
    p.lastErr = '流错误: ' + clip(String(o.assistantMessageEvent.reason || '?'), 200);
  } else if (o.type === 'auto_retry_start') {
    p.notes.push(`API 重试第 ${o.attempt || '?'} 次` + (o.errorMessage ? '：' + clip(String(o.errorMessage), 150) : ''));
  } else if (o.type === 'auto_retry_end' && o.success === false) {
    p.lastErr = '自动重试失败: ' + clip(String(o.finalError || '?'), 300);
  } else if (o.type === 'agent_end') {
    if (!o.willRetry && !p.settleTimer) {
      // 正常情况 agent_settled 紧随其后；5s 宽限防丢事件
      p.settleTimer = setTimeout(() => settleChat(h), 5000);
    }
  } else if (o.type === 'agent_settled') {
    if (p.settleTimer) { clearTimeout(p.settleTimer); p.settleTimer = null; }
    settleChat(h);
  }
}

function attachChatStdio(h) {
  let buf = '';
  h.child.stdout.on('data', d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let o = null;
      try { o = JSON.parse(line); } catch (e) { continue; }
      try { onChatEvent(h, o); } catch (e) { /* 单条事件异常不影响整体 */ }
    }
  });
  h.child.stderr.on('data', d => { h.stderrTail = (h.stderrTail + d.toString('utf8')).slice(-4000); });
  h.child.on('error', e => {
    h.dead = true;
    if (h.pending) finishPending(h, { ok: false, error: '聊天进程启动失败: ' + e.message }, 500);
    failQueue(h, '聊天进程启动失败');
  });
  h.child.on('exit', code => {
    h.dead = true;
    const tail = h.stderrTail ? '\nstderr 尾部: ' + h.stderrTail.slice(-800) : '';
    if (h.pending) finishPending(h, { ok: false, error: `聊天进程意外退出 (code=${code})${tail}` }, 500);
    failQueue(h, '聊天进程已退出');
  });
}

function ensureChatProcess(id) {
  let h = chatPool.get(id);
  if (h && h.child && !h.dead) return h;
  const dir = path.join(ORG_ROOT, 'agents', id);
  const sessDir = path.join(dir, 'chat-sessions');
  try { fs.mkdirSync(sessDir, { recursive: true }); } catch (e) {}
  h = { id, child: null, dead: false, spawnAt: Date.now(), pending: null, queue: [],
        lastActive: Date.now(), stderrTail: '' };
  const args = ['--mode', 'rpc', '--provider', CHAT_PROVIDER, '--model', CHAT_MODEL,
                '--thinking', CHAT_THINKING,
                '--session-dir', sessDir, '--name', id + '-chat'];
  h.child = spawn('cmd.exe', ['/c', PI_BIN, ...args],
                  { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  attachChatStdio(h);
  chatPool.set(id, h);
  return h;
}

function startChatTurn(h, message, res) {
  const p = {
    message, res, startedAt: Date.now(), lastText: '', lastErr: null, notes: [], wantLast: false,
    timer: setTimeout(() => finishPending(h, { ok: false, error: '回复超时（180s）', timeout: true }, 504),
                      CHAT_REPLY_TIMEOUT_MS)
  };
  h.pending = p;
  const send = () => {
    if (h.pending !== p) return;   // 已提前结束
    let ok = false;
    try {
      h.child.stdin.write(JSON.stringify({ type: 'prompt', message, id: 'c-' + Date.now(),
                                           streamingBehavior: 'steer' }) + '\n');
      ok = true;
    } catch (e) { /* 下方统一报错 */ }
    if (!ok) finishPending(h, { ok: false, error: '写入聊天进程 stdin 失败' }, 500);
  };
  const wait = CHAT_SPAWN_WAIT_MS - (Date.now() - h.spawnAt);
  if (wait > 0) setTimeout(send, wait); else send();
}

function chatSend(id, message, res) {
  const h = ensureChatProcess(id);
  if (h.pending || h.queue.length) {
    if (h.queue.length >= 5) return res({ ok: false, error: '对话队列已满，请稍后再试' }, 429);
    h.queue.push({ message, res });
    return;
  }
  startChatTurn(h, message, res);
}

function startChatSweep() {
  const t = setInterval(() => {
    for (const [id, h] of chatPool) {
      if (!h.pending && !h.queue.length && Date.now() - h.lastActive > CHAT_IDLE_CLOSE_MS) {
        killChatTree(h);
        chatPool.delete(id);
        console.log(`[chat] ${id} 空闲超过 ${CHAT_IDLE_CLOSE_MS / 60000} 分钟，已关闭子进程`);
      }
    }
  }, 60 * 1000);
  t.unref();
}
process.on('exit', () => { for (const h of chatPool.values()) killChatTree(h); });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8'
};

function sendJson(res, obj, code) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code || 200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendText(res, text, code, type) {
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(code || 200, {
    'content-type': type || 'text/plain; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  res.end(body);
}

/** token 鉴权：?token= / x-pi-token 头 / cookie */
function authOk(req, q, res) {
  if (!TOKEN) return true;
  const hdr = req.headers['x-pi-token'];
  const cookie = /(?:^|;\s*)pi_token=([^;]+)/.exec(req.headers.cookie || '');
  if (q.get('token') === TOKEN) {
    try { res.setHeader('set-cookie', `pi_token=${encodeURIComponent(TOKEN)}; Path=/; SameSite=Lax`); } catch (e) {}
    return true;
  }
  if (hdr === TOKEN) return true;
  if (cookie && decodeURIComponent(cookie[1]) === TOKEN) return true;
  return false;
}

/** 把 org 内相对路径安全解析成绝对路径 */
function safeOrgPath(p) {
  if (!p) return null;
  const abs = path.resolve(ORG_ROOT, String(p).replace(/^[/\\]+/, ''));
  const base = ORG_ROOT.endsWith(path.sep) ? ORG_ROOT : ORG_ROOT + path.sep;
  if (abs !== ORG_ROOT && !abs.startsWith(base)) return null;
  return abs;
}
/** 只暴露前端资源，后端源码（server.js / selftest.js）不对外 */
const STATIC_OK = /^\/(index\.html|app\.js|style\.css|favicon\.ico|vendor\/[\w.-]+)$/;

function handleChatPost(req, res, id) {
  let size = 0;
  const chunks = [];
  req.on('data', d => {
    size += d.length;
    if (size > CHAT_MAX_BODY) { req.destroy(); return; }
    chunks.push(d);
  });
  req.on('end', () => {
    if (size > CHAT_MAX_BODY) return;
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch (e) { return sendJson(res, { ok: false, error: 'body 不是 JSON' }, 400); }
    const msg = typeof body.message === 'string' ? body.message.trim() : '';
    if (!msg) return sendJson(res, { ok: false, error: '缺少 message' }, 400);
    if (msg.length > CHAT_MAX_MSG) return sendJson(res, { ok: false, error: 'message 过长（>8000 字符）' }, 400);
    if (!chatAgentOk(id)) return sendJson(res, { ok: false, error: '不可对话的智能体: ' + id }, 404);
    // v5.1：分身走常驻 daemon（命令行可关）；daemon 自己会写 user/assistant 到 history，这里不再重复写
    const viaDaemon = id === 'twin' && twinDaemonStatus().running;
    if (!viaDaemon) appendChatHistory(id, 'user', msg);
    if (viaDaemon) {
      twinDaemonRequest({ type: 'chat', message: msg }).then(r => {
        if (r && r.ok && typeof r.reply === 'string') {
          return sendJson(res, { ok: true, reply: r.reply, tookMs: r.tookMs, via: 'twin-daemon' });
        }
        sendJson(res, { ok: false, error: (r && r.error) || '分身无回复' }, (r && r.code) || 500);
      });
      return;
    }
    chatSend(id, msg, (obj, code) => sendJson(res, obj, code));
  });
  req.on('error', () => {});
}

/* ── 睡前模式（完成即关机守护） ────────────────────── */
/** 扫 inbox：未完成任务清单（同 shutdown-after-done.js 的判定） */
function shutdownPending() {
  let pending = [], done = 0, failed = 0;
  for (const f of listOf(INBOX)) {
    if (!f.endsWith('.md')) continue;
    const name = f.replace(/\.md$/, '');
    if (misjudgedArchived(name)) continue;   // 误杀归档任务不算待处理
    const mark = readIf(path.join(INBOX, name + '.DONE'));
    if (mark == null) pending.push(name);
    else if (mark.includes('.FAILED')) failed++;
    else done++;
  }
  return { pending, done, failed };
}

function shutdownStatus() {
  const pid = parseInt(readIf(GUARD_PID) || '', 10);
  const armed = !Number.isNaN(pid) && alive(pid);
  return { armed: armed, pid: armed ? pid : null, ...shutdownPending() };
}

/** arm：detached 启动守护进程；opts 可注入测试环境（selftest 用，避免误关真机） */
function shutdownArm(opts) {
  const st = shutdownStatus();
  if (st.armed) return { ok: true, armed: true, pid: st.pid, already: true, ...st };
  // 睡前模式统一标记：讨论照常、派发转计划文档（butler/twin 据此不 spawn 新任务）
  try { fs.writeFileSync(SLEEP_FLAG, new Date().toISOString() + '\n', 'utf8'); } catch (e) {}
  const env = { ...process.env };
  if (opts && opts.testInbox) env.XUWU_INBOX = opts.testInbox;
  if (opts && opts.testLogs)  env.XUWU_LOGS = opts.testLogs;
  if (opts && opts.testCmd)   env.XUWU_SHUTDOWN_CMD = opts.testCmd;
  if (opts && opts.graceMs)   env.XUWU_GRACE_MS = String(opts.graceMs);
  let child;
  try {
    child = spawn(process.execPath, [GUARD_SCRIPT], {
      detached: true, stdio: 'ignore', windowsHide: true, env, cwd: ORG_ROOT
    });
    child.unref();
  } catch (e) {
    return { ok: false, error: '启动守护失败: ' + e.message };
  }
  if (!child.pid) return { ok: false, error: '守护进程未获得 PID' };
  try { fs.writeFileSync(GUARD_PID, String(child.pid), 'utf8'); } catch (e) {}
  const s = shutdownPending();
  return { ok: true, armed: true, pid: child.pid, ...s };
}

function shutdownDisarm() {
  const pid = parseInt(readIf(GUARD_PID) || '', 10);
  try { fs.unlinkSync(GUARD_PID); } catch (e) {}
  try { fs.unlinkSync(SLEEP_FLAG); } catch (e) {}   // 解除睡前模式：移除派发转计划标记
  if (Number.isNaN(pid) || !alive(pid)) return { ok: true, armed: false, note: '守护本就不在运行' };
  try { process.kill(pid); } catch (e) {
    if (e.code !== 'EPERM') return { ok: false, error: '杀守护失败: ' + e.message };
  }
  return { ok: true, armed: false, killedPid: pid };
}

/** POST /api/shutdown/* 的 body 解析（可选，空 body 也行） */
function handleShutdownPost(req, res, action) {
  let size = 0;
  const chunks = [];
  req.on('data', d => { size += d.length; if (size > 8192) req.destroy(); chunks.push(d); });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch (e) { return sendJson(res, { ok: false, error: 'body 不是 JSON' }, 400); }
    if (action === 'arm') return sendJson(res, shutdownArm(body));
    if (action === 'disarm') return sendJson(res, shutdownDisarm());
    return sendJson(res, { ok: false, error: '未知动作' }, 404);
  });
  req.on('error', () => {});
}

/** POST /api/task/<name>/interject：向运行中任务的 agent 会话插嘴（2026-08-07）
 *  流程：查 butler 共享表（active-tasks.json）确认任务在跑且可插嘴
 *        → 原子写 inbox/interject/<name>.json → butler fs.watch 秒级捡起
 *        → sendRPC 送入 pi 子进程 stdin → 写 <name>.ack 回执 → 本接口等待 ack（≤5s）返回 */
function handleInterjectPost(req, res, taskName) {
  let size = 0;
  const chunks = [];
  req.on('data', d => { size += d.length; if (size > 8192) req.destroy(); chunks.push(d); });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch (e) { return sendJson(res, { ok: false, error: 'body 不是 JSON' }, 400); }
    const message = String(body.message || '').trim();
    if (!message) return sendJson(res, { ok: false, error: 'message 不能为空' }, 400);

    const table = readActiveTable();
    const info = table[taskName];
    if (!info) {
      const done = readIf(path.join(INBOX, taskName + '.DONE')) || readIf(path.join(INBOX, taskName + '.FAILED'));
      return sendJson(res, { ok: false, error: done
        ? `任务已结束: ${done.trim().slice(0, 60)}`
        : `任务不在运行（共享表无 ${taskName}，可能尚未派发或已收尾）` }, 404);
    }
    if (!info.interjectable) {
      return sendJson(res, { ok: false,
        error: `任务 [${taskName}] 由 ${info.agentId || '?'}（${info.channel || '非 pi RPC'}）执行，不支持插嘴（仅 pi RPC 会话可插嘴）` }, 409);
    }
    // 原子写请求文件（tmp + rename，防 butler watcher 读到半截）
    try { fs.mkdirSync(INTERJECT_DIR, { recursive: true }); } catch (e) {}
    const reqPath = path.join(INTERJECT_DIR, taskName + '.json');
    const tmpPath = reqPath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, JSON.stringify({ message, ts: new Date().toISOString() }), 'utf8');
      fs.renameSync(tmpPath, reqPath);
    } catch (e) {
      return sendJson(res, { ok: false, error: '写插嘴队列失败: ' + e.message }, 500);
    }
    // 等待 butler ack（≤5s）：确认消息已送入 agent 上下文再返回
    const ackPath = reqPath.replace(/\.json$/, '.ack');
    const deadline = Date.now() + 5000;
    const waitAck = () => {
      const ackRaw = readIf(ackPath);
      if (ackRaw) {
        let ack = {};
        try { ack = JSON.parse(ackRaw); } catch (e) {}
        if (ack.ok) return sendJson(res, { ok: true, delivered: true, ts: ack.ts, message: ack.message, agentId: info.agentId });
        return sendJson(res, { ok: false, error: `管家拒绝: ${ack.error || '未知原因'}` }, 502);
      }
      if (Date.now() > deadline) {
        return sendJson(res, { ok: true, delivered: 'pending',
          note: '已投递插嘴队列，管家尚未回执（fs.watch 延迟或 butler 繁忙，稍后可在日志确认）' });
      }
      setTimeout(waitAck, 150);
    };
    waitAck();
  });
  req.on('error', () => {});
}

function serveStatic(req, res, pathname) {
  let f = pathname === '/' ? '/index.html' : pathname;
  try { f = decodeURIComponent(f); } catch (e) { return sendText(res, 'Bad Request', 400); }
  f = f.replace(/\?.*$/, '');
  if (!STATIC_OK.test(f)) return sendText(res, 'Not Found: ' + f, 404);
  const abs = path.resolve(WEB_DIR, '.' + f);
  const base = WEB_DIR.endsWith(path.sep) ? WEB_DIR : WEB_DIR + path.sep;
  if (!abs.startsWith(base)) return sendText(res, '403', 403);
  const st = statOf(abs);
  if (!st || !st.isFile()) return sendText(res, 'Not Found: ' + f, 404);
  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-cache' });
  fs.createReadStream(abs).pipe(res);
}

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch (e) { return sendText(res, 'Bad Request', 400); }
  const p = u.pathname;
  const q = u.searchParams;

  if (req.method === 'POST') {
    // 集群握手：两阶段，识别阶段（无 token）不强制鉴权
    if (p === '/api/cluster/handshake') return clusterHandshake(req, res, q);
    if (!authOk(req, q, res)) return sendJson(res, { ok: false, error: '需要 token' }, 401);
    // 集群对话：优先独立 CLUSTER_TOKEN（HK 转发明文对话，单独令牌防刷+可回收）
    if (p === '/api/cluster/chat' || p === '/v1/chat/completions') {
      const bear = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
      const bearerTok = bear ? bear[1].trim() : '';
      const okTok = !CLUSTER_TOKEN || req.headers['x-pi-token'] === CLUSTER_TOKEN || (CLUSTER_TOKEN && bearerTok === CLUSTER_TOKEN);
      if (CLUSTER_TOKEN && !okTok) {
        return sendJson(res, { ok: false, error: '集群对话需要独立的 x-pi-token / Bearer token' }, 401);
      }
      return p === '/api/cluster/chat' ? handleClusterChatPost(req, res) : handleClusterOpenAICompat(req, res);
    }
    const sm = p.match(/^\/api\/shutdown\/(arm|disarm)$/);
    if (sm) return handleShutdownPost(req, res, sm[1]);
    const im = p.match(/^\/api\/task\/([\w.-]+)\/interject$/);
    if (im) return handleInterjectPost(req, res, im[1]);
    const cm = p.match(/^\/api\/chat\/([\w-]+)$/);
    if (!cm) return sendJson(res, { ok: false, error: 'POST 仅支持 /api/chat/<id>、/api/task/<name>/interject 与 /api/shutdown/arm|disarm' }, 404);
    return handleChatPost(req, res, cm[1]);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 'Method Not Allowed', 405);

  // 集群握手：两阶段，识别阶段（无 token）不强制鉴权
  if (p === '/api/cluster/handshake') return clusterHandshake(req, res, q);

  if (!authOk(req, q, res)) {
    if (p.startsWith('/api/')) return sendJson(res, { ok: false, error: '需要 token' }, 401);
    return sendText(res, '<h3>需要 token</h3><p>请访问 <code>/?token=你的token</code></p>', 401,
                    'text/html; charset=utf-8');
  }

  try {
    if (p === '/api/state') {
      return sendJson(res, { ok: true, ...snapshot() });
    }
    if (p === '/api/cluster/health') {
      return sendJson(res, clusterHealth());
    }
    if (p === '/api/cluster/docs') {
      return sendJson(res, clusterDocs());
    }
    if (p === '/api/cluster/docs/content') {
      return handleClusterDocContent(req, res, q.get('path'));
    }
    if (p === '/api/remote/state') {
      return fetchRemoteState(q.get('force') === '1').then(d => sendJson(res, d));
    }
    if (p === '/api/agent') {
      const d = agentDetail(q.get('id'), q.get('task'), parseInt(q.get('events') || '0', 10) || 0, q.get('full') === '1');
      return sendJson(res, d.ok === false ? d : { ok: true, ...d }, d.ok === false ? 404 : 200);
    }
    if (p === '/api/summary') {
      if (q.get('real') === '1') {
        return realSummary((err, out) => sendJson(res, err
          ? { ok: false, error: err.message }
          : { ok: true, ...out, source: 'butler --summary' }));
      }
      const s = snapshot();
      return sendJson(res, { ok: true, ...s.summary, source: 'computed' });
    }
    if (p === '/api/butlerlog') {
      const n = Math.min(2000, Math.max(10, parseInt(q.get('lines') || '200', 10) || 200));
      const t = tailBytes(BUTLER_LOG, 256 * 1024);
      const lines = t.text.split(/\r?\n/).filter(Boolean);
      return sendJson(res, { ok: true, file: rel(BUTLER_LOG), mtime: t.mtime, size: t.size,
                             text: lines.slice(-n).join('\n') });
    }
    if (p === '/api/file') {
      const abs = safeOrgPath(q.get('p'));
      if (!abs) return sendJson(res, { ok: false, error: '路径不合法' }, 400);
      const st = statOf(abs);
      if (!st || !st.isFile()) return sendJson(res, { ok: false, error: '文件不存在' }, 404);
      const t = tailBytes(abs, TAIL_BYTES);
      return sendJson(res, { ok: true, path: rel(abs), size: st.size, mtime: st.mtimeMs,
                             truncated: t.truncated, text: t.text });
    }
    if (p === '/api/meetings') {
      // 圆桌会议纪要列表（knowledge/meetings/*.md）：标题/时间/参会/状态 摘要
      const dir = path.join(ORG_ROOT, 'knowledge', 'meetings');
      const list = [];
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.md')) continue;
          const abs = path.join(dir, f);
          const st = statOf(abs);
          const txt = fs.readFileSync(abs, 'utf8').slice(0, 2000);
          const first = (txt.match(/^#\s*(.+)$/m) || [])[1] || f.replace(/\.md$/, '');
          const m = txt.match(/^[*-]\s*(?:时间|Time)\s*:\s*(.+)$/m);
          const par = txt.match(/^[*-]\s*(?:参会|Participants)\s*:\s*(.+)$/m);
          const sta = txt.match(/^[*-]\s*状态\s*:\s*(.+)$/m);
          list.push({ name: f.replace(/\.md$/, ''), title: first, time: m ? m[1].trim() : '',
                      participants: par ? par[1].trim() : '', status: sta ? sta[1].trim() : '',
                      mtime: st ? st.mtimeMs : 0 });
        }
      } catch (e) { /* 目录不存在 */ }
      list.sort((a, b) => b.mtime - a.mtime);
      return sendJson(res, { ok: true, meetings: list });
    }
    if (p === '/api/shutdown/status') {
      return sendJson(res, { ok: true, ...shutdownStatus() });
    }
    if (p === '/api/chat/agents') {
      return sendJson(res, { ok: true, agents: chatAgentsList(),
                             running: [...chatPool].filter(([, h]) => !h.dead).map(([id]) => id),
                             config: { provider: CHAT_PROVIDER, model: CHAT_MODEL, thinking: CHAT_THINKING } });
    }
    if (p === '/api/twin/status') {
      const st = twinDaemonStatus();
      const act = readActivity(parseInt(q.get('lines') || '5', 10) || 5);
      const route = getTwinRoute();
      return sendJson(res, { ok: true, ...st, route,
                             lastActivity: act.lines[act.lines.length - 1] || null });
    }
    if (p === '/api/twin/activity') {
      const n = Math.min(1000, Math.max(5, parseInt(q.get('lines') || '200', 10) || 200));
      const a = readActivity(n, 512 * 1024);
      return sendJson(res, { ok: true, file: rel(TWIN_ACTIVITY), size: a.size, mtime: a.mtime,
                             text: a.text, lines: a.lines });
    }
    if (p === '/api/trace') {
      return sendJson(res, taskTrace(q.get('task')));
    }
    const hm = p.match(/^\/api\/chat\/([\w-]+)\/history$/);
    if (hm) {
      if (!chatAgentOk(hm[1])) return sendJson(res, { ok: false, error: '不可对话的智能体: ' + hm[1] }, 404);
      return sendJson(res, { ok: true, id: hm[1], messages: readChatHistory(hm[1], 500) });
    }
    const mm = p.match(/^\/api\/memory\/([\w-]+)$/);
    if (mm) {
      const id = mm[1];
      const memDir = path.join(ORG_ROOT, 'agents', id, 'memory');
      if (!statOf(memDir) || !statOf(memDir).isDirectory()) {
        return sendJson(res, { ok: false, error: '智能体无记忆目录: ' + id }, 404);
      }
      const kw = (q.get('q') || '').trim().toLowerCase();
      const days = Math.min(30, Math.max(1, parseInt(q.get('days') || '7', 10) || 7));
      const entities = orgMemory.listEntities(id);
      let idx = null;
      try { idx = JSON.parse(readIf(path.join(memDir, 'index.json')) || 'null'); } catch (e) {}
      return sendJson(res, {
        ok: true, agentId: id,
        timeline: orgMemory.timeline(id, days),
        search: kw ? orgMemory.searchIndex(id, kw) : orgMemory.searchIndex(id),
        entities,
        index: idx && { updatedAt: idx.updatedAt, count: idx.count }
      });
    }
    if (p.startsWith('/api/')) return sendJson(res, { ok: false, error: '未知接口 ' + p }, 404);
    return serveStatic(req, res, p);
  } catch (e) {
    return sendJson(res, { ok: false, error: e.message, stack: String(e.stack || '').split('\n').slice(0, 4) }, 500);
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const port = server.address().port;   // --port 0 时由系统分配
    const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
    const qs = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '';
    console.log(`v5 组织总览已启动: http://${shown}:${port}/${qs}`);
    console.log(`数据根目录: ${ORG_ROOT}`);
    if (HOST === '0.0.0.0') {
      const nets = require('os').networkInterfaces();
      for (const list of Object.values(nets)) {
        for (const n of (list || [])) {
          if (n.family === 'IPv4' && !n.internal) console.log(`局域网(手机)可访问: http://${n.address}:${port}/${qs}`);
        }
      }
      if (!TOKEN) console.log('⚠ 监听 0.0.0.0 且未设置 --token：同网段任何设备都能读取 org 目录内容，请仅在可信网络使用。');
    }
    startChatSweep();
  });

  server.on('error', e => {
    if (e.code === 'EADDRINUSE') console.error(`端口 ${PORT} 已被占用，换一个：node server.js --port ${PORT + 1}`);
    else console.error('服务启动失败:', e.message);
    process.exit(1);
  });
}

// 供 selftest 单元测调用
module.exports = { parseLogTail, normalizeEvent, tailBytes, chatAgentsList, readChatHistory, ORG_ROOT };
