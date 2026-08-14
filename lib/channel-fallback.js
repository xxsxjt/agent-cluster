'use strict';
/**
 * lib/channel-fallback.js — 模型渠道自动 fallback（多渠道连续失败自动切换，2026-08-08）
 *
 * 链（用户 2026-08-08 定，主模型 deepseek-v4-flash）：
 *   1. opencode-go 订阅池（优先）
 *   2. aliyun-tokenplan 0731 版（deepseek-v4-flash-0731）
 *   3. 商汤 xxsx（deepseek-v4-flash）
 *   4. deepseek 官方（deepseek / deepseek-v4-flash）
 *
 * 规则：
 *   - 默认任务（任务头无显式 provider）按此链 fallback；
 *   - 显式 provider 的任务尊重显式渠道（不走链，由调用方决定）；
 *   - 渠道连续失败 RETRY_THRESHOLD 次（默认 2，403/5xx/连接错）后进入冷却窗口 COOL_DOWN_MS，
 *     pickProvider() 跳过冷却渠道 → 自然切到链上下一个健康渠道；
 *   - 链上全部失败/冷却 → recordOutage() 写 logs/channel-outage.json + activity.log [告警]，
 *     并触发预留通知钩子（setNotifier，管理端软件待用户确认后接入）。
 *
 * 健康状态持久化：logs/channel-health.json
 *   { "<provider>": { fails, lastFailAt, lastError, coolingUntil } }
 */
const fs = require('fs');
const path = require('path');

const ORG_ROOT  = path.join(__dirname, '..');
const LOGS      = path.join(ORG_ROOT, 'logs');
const HEALTH_FILE = path.join(LOGS, 'channel-health.json');
const OUTAGE_FILE = path.join(LOGS, 'channel-outage.json');
const ACTIVITY_LOG = path.join(LOGS, 'activity.log');

const RETRY_THRESHOLD = 2;        // 连续失败 N 次确认渠道暂时不可用，才切换
const COOL_DOWN_MS    = 10 * 60 * 1000; // N 次失败后冷却 10 分钟，不再作为起始渠道
const PROBE_INTERVAL_MS = 30 * 60 * 1000; // 冷却渠道每 30 分钟轻量探测一次（恢复检测，2026-08-08）

/* 渠道额度类失败（403/402/insufficient balance/quota exceeded）→ 通知用户（重置卡机制，2026-08-11）：
 * 用户有渠道额度重置卡，额度用尽不是普通网络错——必须明说可重置，不能默默 fallback/等用户发现。
 * 节流：同一渠道 30 分钟内只通知一次，避免刷屏。 */
const QUOTA_NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;
const QUOTA_NOTIFY_STATE = path.join(LOGS, 'channel-quota-notify.json');

/* 渠道空回复失败标记语义（2026-08-09）：opencode-go 曾 200 但 content 空/0 token 却未触发 fallback，
 * 任务要求把空回复（无产出）也视为渠道失效 → 自动切下一渠道。该常量即任务日志标记的文本。 */
const EMPTY_REPLY_REASON = '渠道空回复（content 空/0 token）';

/* 渠道限额确认阈值（2026-08-11 load-quota-fix 用户批评："opencode 没这么容易限额，
 * 不要这么随便下限额结论，多给几次重试，偶尔不稳定吧可能"）：
 * 单次 403/失败 ≠ 限额——需【连续 N 次额度类失败 且 落在 QUOTA_CONFIRM_WINDOW_MS 窗口内】
 * 才认定"疑似限额"并通知用户（重置卡）。期间按不稳定重试（自动重试，不打扰）。 */
const QUOTA_CONFIRM_THRESHOLD = 5;             // 连续 5 次额度类失败才确认限额
const QUOTA_CONFIRM_WINDOW_MS  = 10 * 60 * 1000; // 窗口：5 次须在 10 分钟内累积（跨窗口清零）

/* 渠道端点/密钥从 pi models.json 运行时读取，不硬编码 key（OPSEC）
 * 2026-08-11 mgmt-pm improve：跨平台路径——本机 Windows 用 USERPROFILE，
 * HK/CNB Linux 用 HOME（org-runner home=/data/agent-cluster），消除 Windows 硬编码
 * 导致 HK 读不到 opencode-go key 的缺口（HK 侧 opencode-go 须单独配 key）。 */
