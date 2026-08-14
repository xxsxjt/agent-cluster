#!/usr/bin/env node
/**
 * lib/agent-rescue.js — 智能体互救引擎（2026-08-12 agent-rescue-core 落地）
 *
 * 背景（用户 2026-08-12 核心理念）：
 *   "一个进程出 bug 卡死很正常，需要另一个智能体去帮它，那不然管家分组的意义是什么？……我要的是完善你本身以及其他智能体"
 *   ——互救 ≠ 重跑：重跑是同一智能体再来一遍；救援是**另一个智能体**（管理组/同域）去
 *   诊断（看日志/找原因）→ 修复（环境/配置/渠道/代码）→ 接管（按源目标完成产出）。
 *
 * 与既有模块分工（救援链）：
 *   - task-watchdog   管「卡死询问」（主动问进度/静默提醒）——发现层
 *   - butler.checkActive 管「卡死判定」（PID死/日志停滞 20min → 标记失败）——判定层
 *   - auto-optimize   管「失败后策略」（换渠道/换执行者/拆步）——同任务级优化
 *   - **本模块（agent-rescue）管「互救」**：自动重跑仍失败 → 派救援者诊断+修复+接管——跨智能体层
 *   - twin-duty-inspector 管「分身监督」：反复失败信号 → 分身自主决策派救援/升级——决策层
 *
 * 救援链（异常失败 → 升级用户的完整路径）：
 *   ① 失败 1 次 → 自动重跑（butler autoRerunTask，快路径）
 *   ② 重跑仍失败（rerun ≥ rescueAfterReruns）→ **触发救援**：pickRescuer 选救援者
 *      → 写 inbox/rescue-<task>-<stamp>.md（诊断+修复+接管）→ 状态 rescuing
 *   ③ 救援完成（.DONE）→ 记录 rescue-log（谁救的/怎么救的）→ 闭环，不打扰用户
 *   ④ 救援失败/超时 → 分身决策（升级用户 or 换救援者再救一次）→ 决策留痕
 *   ⑤ 分身决策=升级 → 通知用户（notifyTaskEvent 复用）
 *
 * 救援者选择（pickRescuer）：
 *   1. 同域智能体：org.json 组树里与受害者同组的兄弟（懂上下文，优先）
 *   2. 管理组兜底：coo → night-worker → reviewer → pm（按任务域再细调）
 *   3. 排除：受害者自身 / twin（只决策不干活）/ 纯组壳
 *
 * 用法：
 *   node lib/agent-rescue.js check                 # 巡检救援案例（butler 周期调）
 *   node lib/agent-rescue.js launch <task> <reason> [victim]   # 手动触发救援
 *   node lib/agent-rescue.js scan-health           # 智能体反复失败检测（分身调）
 *   node lib/agent-rescue.js self-test             # 内置自检（模拟卡死→救援→升级）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ORG_ROOT    = path.join(__dirname, '..');
const CONFIG      = path.join(ORG_ROOT, 'config', 'agent-rescue.json');
const STATE_FILE  = path.join(ORG_ROOT, 'logs', 'rescue-cases.json');
const RESCUE_LOG  = path.join(ORG_ROOT, 'logs', 'rescue-log.jsonl');
const TWIN_DEC_LOG= path.join(ORG_ROOT, 'logs', 'twin-rescue-decisions.jsonl');
const INBOX       = path.join(ORG_ROOT, 'inbox');
const LOGS        = path.join(ORG_ROOT, 'logs');
const RECOVERY_COUNT = path.join(LOGS, 'recovery-count.json');
const CORRECTIONS = path.join(ORG_ROOT, 'knowledge', 'corrections.md');
const CHAT_SIGNALS = path.join('C:/Users/du_ji/pi_workspace/hub', 'chat-signals.jsonl');

const registry = require('./registry');
const { routeDomain } = require('./domain-route');
const { logActivity } = require('./twin-log');

const readIf = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const readJsonSafe = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const writeJsonSafe = (p, o) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8'); } catch (e) {} };
const ensure = d => fs.mkdirSync(d, { recursive: true });
const tsISO = () => new Date().toISOString();
function tsStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function log(...a) {
  const line = `[${new Date().toLocaleTimeString()}] [agent-rescue] ${a.join(' ')}`;
  console.log(line);
  try { ensure(LOGS); fs.appendFileSync(path.join(LOGS, 'agent-rescue.log'), line + '\n', 'utf8'); } catch (e) {}
}

/* ── 配置 ────────────────────────────────────────────── */
function loadCfg(cfgPath) {
  const def = {
    enabled: true,
    rescueAfterReruns: 1,        // 自动重跑失败 ≥ 此次数 → 触发救援（不再直接升级用户）
    rescuerPool: ['coo', 'night-worker', 'reviewer', 'pm'],   // 管理组兜底池（按序尝试）
    rescueTimeoutMin: 120,       // 救援任务超时（分钟）→ 分身决策
    maxRescuersPerCase: 2,       // 同一救援案例最多尝试救援者数（换人再救一次）
    provider: 'opencode-go',     // 救援任务默认渠道
    model: 'deepseek-v4-flash',
    thinking: 'off',
    healthFailThreshold: 2,      // 智能体连续失败 ≥ 此次数 → 触发智能体健康救援（分身决策）
    healthWindowMin: 240,        // 健康检测时间窗（分钟）
    privateAgents: ['pm', 'reviewer', 'intel-gatherer', 'learning-officer', 'channel-manager', 'twin', 'coo'],
    excludePrefixes: ['checkpoint-', 'daily-meeting-', 'review-', 'intel-collect-', 'improve-', 'decision-', 'rescue-', 'ask-', 'duty-', 'backlog-'],
  };
  try { return Object.assign(def, readJsonSafe(cfgPath || CONFIG) || {}); }
  catch (e) { return def; }
}

/* ── 状态（救援案例表） ──────────────────────────────── */
function loadState(statePath) {
  const s = readJsonSafe(statePath || STATE_FILE) || {};
  if (!s.cases || typeof s.cases !== 'object') s.cases = {};
  return s;
}
function saveState(s, statePath) { writeJsonSafe(statePath || STATE_FILE, s); }

/* ── 救援记录 ────────────────────────────────────────── */
/** 救援记录（谁救的/怎么救的/结果）——logs/rescue-log.jsonl */
function recordRescue(rec, opts) {
  ensure(LOGS);
  const line = Object.assign({ ts: tsISO() }, rec);
  fs.appendFileSync((opts && opts.rescueLogPath) || RESCUE_LOG, JSON.stringify(line) + '\n', 'utf8');
  return line;
}

/** 分身决策留痕——logs/twin-rescue-decisions.jsonl */
function recordTwinDecision(rec, opts) {
  ensure(LOGS);
  const line = Object.assign({ ts: tsISO() }, rec);
  fs.appendFileSync((opts && opts.decLogPath) || TWIN_DEC_LOG, JSON.stringify(line) + '\n', 'utf8');
  return line;
}

/* ── 救援者选择 ──────────────────────────────────────── */
const MANAGEMENT_POOL = ['coo', 'night-worker', 'reviewer', 'pm'];

/** 找同组兄弟（org.json 组树）：与受害者同一组的其他执行智能体 */
function findSiblings(victim) {
  try {
    const data = registry.load();
    const nodes = data.nodes || {};
    const siblings = [];
    for (const [id, node] of Object.entries(nodes)) {
      if (node.type !== 'group' || !Array.isArray(node.children)) continue;
      if (!node.children.includes(victim)) continue;
      for (const mem of node.children) {
        const m = nodes[mem];
        if (mem !== victim && m && m.type === 'agent') siblings.push(mem);
      }
    }
    return siblings;
  } catch (e) { return []; }
}

/**
 * 选救援者：
 *  1. 同域智能体（按任务内容 domain-route 路由 → 该域智能体；或受害者同组兄弟）
 *  2. 管理组兜底池
 *  排除：受害者自身、已尝试过的救援者、twin（只决策不干活）
 */