function piHome() {
  if (process.env.USERPROFILE) return process.env.USERPROFILE;
  if (process.env.HOME) return process.env.HOME;
  return process.platform === 'win32' ? 'C:/Users/du_ji' : '/data/agent-cluster';
}
function resolveProviderEndpoint(provider) {
  try {
    const mm = JSON.parse(fs.readFileSync(path.join(piHome(), '.pi/agent/models.json'), 'utf8'));
    const p = mm && mm.providers && mm.providers[provider];
    if (!p) return null;
    const base = String(p.baseUrl || '').replace(/\/$/, '');
    if (!base) return null;
    return { baseUrl: base, apiKey: p.apiKey || '' };
  } catch (e) { return null; }
}

/** 轻量 HTTP 探测（GET，带超时，不抛异常） */
function httpReq(method, urlStr, headers, body, timeoutMs) {
  return new Promise(resolve => {
    let u; try { u = new URL(urlStr); } catch (e) { return resolve({ ok: false, error: 'bad url' }); }
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request({
      method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, headers, timeout: timeoutMs || 12000
    }, res => {
      let buf = '';
      res.on('data', d => { buf += d; if (buf.length > 200000) req.destroy(); });
      res.on('end', () => resolve({ ok: res.statusCode < 400, code: res.statusCode, body: buf.slice(0, 1200) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ ok: false, error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

/** 探测单个渠道可用性：GET {baseUrl}/models（OpenAI 兼容端点统一带 /v1，models 需再拼） */
async function probeChannel(provider) {
  const ep = resolveProviderEndpoint(provider);
  if (!ep) return { ok: false, error: 'no endpoint config for ' + provider };
  const url = ep.baseUrl + '/models';
  const h = { accept: 'application/json' };
  if (ep.apiKey) h.authorization = 'Bearer ' + ep.apiKey;
  const r = await httpReq('GET', url, h, null, 12000);
  return { ok: r.ok, code: r.code, error: r.error || '', body: (r.body || '').slice(0, 120) };
}

/**
 * 检测日志窗口（pi rpc jsonl）中是否有「渠道空回复」——message_end 里 assistant content 为空
 * （无 text 文本 / 无 toolCall 动作块）+ usage.totalTokens≈0。
 * 无论是否带 errorMessage（200 静默空回 / 400 错误空回）都视为渠道失效（无可用产出）。
 * @param {string} logPath 任务日志路径（pi rpc 逐行 JSON）
 * @param {number} [offset] 只检测该字节偏移之后新增的日志（本轮派发后），默认从头扫
 * @returns {{empty:boolean, provider?:string, reason?:string}}
 */
function detectEmptyReply(logPath, offset) {
  try {
    const st = fs.statSync(logPath);
    const start = (typeof offset === 'number' && offset >= 0) ? Math.min(offset, st.size) : 0;
    const len = st.size - start;
    if (len <= 0) return { empty: false };
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (const line of lines) {
      if (line.indexOf('"message_end"') === -1) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (e) { continue; }
      if (!ev || ev.type !== 'message_end') continue;
      const msg = ev.message || {};
      const content = msg.content;
      const usage = msg.usage || {};
      const total = usage.totalTokens || 0;
      // 有可用产出 = 有非空 text 或 toolCall 块（thinking 块不算产出）
      const hasUsable = Array.isArray(content) && content.some(c => {
        if (!c || typeof c !== 'object') return false;
        if (c.type === 'text' && String(c.text || '').trim()) return true;
        if (c.type === 'toolCall' && (c.id || c.name)) return true;
        return false;
      });
      if (!hasUsable && total <= 5) {
        return { empty: true, provider: msg.provider || '', reason: EMPTY_REPLY_REASON };
      }
    }
    return { empty: false };
  } catch (e) {
    return { empty: false };
  }
}

/**
 * 是否额度类错误（403/402/insufficient balance/quota exceeded/余额不足/额度用尽 等）。
 * 额度类失败区别于普通网络错误——用户有重置卡，可重置，需通知用户（不静默）。
 * @param {string} text 错误文本（渠道失败 lastError / 日志片段）
 * @returns {boolean}
 */
function isQuotaError(text) {
  if (!text) return false;
  const t = String(text);
  return /\b403\b|\b402\b|quota|insufficient|balance|余额|额度|limit\s*(reached|exceeded)|out\s*of\s*(credit|quota|balance)|billing|payment\s*required|insufficient_quota/i.test(t);
}

/**
 * 扫描任务日志新增片段，检测渠道额度类错误（403/402/quota/insufficient/余额/额度 关键词）。
 * @param {string} logPath 任务日志路径（pi rpc 逐行 JSON / 文本）
 * @param {number} [offset] 只检测该字节偏移之后新增的日志，默认从头扫
 * @returns {{found:boolean, text?:string}}
 */
function detectQuotaError(logPath, offset) {
  try {
    const st = fs.statSync(logPath);
    const start = (typeof offset === 'number' && offset >= 0) ? Math.min(offset, st.size) : 0;
    const len = st.size - start;
    if (len <= 0) return { found: false };
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const hits = [];
    // 优先匹配明确的额度短语；再兜底 403/402 状态码
    const re = /(insufficient[^\n]{0,50}|quota[^\n]{0,50}|余额[^\n]{0,20}|额度[^\n]{0,20}|out\s*of\s*(?:credit|quota|balance)[^\n]{0,20}|(?:403|402)[^\n]{0,60})/gi;
    let m;
    while ((m = re.exec(text)) && hits.length < 5) {
      const s = m[0].trim();
      if (s && hits.indexOf(s) === -1) hits.push(s.slice(0, 120));
    }
    return hits.length ? { found: true, text: hits.slice(0, 3).join(' | ').slice(0, 300) } : { found: false };
  } catch (e) { return { found: false }; }
}

/** 追加渠道活动记录（agents/twin/activity.log，与分身日志同源） */
function logActivity(action, detail, tag) {
  try {
    const twinLog = path.join(ORG_ROOT, 'agents', 'twin', 'activity.log');
    fs.mkdirSync(path.dirname(twinLog), { recursive: true });
    const d = new Date(); const p = n => (n < 10 ? '0' + n : '' + n);
    const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    fs.appendFileSync(twinLog, `[${ts}] [${tag || '渠道'}] ${action}${detail ? ' — ' + detail : ''}\n`, 'utf8');
  } catch (e) {}
}

/** 标记渠道恢复：清零失败 + 解除冷却 + status=recovered + recoveredAt */
function markRecovered(provider) {
  const h = readHealth();
  const rec = hGet(h, provider);
  rec.fails = 0; rec.lastFailAt = null; rec.coolingUntil = 0; rec.lastError = '';
  rec.status = 'recovered'; rec.recoveredAt = new Date().toISOString();
  rec.probeOk = true; rec.probedAt = Date.now();   // 2026-08-11：恢复探测成功 → probeOk 同步 true
  h[provider] = rec;
  writeHealth(h);
  return { ...rec };
}

/**
 * 恢复探测：扫描冷却/失败过的渠道，对到期（≥30 分钟）的做轻量探测。
 *   成功 → markRecovered（路由自动切回高优先级，pickProvider 返回第一个健康渠道）
 *   失败 → 延长冷却（coolingUntil = now + COOL_DOWN_MS）
 * @param {number} [forceInterval] 测试用：覆盖探测间隔（0=立即探测全部）
 * @returns {Promise<Array>} 探测结果数组
 */
async function probeCoolingChannels(forceInterval) {
  const health = readHealth();
  const interval = typeof forceInterval === 'number' ? forceInterval : PROBE_INTERVAL_MS;
  const results = [];
  const now = Date.now();
  const providers = Object.keys(health);
  for (const provider of providers) {
    const rec = health[provider];
    // 只探测失败/冷却过的渠道；健康渠道不探测
    if (!rec || !(rec.fails > 0)) continue;
    const lastProbe = rec.probedAt || 0;
    if (now - lastProbe < interval) continue;   // 未到探测间隔
    const r = await probeChannel(provider);
    if (r.ok) {
      const wasCooling = isCooling(rec);
      markRecovered(provider);
      logActivity(`[渠道恢复] ${provider} 恢复可用，已切回高优先级`,
        `探测 /models → ${r.code} OK${wasCooling ? '（原冷却中）' : ''}`, '渠道');
      results.push({ provider, recovered: true, code: r.code, wasCooling });
    } else {
      rec.probedAt = now; rec.probeOk = false;
      rec.lastFailAt = new Date().toISOString();
      rec.lastError = String(r.error || r.code || 'probe fail').slice(0, 200);
      rec.coolingUntil = now + COOL_DOWN_MS;    // 失败 → 延长冷却
      // 2026-08-11 修复：探测失败必置冷却态（不能残留 recovered/healthy 却 probeOk=false）
      rec.status = 'cooling';
      health[provider] = rec;
      writeHealth(health);
      logActivity(`[渠道探测] ${provider} 仍未恢复`,
        `探测失败 ${r.code || r.error}，继续冷却至 ${new Date(rec.coolingUntil).toISOString()}`, '渠道');
      results.push({ provider, recovered: false, code: r.code, error: r.error });
    }
  }
  return results;
}

const FALLBACK_CHAIN = [
  { provider: 'opencode-go',      model: 'deepseek-v4-flash',       thinking: 'off', label: 'opencode-go 订阅池' },
  { provider: 'aliyun-tokenplan', model: 'deepseek-v4-flash-0731',  thinking: 'off', label: 'aliyun 0731' },
  { provider: 'xxsx',             model: 'deepseek-v4-flash',       thinking: 'off', label: '商汤(xxsx)' },
  { provider: 'deepseek',         model: 'deepseek-v4-flash',       thinking: 'off', label: 'deepseek 官方' }
];

function readHealth() {
  try { return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')) || {}; }
  catch (e) { return {}; }
}
function writeHealth(h) {
  try { fs.mkdirSync(LOGS, { recursive: true }); fs.writeFileSync(HEALTH_FILE, JSON.stringify(h, null, 2), 'utf8'); }
  catch (e) {}
}
function hGet(health, provider) {
  return health[provider] || { fails: 0, lastFailAt: null, coolingUntil: 0, lastError: '' };
}
function isCooling(h) {
  return !!(h && h.fails >= RETRY_THRESHOLD && Date.now() < (h.coolingUntil || 0));
}

/**
 * 选择当前渠道：返回链上第一个健康（未冷却）渠道。
 * 全冷却 → 返回链上第一个（外部调用方据此判断是否 recordOutage）。
 * @param {Array<{provider,model,thinking}>} [chain] 默认 FALLBACK_CHAIN
 */
function pickProvider(chain) {
  const list = chain || FALLBACK_CHAIN;
  const health = readHealth();
  for (const c of list) {
    if (!isCooling(hGet(health, c.provider))) return { ...c };
  }
  return { ...list[0] }; // 全冷却 → 兜底第一个
}

/* ── 额度类通知节流（重置卡机制，2026-08-11） ──────────── */
function readQuotaNotify() { try { return JSON.parse(fs.readFileSync(QUOTA_NOTIFY_STATE, 'utf8')) || {}; } catch (e) { return {}; } }
function writeQuotaNotify(s) { try { fs.mkdirSync(LOGS, { recursive: true }); fs.writeFileSync(QUOTA_NOTIFY_STATE, JSON.stringify(s, null, 2), 'utf8'); } catch (e) {} }
/** 该渠道是否已过 30 分钟节流窗口（可再次通知用户重置卡）。 */
function shouldNotifyQuota(provider) {
  const s = readQuotaNotify();
  const last = s[provider] || 0;
  return Date.now() - last >= QUOTA_NOTIFY_COOLDOWN_MS;
}
/** 记录该渠道已通知（防刷屏：同一渠道 30 分钟一次）。 */
function markQuotaNotified(provider) {
  const s = readQuotaNotify(); s[provider] = Date.now(); writeQuotaNotify(s);
}

/** 记录渠道失败：fails+1，达阈值设冷却。返回更新后的记录。
 * 额度类失败额外计 quotaFails（2026-08-11 不轻易判限额）：
 *   - 额度类失败（403/402/quota/insufficient/余额/额度）→ quotaFails+1（窗口内累计）
 *   - 非额度失败 → 不动 quotaFails（不误增也不清，保留已累计的额度怀疑）
 *   - markSuccess（渠道成功）→ 清零 quotaFails（恢复即不限额）
 * 单次 403 ≠ 限额，需连续 QUOTA_CONFIRM_THRESHOLD 次才确认（见 isQuotaConfirmed）。 */
function markFailure(provider, error) {
  const h = readHealth();
  const rec = hGet(h, provider);
  rec.fails = (rec.fails || 0) + 1;
  rec.lastFailAt = new Date().toISOString();
  rec.lastError = String(error || '').slice(0, 200);
  const isQ = isQuotaError(error);
  const now = Date.now();
  if (isQ) {
    // 窗口内连续累计；跨窗口（距上次超过 QUOTA_CONFIRM_WINDOW_MS）则重置为 1
    const prev = rec.quotaFailAt || 0;
    rec.quotaFails = (now - prev <= QUOTA_CONFIRM_WINDOW_MS) ? (rec.quotaFails || 0) + 1 : 1;
    rec.quotaFailAt = now;
  }
  if (rec.fails >= RETRY_THRESHOLD) {
    rec.coolingUntil = now + COOL_DOWN_MS;
    rec.status = 'cooling';
  } else {
    // 2026-08-11 修复：失败即置 failing 态，不残留 recovered（status 与 probeOk 同步）
    rec.status = 'failing';
  }
  rec.probeOk = false;   // 失败 → probeOk 同步置 false（不允许 status=healthy 但 probeOk=false）
  h[provider] = rec;
  writeHealth(h);
  return { ...rec };
}

/** 记录渠道成功：清零失败计数 + 解除冷却 + 清零额度怀疑（恢复即不限额）。 */
function markSuccess(provider) {
  const h = readHealth();
  const rec = hGet(h, provider);
  if (rec.fails > 0 || rec.coolingUntil || rec.quotaFails > 0) {
    rec.fails = 0; rec.lastFailAt = null; rec.coolingUntil = 0; rec.lastError = '';
    rec.quotaFails = 0; rec.quotaFailAt = 0;   // 渠道恢复 → 额度怀疑清零
    rec.probeOk = true;                        // 2026-08-11：成功 → probeOk 同步 true（一致性）
    rec.status = 'recovered';                  // 2026-08-11 修复：成功即复位健康态，不残留 failing/cooling（status 与 probeOk 双向同步）
    rec.recoveredAt = new Date().toISOString();
    h[provider] = rec;
    writeHealth(h);
  }
}

/**
 * 一致性修复/复核：扫描整张健康表，强制 status 与 probeOk 同步。
 *   规则：失败态（fails>0 或冷却中）→ status=failing|cooling + probeOk=false；
 *         干净态（fails==0 且未冷却）→ status=recovered + probeOk=true。
 * 用于：巡检/启动时兜底修复历史脏数据（老代码曾写 fails>0 但 status 残留 recovered）。
 * @returns {{providers:number, repaired:number}} 扫描渠道数 + 修复数
 */
function reconcileHealth() {
  const h = readHealth();
  let repaired = 0;
  const now = Date.now();
  for (const p of Object.keys(h)) {
    const rec = h[p];
    if (!rec) continue;
    const failed = (rec.fails || 0) > 0 || (rec.coolingUntil || 0) > now;
    const wantOk = !failed;
    let dirty = false;
    if (failed) {
      if (rec.probeOk !== false) { rec.probeOk = false; dirty = true; }
      const wantStatus = (rec.fails || 0) >= RETRY_THRESHOLD || ((rec.coolingUntil || 0) > now)
        ? 'cooling' : 'failing';
      if (rec.status !== wantStatus) { rec.status = wantStatus; dirty = true; }
    } else {
      if (rec.probeOk !== true) { rec.probeOk = true; dirty = true; }
      if (rec.status !== 'recovered') { rec.status = 'recovered'; dirty = true; }
    }
    if (dirty) { repaired++; h[p] = rec; }
  }
  if (repaired) writeHealth(h);
  return { providers: Object.keys(h).length, repaired };
}

/** 是否已确认"疑似限额"（2026-08-11）：连续 quotaFails >= QUOTA_CONFIRM_THRESHOLD 次 且 在窗口内。 */
function isQuotaConfirmed(provider) {
  const rec = hGet(readHealth(), provider);
  if (!rec || !(rec.quotaFails > 0)) return false;
  if (Date.now() - (rec.quotaFailAt || 0) > QUOTA_CONFIRM_WINDOW_MS) return false;  // 跨窗口 → 不确认
  return rec.quotaFails >= QUOTA_CONFIRM_THRESHOLD;
}

/* ── 预留通知钩子（管理端软件待用户确认后接入） ─────────── */
const notifier = { notify: null };
/** 注册全挂通知回调（如接入管理端软件 webhook/命令）。 */
function setNotifier(fn) { notifier.notify = fn; }

/**
 * 全挂：写 logs/channel-outage.json（追加事件行）+ activity.log [告警] + 触发预留通知钩子。
 * 限额判定（2026-08-11 不轻易判限额）：全挂后不立即通知用户限额——
 *   只对【已确认限额】（quotaFails >= QUOTA_CONFIRM_THRESHOLD，连续 5 次）的渠道触发"疑似限额"通知（重置卡）；
 *   其余渠道（额度类失败但次数不足 / 纯网络错）归为"不稳定"，不打扰用户（已自动重试多次）。
 * @returns {object} 事件对象（含 quota.confirmed / quota.unstable / quota.needNotify）
 */
function recordOutage(task, chain, attempts) {
  const health = readHealth();
  // 全链渠道失败状态汇总：额度类失败计数、是否已确认限额
  const channels = (chain || FALLBACK_CHAIN).map(c => {
    const rec = hGet(health, c.provider);
    const err = rec.lastError || '';
    return {
      provider: c.provider, label: c.label, error: err,
      fails: rec.fails || 0, quotaFails: rec.quotaFails || 0,
      quotaHit: isQuotaError(err),                 // 最近失败是否额度类
      quotaConfirmed: isQuotaConfirmed(c.provider), // 连续 N 次已确认限额
    };
  });
  const quotaConfirmed = channels.filter(c => c.quotaConfirmed);
  const quotaUnstable  = channels.filter(c => c.quotaHit && !c.quotaConfirmed);
  // 仅已确认限额的渠道需要通知（30min 节流内跳过）
  const quotaNeedNotify = quotaConfirmed.filter(c => shouldNotifyQuota(c.provider));
  const ev = {
    ts: new Date().toISOString(),
    type: 'channel-outage',
    task: task && task.name || null,
    chain: (chain || FALLBACK_CHAIN).map(c => c.provider),
    attempts: attempts || 0,
    allChannelsFailed: true,
    health,
    quota: {
      channels: channels.filter(c => c.quotaHit).map(c => c.provider),
      confirmed: quotaConfirmed.map(c => c.provider),
      unstable: quotaUnstable.map(c => c.provider),
      needNotify: quotaNeedNotify.length > 0,
      threshold: QUOTA_CONFIRM_THRESHOLD,
      detail: quotaConfirmed,          // 通知只针对已确认限额的渠道（含 quotaFails）
    }
  };
  try { fs.mkdirSync(LOGS, { recursive: true }); fs.appendFileSync(OUTAGE_FILE, JSON.stringify(ev) + '\n', 'utf8'); } catch (e) {}
  try {
    fs.appendFileSync(ACTIVITY_LOG,
      `[${new Date().toISOString()}] [告警] 任务 ${task && task.name || '?'} 全部渠道不可用（${(chain || FALLBACK_CHAIN).map(c => c.provider).join(' → ')}）` +
      (quotaConfirmed.length
        ? `，已确认限额渠道：${quotaConfirmed.map(c => c.provider).join('、')}（连续${QUOTA_CONFIRM_THRESHOLD}次，已触发通知）`
        : `，均未确认限额（按不稳定处理，未打扰用户）`) + '\n',
      'utf8');
  } catch (e) {}
  if (notifier.notify) { try { notifier.notify(ev); } catch (e) {} }
  return ev;
}

module.exports = {
  FALLBACK_CHAIN, RETRY_THRESHOLD, COOL_DOWN_MS, PROBE_INTERVAL_MS, EMPTY_REPLY_REASON,
  QUOTA_NOTIFY_COOLDOWN_MS, QUOTA_NOTIFY_STATE, QUOTA_CONFIRM_THRESHOLD, QUOTA_CONFIRM_WINDOW_MS,
  HEALTH_FILE, OUTAGE_FILE,
  pickProvider, markFailure, markSuccess, recordOutage, setNotifier,
  readHealth, writeHealth, isCooling, isQuotaConfirmed,
  probeChannel, probeCoolingChannels, markRecovered, resolveProviderEndpoint,
  detectEmptyReply, isQuotaError, detectQuotaError, shouldNotifyQuota, markQuotaNotified,
  reconcileHealth
};