function pickRescuer(taskName, victim, reason, tried) {
  const cfg = loadCfg();
  const triedSet = new Set(tried || []);
  triedSet.add(victim);
  triedSet.add('twin');
  triedSet.add('coo-bot');
  // 1) 任务内容路由 → 同域智能体
  const src = readIf(path.join(INBOX, `${taskName}.md`)) || reason || '';
  let domainAgent = null;
  try { domainAgent = routeDomain({ name: taskName, content: src }); } catch (e) {}
  const siblings = findSiblings(victim);
  const candidates = [];
  if (domainAgent && !triedSet.has(domainAgent)) candidates.push(domainAgent);
  for (const s of siblings) if (!triedSet.has(s) && s !== domainAgent) candidates.push(s);
  // 2) 管理组兜底
  for (const m of (cfg.rescuerPool || MANAGEMENT_POOL)) {
    if (!triedSet.has(m)) candidates.push(m);
  }
  return candidates.length ? candidates[0] : null;
}

/* ── 救援派发 ────────────────────────────────────────── */
/**
 * 触发救援：创建/推进救援案例，选救援者，写 inbox/rescue-<task>-<stamp>.md。
 * 幂等：同任务已有 rescuing 状态案例 → 不重复派。
 * @returns {object|null} { case, taskFile, rescuer } 或 null（无救援者/已在救）
 */
function launchRescue(taskName, reason, victim, opts) {
  const o = opts || {};
  const cfg = loadCfg(o.cfgPath);
  if (!cfg.enabled) { log(`⏸ 救援禁用（config enabled=false），跳过 ${taskName}`); return null; }
  const state = loadState(o.statePath);
  const cs = state.cases[taskName];
  if (cs && cs.status === 'rescuing' && Date.now() - (cs.dispatchedAt || 0) < (cfg.rescueTimeoutMin || 120) * 60000) {
    log(`⏳ [${taskName}] 已有进行中的救援（救援者 ${cs.rescuer}），跳过重复派发`);
    return null;
  }
  const tried = (cs && cs.triedRescuers) || [];
  const rescuer = pickRescuer(taskName, victim || 'coo', reason, tried);
  if (!rescuer) {
    log(`🚫 [${taskName}] 无可用救援者（已尝试 ${tried.join(',')}）→ 升级用户`);
    return escalateToUser(taskName, reason, victim, '无可用救援者', o.statePath, { decLogPath: o.decLogPath });
  }
  const stamp = tsStamp();
  const taskFile = `rescue-${taskName}-${stamp}`;
  const mdPath = path.join(INBOX, `${taskFile}.md`);
  if (readIf(mdPath)) { log(`⚠️ [${taskName}] 救援任务文件已存在 ${taskFile}，跳过`); return null; }
  const donePath = path.join(INBOX, `${taskFile}.DONE`);
  const provider = (cfg.privateAgents || []).includes(rescuer) ? 'deepseek' : (o.provider || cfg.provider || 'opencode-go');
  const srcContent = (readIf(path.join(INBOX, `${taskName}.md`)) || '').slice(0, 3000);
  const content = [
    `agent: ${rescuer}`,
    `provider: ${provider}`,
    `model: ${cfg.model || 'deepseek-v4-flash'}`,
    `thinking: ${cfg.thinking || 'off'}`,
    ``,
    `# 救援任务：${taskName} 异常，请诊断+修复+接管`,
    ``,
    `任务 ${taskName} 由 ${victim || '未知智能体'} 执行时异常（${reason}），管家已尝试自动重跑仍失败。现在派你（互救机制）去救援。`,
    ``,
    `## 救援要求（救援≠重跑：诊断→修复→接管）`,
    `1. **诊断**：读任务日志 logs/${taskName}.log 的最后输出（tail 即可，禁止全文 cat 大文件），结合源任务目标找根因（环境/渠道/依赖/资源冲突/代码问题）`,
    `2. **修复**：根因可修复（清理残留进程/修正环境/换渠道/重装依赖/改配置）→ 现场修复`,
    `3. **接管**：修复后按源任务目标直接接管完成（产出按源任务要求写回），不满足于"只是重跑"`,
    `4. **报告**：完成后在 DONE 摘要写明：根因/救援动作/结果（供救援记录留痕）`,
    ``,
    `## 源任务目标`,
    '```',
    srcContent || '(源任务文件已归档，见 inbox/archive/)',
    '```',
    ``,
    `执行要求：`,
    `1. 独立完成救援，不等待外部指令`,
    `2. 完成后创建标记文件（一行摘要，注明"救援完成：根因/动作/结果"）：${donePath}`,
    `3. 若无法救援，写 ${donePath} 内容为 .FAILED: <原因>（说明卡在哪，供分身决策下一步）`,
    ``,
    `【上下文管理铁律（2026-08-10 强制执行）】`,
    `- 禁止全量 cat/读取大文件（*.jsonl / 日志 / 数据库导出）——会撑爆上下文导致被杀。`,
    `- 用 grep/head -20/tail -50/wc -l 精准取片段；读大文件前先看行数。`,
  ].join('\n');
  ensure(INBOX);
  fs.writeFileSync(mdPath, content, 'utf8');
  const newCase = {
    task: taskName, victim: victim || 'coo', reason: reason || '未知原因',
    rescuer, taskFile, dispatchedAt: Date.now(), status: 'rescuing',
    triedRescuers: tried.concat([rescuer]), attempts: (cs ? cs.attempts : 0) + 1, createdAt: Date.now()
  };
  state.cases[taskName] = newCase;
  saveState(state, o.statePath);
  recordRescue({ task: taskName, victim: newCase.victim, rescuer, action: 'dispatch', reason, file: taskFile }, { rescueLogPath: o.rescueLogPath });
  logActivity('[互救] 救援派发',
    `${taskName}（执行者 ${newCase.victim}，原因 ${reason}）→ 救援者 ${rescuer} → inbox/${taskFile}.md 渠道=${provider}`, '互救');
  log(`🚑 [${taskName}] 救援派发 → ${rescuer}（${reason}，第 ${newCase.attempts} 次尝试）→ ${taskFile}.md`);
  return { case: newCase, taskFile, rescuer };
}

/* ── 巡检救援案例（butler 周期调） ───────────────────── */
/**
 * check：跟踪进行中救援案例
 *   - 救援 .DONE → 标记 rescued（闭环，不打扰用户）+ 记录 + 自我完善钩子
 *   - 救援 .FAILED → 换救援者再救一次（maxRescuersPerCase）→ 耗尽则分身决策升级
 *   - 救援超时（rescueTimeoutMin 无标记）→ 分身决策升级
 */
function check(opts) {
  const o = opts || {};
  const cfg = loadCfg(o.cfgPath);
  if (!cfg.enabled) return { resolved: [], escalated: [] };
  const state = loadState(o.statePath);
  const now = Date.now();
  const resolved = [];
  const escalated = [];
  for (const [taskName, cs] of Object.entries(state.cases || {})) {
    if (cs.status === 'rescued' || cs.status === 'escalated') continue;
    const done = readIf(path.join(INBOX, `${cs.taskFile}.DONE`));
    if (done) {
      const ok = !done.includes('.FAILED');
      if (ok) {
        cs.status = 'rescued'; cs.resolvedAt = now; cs.rescueSummary = done.trim().slice(0, 300);
        recordRescue({ task: taskName, victim: cs.victim, rescuer: cs.rescuer, action: 'rescued', summary: cs.rescueSummary }, { rescueLogPath: o.rescueLogPath });
        // 自我完善：救援成功 → 根因沉淀到 corrections 台账 + 进化信号
        selfImprove(taskName, cs, done, { correctionsPath: o.correctionsPath, signalsPath: o.signalsPath });
        logActivity('[互救] 救援成功',
          `${taskName} ← ${cs.rescuer}：${done.trim().slice(0, 120)}`, '互救');
        log(`✅ [${taskName}] 救援成功（${cs.rescuer}）→ 闭环，不打扰用户`);
        resolved.push(taskName);
      } else {
        // 救援失败 → 尝试换救援者
        const msg = done.trim().slice(0, 150);
        recordRescue({ task: taskName, victim: cs.victim, rescuer: cs.rescuer, action: 'rescue-failed', summary: msg }, { rescueLogPath: o.rescueLogPath });
        log(`❌ [${taskName}] 救援失败（${cs.rescuer}: ${msg}）`);
        const attempts = (cs.attempts || 0) + 1;
        if (attempts < (cfg.maxRescuersPerCase || 2)) {
          log(`🔁 [${taskName}] 换救援者再救一次（第 ${attempts + 1}/${cfg.maxRescuersPerCase} 次）`);
          const relaunch = launchRescue(taskName, cs.reason, cs.victim, { forced: true, cfgPath: o.cfgPath, statePath: o.statePath });
          if (relaunch) {
            cs.status = 'relaunching';
            state.cases[taskName] = relaunch.case;   // 同步 launchRescue 写回的最新案例（防末尾 saveState 覆盖丢失）
            continue;
          }
        }
        // 救援者耗尽 → 分身决策升级
        cs.status = 'escalated'; cs.escalatedAt = now; cs.escalateReason = `救援 ${attempts} 次均失败（${msg}）`;
        const dec = escalateToUser(taskName, cs.reason, cs.victim, `救援 ${attempts} 次均失败（${msg}）`, o.statePath, { decLogPath: o.decLogPath });
        if (dec) escalated.push(taskName);
      }
    } else if (now - (cs.dispatchedAt || 0) > (cfg.rescueTimeoutMin || 120) * 60000) {
      // 超时未完成
      recordRescue({ task: taskName, victim: cs.victim, rescuer: cs.rescuer, action: 'rescue-timeout', summary: `超时 ${cfg.rescueTimeoutMin}min 无标记` });
      log(`⏰ [${taskName}] 救援超时（${cs.rescuer} ${cfg.rescueTimeoutMin}min 无结果）`);
      cs.status = 'escalated'; cs.escalatedAt = now; cs.escalateReason = `救援超时（${cfg.rescueTimeoutMin}min 无结果）`;
      const dec = escalateToUser(taskName, cs.reason, cs.victim, `救援超时（${cfg.rescueTimeoutMin}min 无结果）`, o.statePath, { decLogPath: o.decLogPath });
      if (dec) escalated.push(taskName);
    }
  }
  saveState(state, o.statePath);
  return { resolved, escalated };
}

/** 升级用户（复用 activity 留痕 + 写 decisions 请求供分身决策；如需 HK 通知可接入 notifyTaskEvent） */
function escalateToUser(taskName, reason, victim, extra, statePath, opts) {
  const o = opts || {};
  const state = loadState(statePath);
  const cs = state.cases[taskName];
  if (cs) { cs.status = 'escalated'; cs.escalatedAt = Date.now(); cs.escalateReason = extra; saveState(state, statePath); }
  const msg = `任务 ${taskName} 互救链耗尽需人工介入（执行者 ${victim || '?'}，原因 ${reason}；${extra || ''}）`;
  // 分身决策留痕（分身监督升级链的记录）
  recordTwinDecision({ task: taskName, signal: 'rescue-chain-exhausted', decision: '升级用户', reason: extra || reason }, { decLogPath: o.decLogPath });
  logActivity('[互救] 升级用户', msg.slice(0, 160), '互救');
  log(`🚨 ${msg}`);
  return { task: taskName, message: msg };
}

/* ── 自我完善闭环 ────────────────────────────────────── */
/**
 * 救援成功/失败后自动沉淀：
 *  1. corrections 台账追加一条（日期/问题/落地/验证）
 *  2. chat-signals.jsonl 追加进化信号（learning-officer 自动合并）
 */
function selfImprove(taskName, cs, done, opts) {
  const o = opts || {};
  const correctionsPath = o.correctionsPath || CORRECTIONS;
  const signalsPath = o.signalsPath || CHAT_SIGNALS;
  try {
    const rootCause = (cs.rescueSummary || done || '').slice(0, 200);
    const entry = `\n## ${new Date().toISOString().slice(0, 10)} — 互救沉淀（agent-rescue）\n- **问题**：任务 ${taskName}（执行者 ${cs.victim}）异常：${cs.reason}\n- **救援**：${cs.rescuer} → ${rootCause}\n- **落地**：机制层 agent-rescue 互救链 + 救援者接管；待验证：同类异常不再复发\n- **验证**：例会核对该任务域后续任务\n`;
    if (readIf(correctionsPath)) {
      fs.appendFileSync(correctionsPath, entry, 'utf8');
    } else {
      ensure(path.dirname(correctionsPath));
      fs.writeFileSync(correctionsPath, '# 主会话纠正台账（corrections ledger）\n' + entry, 'utf8');
    }
  } catch (e) { log('corrections 台账追加失败: ' + e.message); }
  try {
    ensure(path.dirname(signalsPath));
    const sig = { ts: tsISO(), type: 'correction', content: `互救沉淀：任务 ${taskName} 异常（${cs.reason}）由 ${cs.rescuer} 救援（${(cs.rescueSummary || '').slice(0, 120)}）——该域智能体易出错点需关注`, dedup_key: `rescue-${taskName}-${cs.createdAt}` };
    fs.appendFileSync(signalsPath, JSON.stringify(sig) + '\n', 'utf8');
  } catch (e) { log('进化信号追加失败: ' + e.message); }
}

/* ── 智能体健康检测（分身监督用） ────────────────────── */
/**
 * scanHealth：扫描「智能体反复失败」信号
 *   - 读 recovery-count.json（异常重跑计数）+ inbox 最近 .FAILED 文件
 *   - 某智能体 healthWindowMin 内失败 ≥ healthFailThreshold → 返回异常列表
 * 分身据此自主决策：派管理组诊断该智能体 / 通知用户。
 */
function scanHealth(opts) {
  const o = opts || {};
  const cfg = loadCfg(o.cfgPath);
  const now = Date.now();
  const windowMs = (cfg.healthWindowMin || 240) * 60000;
  const failures = {};   // agentId -> { count, tasks: [] }
  // 1) recovery-count（重跑计数 = 曾异常）
  const rec = readJsonSafe(o.recCountPath || RECOVERY_COUNT) || {};
  for (const [task, cnt] of Object.entries(rec)) {
    if (cnt < (cfg.healthFailThreshold || 2)) continue;
    const agent = detectAgentOfTask(task);
    if (!agent) continue;
    const f = failures[agent] || (failures[agent] = { count: 0, tasks: [] });
    f.count += cnt; f.tasks.push(task);
  }
  // 2) inbox 近期 .FAILED 文件（异常失败标记）
  let files = [];
  try { files = fs.readdirSync(INBOX).filter(f => f.endsWith('.FAILED')); } catch (e) {}
  for (const f of files.slice(-40)) {
    try {
      const st = fs.statSync(path.join(INBOX, f));
      if (now - st.mtimeMs > windowMs) continue;
      const agent = detectAgentOfTask(f.replace(/\.(DONE|FAILED)$/, ''));
      if (!agent) continue;
      const fm = failures[agent] || (failures[agent] = { count: 0, tasks: [] });
      fm.count += 1; fm.tasks.push(f);
    } catch (e) {}
  }
  return Object.entries(failures)
    .filter(([, v]) => v.count >= (cfg.healthFailThreshold || 2))
    .map(([agent, v]) => ({ agent, count: v.count, tasks: v.tasks.slice(0, 8) }));
}

/** 从任务名探测执行者（源任务文件 agent: 头） */
function detectAgentOfTask(taskName) {
  const src = readIf(path.join(INBOX, `${taskName}.md`));
  if (src) {
    const m = src.match(/^agent\s*:\s*(\S+)/m);
    if (m) return m[1];
  }
  // 归档目录兜底
  const arch = readIf(path.join(INBOX, 'archive', `${taskName}.md`));
  if (arch) {
    const m = arch.match(/^agent\s*:\s*(\S+)/m);
    if (m) return m[1];
  }
  return null;
}

/* ── 内置自检（模拟：卡死→救援→成功闭环 / 救援失败→升级） ── */
function selfTest() {
  const TEST_DIR = path.join(LOGS, '_agent-rescue-test');
  ensure(TEST_DIR);
  const clean = () => { try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (e) {} };
  const testCfgPath = path.join(TEST_DIR, 'cfg.json');
  const testStatePath = path.join(TEST_DIR, 'state.json');
  const testCorrPath = path.join(TEST_DIR, 'corrections.md');
  const testSigPath = path.join(TEST_DIR, 'chat-signals.jsonl');
  const testRecPath = path.join(TEST_DIR, 'recovery-count.json');
  const rescueOpts = { cfgPath: testCfgPath, statePath: testStatePath, correctionsPath: testCorrPath, signalsPath: testSigPath, recCountPath: testRecPath,
    rescueLogPath: path.join(TEST_DIR, 'rescue-log.jsonl'), decLogPath: path.join(TEST_DIR, 'twin-rescue-decisions.jsonl') };
  writeJsonSafe(testCfgPath, {
    enabled: true, rescueAfterReruns: 1, rescuerPool: ['coo', 'night-worker', 'reviewer', 'pm'],
    rescueTimeoutMin: 120, maxRescuersPerCase: 2, provider: 'opencode-go', model: 'deepseek-v4-flash', thinking: 'off',
    healthFailThreshold: 2, healthWindowMin: 240, privateAgents: [], excludePrefixes: []
  });
  writeJsonSafe(testRecPath, {});

  // 备份真实状态，替换为测试状态文件
  const realState = readJsonSafe(STATE_FILE) || {};
  let pass = 0, fail = 0;
  const results = [];
  const checkOne = (ok, label) => { results.push((ok ? '✅' : '❌') + ' ' + label); ok ? pass++ : fail++; };

  const FAKE = `rescue-self-test-${Date.now()}`;
  const fakeDone = path.join(INBOX, `${FAKE}.DONE`);
  try { fs.rmSync(fakeDone, { force: true }); } catch (e) {}

  try {
    // 场景1：模拟智能体卡死 → 救援派发（救援者=管理组兜底 coo）
    writeJsonSafe(testStatePath, { cases: {} });
    writeJsonSafe(testCfgPath, Object.assign(readJsonSafe(testCfgPath), { maxRescuersPerCase: 1 }));
    // 造一个源任务文件（让 pickRescuer 能读内容）
    fs.writeFileSync(path.join(INBOX, `${FAKE}.md`), 'agent: workspace\n\n# 模拟卡死任务\n\n目标：测试互救机制，任务内容无实际业务含义。\n', 'utf8');
    const r1 = launchRescue(FAKE, '模拟卡死（日志 25 分钟未更新，重跑仍失败）', 'workspace', rescueOpts);
    checkOne(!!r1 && r1.rescuer !== 'workspace', `智能体卡死 → 救援派发成功（救援者=${r1 ? r1.rescuer : '?'}，≠ 受害者）`);
    checkOne(!!r1 && !!r1.taskFile && readIf(path.join(INBOX, `${r1.taskFile}.md`)) && /诊断/.test(readIf(path.join(INBOX, `${r1.taskFile}.md`)) || ''),
      '救援任务文件已写入 inbox/，内容含「诊断→修复→接管」要求');
    // 救援者≠twin、≠受害者
    checkOne(r1.rescuer !== 'twin', '救援者不会选 twin（分身只决策不干活）');
    // 幂等：重复触发不重派
    const r2 = launchRescue(FAKE, '重复触发', 'workspace', rescueOpts);
    checkOne(r2 === null, '同案例进行中重复触发 → 幂等跳过');

    // 场景2：模拟救援者完成 → check 标记 rescued + 记录
    if (r1) {
      fs.writeFileSync(path.join(INBOX, `${r1.taskFile}.DONE`), `救援完成：根因=模拟环境残留，动作=清理+重跑，结果=任务正常产出`, 'utf8');
      const res = check(rescueOpts);
      const state = readJsonSafe(testStatePath) || {};
      checkOne(state.cases[FAKE] && state.cases[FAKE].status === 'rescued',
        '救援完成 → 案例标记 rescued（闭环，不打扰用户）');
      checkOne(res.resolved.includes(FAKE), 'check() 返回 resolved 列表含该任务');
      const rescueLog = readIf(path.join(TEST_DIR, 'rescue-log.jsonl')) || '';
      checkOne(rescueLog.includes('"rescued"') && rescueLog.includes(FAKE),
        '救援记录已写入 rescue-log（谁救的/怎么救的）');
      const corr = readIf(testCorrPath) || '';
      checkOne(corr.includes(FAKE), '自我完善：救援根因已追加 corrections 台账');
    }

    // 场景3：模拟救援失败 → 换救援者/升级（maxRescuersPerCase=1 → 直接升级用户）
    const FAKE2 = `rescue-self-test-fail-${Date.now()}`;
    fs.writeFileSync(path.join(INBOX, `${FAKE2}.md`), 'agent: workspace\n\n# 模拟反复失败任务\n\n目标：测试升级链。\n', 'utf8');
    const r3 = launchRescue(FAKE2, '连续失败 3 次', 'workspace', rescueOpts);
    if (r3) {
      fs.writeFileSync(path.join(INBOX, `${r3.taskFile}.DONE`), `.FAILED: 救援者也无法诊断（环境彻底损坏）`, 'utf8');
      const res2 = check(rescueOpts);
      const state2 = readJsonSafe(testStatePath) || {};
      checkOne(state2.cases[FAKE2] && state2.cases[FAKE2].status === 'escalated',
        '救援失败 → 案例标记 escalated（升级用户，分身决策留痕）');
      checkOne(res2.escalated.includes(FAKE2), 'check() 返回 escalated 列表含该任务');
      const decLog = readIf(path.join(TEST_DIR, 'twin-rescue-decisions.jsonl')) || '';
      checkOne(decLog.includes('rescue-chain-exhausted') && decLog.includes(FAKE2),
        '分身决策留痕已写入 twin-rescue-decisions.jsonl（测试隔离）');
      const act = readIf(path.join(ORG_ROOT, 'agents', 'twin', 'activity.log')) || '';
      checkOne(act.includes('[互救] 升级用户'), 'activity 留痕 [互救] 升级用户');
    }

    // 场景4：智能体健康检测（反复失败 → 分身可决策派管理组诊断）
    writeJsonSafe(testRecPath, { [FAKE2]: 3, 'other-ok-task': 0 });
    const health = scanHealth(rescueOpts);
    checkOne(health.some(h => h.agent === 'workspace' && h.count >= 2),
      '智能体健康检测：连续失败 ≥ 阈值 → 识别出异常智能体（分身可据此决策派救援）');
  } catch (e) {
    checkOne(false, '自检执行异常: ' + e.message);
  } finally {
    // 还原
    try { fs.rmSync(path.join(INBOX, `${FAKE}.md`), { force: true }); } catch (e) {}
    try { fs.rmSync(fakeDone, { force: true }); } catch (e) {}
    // 清理测试救援文件
    for (const f of fs.readdirSync(INBOX)) {
      if (f.startsWith('rescue-rescue-self-test') || f.startsWith('rescue-self-test')) {
        try { fs.unlinkSync(path.join(INBOX, f)); } catch (e) {}
      }
    }
    writeJsonSafe(STATE_FILE, realState);
    clean();
  }
  console.log('\n=== agent-rescue 内置自检 ===');
  results.forEach(r => console.log('  ' + r));
  console.log(`结果: ${pass}/${pass + fail} 通过${fail ? '（有失败）' : ''}`);
  process.exit(fail ? 1 : 0);
}

/* ── CLI ─────────────────────────────────────────────── */
function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'self-test') return selfTest();
  if (argv[0] === 'launch') {
    const task = argv[1], reason = argv[2] || '手动触发', victim = argv[3] || null;
    const r = launchRescue(task, reason, victim);
    console.log(r ? `✅ 救援已派发 → ${r.rescuer}（${r.taskFile}）` : '❌ 未派发（已在救/无救援者）');
    process.exit(0);
  }
  if (argv[0] === 'scan-health') {
    const h = scanHealth();
    console.log(h.length ? `异常智能体 ${h.length} 个: ` + h.map(x => `${x.agent}(失败${x.count})`).join(', ')
      : '无智能体连续失败异常');
    process.exit(0);
  }
  const res = check();
  console.log(`agent-rescue check → 救援成功 ${res.resolved.length} | 升级 ${res.escalated.length}`);
  process.exit(0);
}

if (require.main === module) main();

module.exports = { launchRescue, check, scanHealth, pickRescuer, recordRescue, recordTwinDecision, loadCfg };
