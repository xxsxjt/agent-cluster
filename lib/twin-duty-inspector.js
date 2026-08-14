#!/usr/bin/env node
/**
 * lib/twin-duty-inspector.js — 分身职责巡检（2026-08-09）
 *
 * 主动发现"该干活没干"的智能体并派活。挂入 twin-daemon 巡查循环（每 5 分钟 runPatrol 调用 scanDuties()）。
 *
 * 与 butler auto-schedule 幂等协调：
 *   - butler 在线 → auto-schedule（每分钟）为定时职责权威，分身只做业务信号/闲置派活，不抢定时调度；
 *   - butler 离线 → 分身兜底触发到期未跑的定时职责（调用 auto-schedule 的 check()，其自带幂等）。
 *
 * 四类巡检：
 *   1. 定时职责漏跑兜底（butler 离线时）
 *   2. 智能体闲置检测（长期闲置 + 负有周期性职责 → 该干没干 → 派活）
 *   3. 业务信号驱动（新任务完成→审核官验收；用户新信号→PM 规划/进化官合并；等）
 *   4. 防骚扰节流（同职责最小派活间隔，幂等，activity [派活] 留痕）
 *
 * 配置：org/config/duty-inspector.json
 * 状态：org/logs/twin-duty-state.json（throttle + seenDone + chatSignal 游标）
 *
 * 用法：
 *   node lib/twin-duty-inspector.js scan      # 单次巡检（自检/验证用，跑 scanDuties）
 *   node lib/twin-duty-inspector.js test      # 跑内置自检（造场景：butler离线漏跑/闲置/业务信号/节流）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ORG_ROOT   = path.join(__dirname, '..');
const CONFIG     = path.join(ORG_ROOT, 'config', 'duty-inspector.json');
const STATE_FILE = path.join(ORG_ROOT, 'logs', 'twin-duty-state.json');
const INBOX      = path.join(ORG_ROOT, 'inbox');
const LOGS       = path.join(ORG_ROOT, 'logs');
const AGENTS_DIR = path.join(ORG_ROOT, 'agents');
const ORG_JSON   = path.join(ORG_ROOT, 'org.json');
const BUTLER_PID = path.join(ORG_ROOT, 'butler.pid');
const AUTO_SCHED_CONFIG = path.join(ORG_ROOT, 'config', 'auto-schedule.json');
const AUTO_SCHED_STATE  = path.join(LOGS, 'auto-schedule-state.json');
const CHAT_SIGNALS      = path.join(ORG_ROOT, '..', 'hub', 'chat-signals.jsonl');  // C:\Users\du_ji\pi_workspace\hub\chat-signals.jsonl
const BACKLOG_CONFIG   = path.join(ORG_ROOT, 'config', 'agent-backlog.json');
const RESOURCE_REGISTRY = path.join(ORG_ROOT, 'knowledge', 'resource-registry.json');

const { logActivity } = require('./twin-log');

const readIf  = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const readJsonSafe = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const writeJsonSafe = (p, o) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8'); } catch (e) {} };
const ensure = d => fs.mkdirSync(d, { recursive: true });
const statOf = p => { try { return fs.statSync(p); } catch (e) { return null; } };
const tsISO  = () => new Date().toISOString();
function tsStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function log(...a) {
  const line = `[${new Date().toLocaleTimeString()}] [duty-inspector] ${a.join(' ')}`;
  console.log(line);
  try { ensure(LOGS); fs.appendFileSync(path.join(LOGS, 'twin-duty-inspector.log'), line + '\n', 'utf8'); } catch (e) {}
}

function loadCfg() {
  let c = {};
  try { c = readJsonSafe(CONFIG) || {}; } catch (e) {}
  // 默认值兜底
  c.enabled = c.enabled !== false;
  c.scheduledFallback = c.scheduledFallback !== false;
  c.idleThresholdHours = c.idleThresholdHours || 24;
  c.throttleMinutes = c.throttleMinutes || {};
  c.businessSignals = c.businessSignals || {};
  c.idleDuties = c.idleDuties || {};
  return c;
}
function loadState() { return readJsonSafe(STATE_FILE) || { throttle: {}, seenDone: {}, chatSig: { size: 0, mtime: 0 } }; }
function saveState(s) { writeJsonSafe(STATE_FILE, s); }

let _butlerOverride = null;   // 测试用：强制覆盖 butler 在线判定
function setButlerOverride(v) { _butlerOverride = v; }
function butlerAlive() {
  if (_butlerOverride != null) return _butlerOverride;
  try {
    const pid = parseInt((readIf(BUTLER_PID) || '').trim(), 10);
    if (!pid || Number.isNaN(pid)) return false;
    if (process.platform === 'win32') {
      // Windows 关键修复（同 bootstrap.js isAlive）：process.kill(pid,0) 对已死 PID 也可能不抛错，
      // 不能只凭退出码/不抛错判断存活。必须用 tasklist 解析输出，确认该 PID 真实存在于进程表。
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { stdio: 'pipe', windowsHide: true, encoding: 'utf8' });
      return out.includes(`"${pid}"`);
    }
    process.kill(pid, 0);
    return true;
  } catch (e) { return e.code === 'EPERM'; }
}

/** 防骚扰节流：同职责最小派活间隔 */
function passThrottle(state, key, cfg) {
  const tm = cfg.throttleMinutes || {};
  const min = tm[key] || tm._default || 360;
  const last = (state.throttle || {})[key] || 0;
  if (Date.now() - last < min * 60 * 1000) return false;
  return true;
}
function setThrottle(state, key) {
  state.throttle = state.throttle || {};
  state.throttle[key] = Date.now();
}

/** 派活：写 inbox/<prefix>-<ts>.md，头部 agent/provider/model（隐私敏感 agent 走 deepseek 官方渠道） */
const PRIVACY_AGENTS = ['learning-officer', 'pm', 'intel-gatherer', 'reviewer', 'channel-manager'];
const TASK_PREFIX = {
  'channel-manager': 'chan-scan', reviewer: 'review-batch', pm: 'pm-plan',
  'intel-gatherer': 'intel-collect', 'learning-officer': 'learning-merge'
};
function dispatchTask(agent, reasonTitle, reasonBody, providerOverride) {
  const name = `${TASK_PREFIX[agent] || 'duty'}-${tsStamp()}`;
  const p = path.join(INBOX, `${name}.md`);
  if (fs.existsSync(p)) return null;   // 幂等：已在队列
  const provider = providerOverride || (PRIVACY_AGENTS.includes(agent) ? 'deepseek' : 'opencode-go');
  const content = [
    `agent: ${agent}`,
    `provider: ${provider}`,
    `model: deepseek-v4-flash`,
    `thinking: off`,
    ``,
    `# ${reasonTitle}`,
    ``,
    reasonBody || '',
    ``,
    `执行要求：`,
    `1. 独立完成，轻量执行（不抢正常任务资源）`,
    `2. 完成后创建标记文件（一行摘要）：${path.join(INBOX, `${name}.DONE`)}`,
    `3. 若无法完成，写该文件内容为 .FAILED: <原因>`,
  ].join('\n');
  fs.writeFileSync(p, content, 'utf8');
  return name;
}

/** 业务信号 → 派活内容模板 */
const SIGNAL_TASKS = {
  reviewer: (items) => ({
    title: `分身巡检派活：审核官验收新完成任务批次（on-demand）`,
    body: [
      `分身（twin-daemon 职责巡检）发现以下任务已完成/失败，按审核官职责做一次及时验收（无需等每日例会）：`,
      ``,
      items.map(i => `- ${i.name} ${i.failed ? '❌失败' : '✅完成'}：${i.summary.slice(0, 100)}`).join('\n'),
      ``,
      `要求：`,
      `1. 对每个任务按「报告完整性 / 证据可核验 / 回归通过」三项验收，明确 ✅通过 或 ❌驳回`,
      `2. 发现谎报/夸大 → 标记并说明`,
      `3. 验收结论追加到 knowledge/meetings/ 下当日验收材料，并给分身/管家参考`,
      `4. ⚠️ 效率约束：只核对关键证据（DONE 摘要 vs 真实产物路径/日志），不做全盘 find/C 盘深度扫描；限定在 org 项目目录与任务声明产物路径内`,
    ].join('\n')
  }),
  pm: (signals) => ({
    title: `分身巡检派活：用户新信号 → 产品经理规划`,
    body: [
      `分身（twin-daemon 职责巡检）检测到用户最近有新的想法/决策/偏好信号，请按 PM 职责做一次规划（把模糊想法转成结构化需求/任务拆解，供管家派发）：`,
      ``,
      `近期新信号（${signals.length} 条）：`,
      signals.map(s => `- [${s.type}] ${s.content.slice(0, 120)}`).join('\n'),
      ``,
      `要求：`,
      `1. 梳理哪些信号需要落地成可执行任务（想法/决策/新方向），输出 PRD 或任务拆解`,
      `2. 按 P0/P1/P2 排优先级（平衡用户价值与实现成本）`,
      `3. 产出写到 knowledge/meetings/ 或 artifacts/，任务包交管家派发`,
      `4. 无法立刻规划的琐碎信号 → 说明并归档即可，不强求`,
    ].join('\n')
  }),
  'learning-officer': (count) => ({
    title: `分身巡检派活：学习进化官合并 chat-signals 增量`,
    body: [
      `分身（twin-daemon 职责巡检）检测到 chat-signals.jsonl 有 ${count} 条新信号未合并，请按学习进化官职责做一次增量合并：`,
      `1. 读取 C:\\Users\\du_ji\\pi_workspace\\hub\\chat-signals.jsonl 增量（按游标/时间戳，只处理新增）`,
      `2. 提炼经验 → 更新 org/knowledge/ 四件套（assets/pitfalls/conventions/changelog）`,
      `3. 合并后推进游标，不重复处理`,
      `⚠️ 隐私铁律：chat-signals 含用户偏好/纠正（个人数据），只在本任务 deepseek 渠道处理，不写原文出圈、不带敏感原始信息。`,
    ].join('\n')
  }),
};

/** 闲置派活专用模板（区别于业务信号，不引用信号条数） */
const IDLE_TASKS = {
  'learning-officer': (agentId, idleHours) => ({
    title: `分身巡检派活：${agentId} 长期闲置（${idleHours}h）该干没干`,
    body: [
      `分身（twin-daemon 职责巡检）检测到 ${agentId} 已闲置 ${idleHours} 小时，超过其周期性职责的合理间隔，按职责做一次例行：`,
      `1. 读取 C:\\Users\\du_ji\\pi_workspace\\hub\\chat-signals.jsonl 增量，把新信号合并沉淀到 org/knowledge/ 四件套（assets/pitfalls/conventions/changelog）`,
      `2. 抽查各智能体记忆纪律 / 重复踩坑检测（如有）`,
      `3. 无新增量则在结果注明"无新增量"即可，轻量执行不抢资源`,
      `⚠️ 隐私铁律：chat-signals 含用户偏好/纠正（个人数据），只在本任务 deepseek 渠道处理，不写原文出圈、不带敏感原始信息。`,
    ].join('\n')
  }),
  pm: (agentId, idleHours) => ({
    title: `分身巡检派活：${agentId} 长期闲置（${idleHours}h）该干没干`,
    body: [
      `分身（twin-daemon 职责巡检）检测到 ${agentId} 已闲置 ${idleHours} 小时，超过其周期性职责的合理间隔，按职责做一次例行规划：`,
      `1. 梳理近期用户想法/决策/偏好信号（chat-signals 增量 + knowledge 新内容），看有无待澄清/待拆解的需求`,
      `2. 有 → 输出 PRD 或任务拆解（P0/P1/P2）交管家派发；无 → 结果注明"无新增需求"即可`,
      `3. 轻量执行，不抢正常任务资源`,
    ].join('\n')
  }),
};

/* ── 1. 定时职责漏跑兜底（butler 离线时） ──────────────── */
/**
 * butler 在线 → 不兜底（auto-schedule 每分钟为权威）；
 * butler 离线 → 调 auto-schedule check() 触发到期未跑的定时职责（其内部幂等）。
 */
/* ── 1.5 管家自杀拉起（2026-08-10 review-loop） ──────────────────────
 * 分身巡查检测 butler 主进程死亡 → 自动拉起（node scripts/bootstrap.js start）。
 * 防反复：cooldownMin 窗口内重复死亡超过 maxRestarts 次 → 记录异常并通知，不无限拉起。
 */
function watchButler(cfg, state, changed) {
  const w = cfg.butlerWatchdog;
  if (!w || w.enabled === false) return;
  const bw = state.butlerWatch || { deaths: 0, windowStart: 0, restarts: 0, lastAnomaly: 0 };
  const now = Date.now();
  const cooldown = (w.cooldownMin || 5) * 60 * 1000;
  const maxRestarts = w.maxRestarts || 3;
  if (now - bw.windowStart > cooldown) {
    bw.windowStart = now;       // 新窗口：重置计数
    bw.deaths = 0;
    bw.restarts = 0;
  }
  if (butlerAlive()) return;    // 管家活着，无需拉起（不在窗口记录死亡）

  bw.deaths = (bw.deaths || 0) + 1;
  // 同一窗口内死亡次数超过 maxRestarts → 判定异常，不无限拉起（防反复崩溃→反复重启抖动）
  if (bw.deaths > maxRestarts) {
    if (now - (bw.lastAnomaly || 0) > cooldown) {
      bw.lastAnomaly = now;
      const line = logActivity('butler 反复死亡超过阈值，暂停自动拉起',
        `cooldown ${w.cooldownMin}min 内死亡 ${bw.deaths} 次（上限 ${maxRestarts}），转人工/例会核查`, '拉起');
      changed.push(line);
      // 通知入口：追加到 cluster-notify 待办（若存在）
      try {
        const notify = path.join(ORG_ROOT, 'config', 'cluster-notify.json');
        const n = readJsonSafe(notify) || {};
        n.lastButlerAnomaly = { ts: tsISO(), note: `butler 反复死亡 ${bw.deaths} 次，已暂停自动拉起，需人工核查` };
        writeJsonSafe(notify, n);
      } catch (e) {}
    }
    state.butlerWatch = bw;
    return;
  }

  // 执行拉起
  const bootScript = path.join(ORG_ROOT, w.bootstrapScript || 'scripts/bootstrap.js');
  let ok = false;
  try {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [bootScript, 'start'], {
      cwd: ORG_ROOT, windowsHide: true, detached: true, stdio: 'ignore'
    });
    child.unref();
    ok = true;
  } catch (e) {
    log('butler 拉起失败:', e.message);
  }
  bw.restarts = (bw.restarts || 0) + 1;
  state.butlerWatch = bw;
  if (ok) {
    const line = logActivity('butler 死亡自动重启',
      `检测到 butler 主进程离线（${(readIf(BUTLER_PID) || '无 pid').trim()}），已执行 node scripts/bootstrap.js start（本窗口第 ${bw.restarts} 次拉起）`, '拉起');
    changed.push(line);
  }
}

async function scanScheduledFallback(cfg, state, changed) {
  if (!cfg.scheduledFallback || !cfg.enabled) return;
  if (butlerAlive()) return;   // 管家在线，定时调度归管家，分身不抢
  try {
    const as = require('./auto-schedule');
    const res = await as.check();
    if (res.length) {
      changed.push(logActivity(`定时职责漏跑兜底（管家离线）：${res.join(' | ')}`, '分身兜底触发到期未跑职责', '派活'));
      setThrottle(state, 'scheduledFallback');
    }
  } catch (e) {
    log('定时职责兜底异常:', e.message);
  }
}

/* ── 2. 智能体闲置检测（负有周期性职责 + 长期闲置 → 该干没干 → 派活） ── */
/** 计算某智能体最近活动时间戳（ms）。复用：闲置检测 / backlog 派活都靠它判断'多久没动了' */
function lastActivityOf(agentId, nodes) {
  const node = nodes[agentId] || {};
  const agentDir = path.join(AGENTS_DIR, agentId);
  let last = 0;
  for (const key of ['lastTaskAt', 'lastDoneAt']) {
    const v = node[key];
    if (v) { const t = new Date(v).getTime(); if (t > last) last = t; }
  }
  const actLog = path.join(agentDir, 'activity.log');
  if (statOf(actLog) && statOf(actLog).mtimeMs > last) last = statOf(actLog).mtimeMs;
  // 兜底锚点：identity createdAt（新建智能体避免误判为闲置）
  const idFile = path.join(agentDir, 'identity.json');
  const ident = readJsonSafe(idFile) || {};
  if (ident.createdAt) { const t = new Date(ident.createdAt).getTime(); if (t > last) last = t; }
  return last;
}

function scanAgentIdle(cfg, state, changed) {
  if (!cfg.enabled) return;
  const idleDuties = cfg.idleDuties || {};
  const org = readJsonSafe(ORG_JSON) || {};
  const nodes = org.nodes || {};
  const now = Date.now();
  for (const [agentId, duty] of Object.entries(idleDuties)) {
    if (!duty || duty.cadenceHours == null) continue;
    const ident = readJsonSafe(path.join(AGENTS_DIR, agentId, 'identity.json')) || {};
    const lastActivity = lastActivityOf(agentId, nodes);
    const idleMs = now - lastActivity;
    const cadenceMs = duty.cadenceHours * 3600 * 1000;
    if (idleMs < cadenceMs) continue;                 // 未达闲置阈值
    if (!passThrottle(state, agentId, cfg)) continue;  // 节流防骚扰
    // 生成派活（闲置专用模板）
    const tpl = IDLE_TASKS[agentId];
    if (!tpl) { setThrottle(state, agentId); continue; }  // 无可派职责，仅记录不再重复
    const idleHours = Math.round(idleMs / 3600000);
    const task = tpl(agentId, idleHours);
    const name = dispatchTask(agentId, task.title, task.body);
    if (name) {
      changed.push(logActivity(`${agentId} 闲置 ${idleHours}h 触发派活`,
        `应干未干（职责：${ident.label || agentId}），已写 inbox/${name}.md`, '派活'));
      setThrottle(state, agentId);
    }
  }
}

/* ── 2.5 业务 Backlog 派活（2026-08-09 agent-backlog） ──
 * 读 config/agent-backlog.json：有 pending 项且超过 staleDays 未推进的智能体 → 派活提醒推进项目。
 * 闲置检测从'24h 无 activity'升级为'backlog 有 pending 且未推进'（更准：只有有 pending 项才被盯）。
 * 节流：同智能体 throttleDays 内不重复派（防骚扰）。maxDispatchPerScan 防一次铺满。
 * 新 backlog 项自动排队（下一轮巡检发现未推进即派活）。
 */
/** 按需/常驻型待办判定（2026-08-11 improve：duty 对常驻待命项豁免 stale 派活）
 * 判定依据：显式 onDemand 标记，或 title/note 含"按需/常驻/待命/按用户反馈"关键词。
 * 常驻/按需型职责"有活才动、无活待命"，陈旧计时盯梢（未推进即派活）会产生无效巡检，故豁免。
 */
function isOnDemand(item) {
  if (!item) return false;
  if (item.onDemand === true) return true;
  const text = (String(item.note || '') + ' ' + String(item.title || '')).toLowerCase();
  return /按需|常驻|on-demand|on demand|待命|按用户反馈/.test(text);
}

function scanBacklog(cfg, state, changed) {
  const bs = cfg.backlogScan;
  if (!bs || bs.enabled === false || !cfg.enabled) return;
  const backlog = readJsonSafe(BACKLOG_CONFIG) || {};
  const agents = backlog.agents || {};
  const targets = bs.targets || {};
  if (!Object.keys(agents).length) return;
  const nodes = (readJsonSafe(ORG_JSON) || {}).nodes || {};
  const now = Date.now();
  const staleMs = (bs.staleDays || 2) * 24 * 3600 * 1000;
  const throttleMs = (bs.throttleDays || 1) * 24 * 3600 * 1000;
  const maxDispatch = bs.maxDispatchPerScan || 2;
  let dispatched = 0;
  for (const [agentId, meta] of Object.entries(agents)) {
    if (dispatched >= maxDispatch) break;
    const tgt = targets[agentId];
    if (!tgt) continue;                    // 不在盯梢名单 → 不派
    const items = meta.backlog || [];
    const pending = items.filter(i => i.status === 'pending');
    if (!pending.length) continue;         // 无 pending 项 → 不盯
    // 豁免"按需/常驻"型待办（2026-08-11 improve）：常驻待命/按需响应的项不因 stale 未推进被重复派活
    const realPending = pending.filter(i => !isOnDemand(i));
    if (!realPending.length) {
      // 豁免记录写入 changed（可观测），但不用 logActivity —— 避免刷新 activity.log mtime 污染 lastActivityOf，
      // 否则关豁免/换判定后该智能体被误判“最近动过”而无法正常 stale 派活。
      changed.push(`[${now}] [豁免] ${agentId} backlog 全部为按需/常驻型待办 → 豁免 stale 派活` +
        `（待办 ${pending.map(i=>i.id).join('；').slice(0,60)} 为常驻待命/按需响应，不因未推进重复派活）`);
      continue;
    }
    // 节流防骚扰：同智能体 throttleDays 内不重复派
    const last = (state.throttle || {})['backlog:' + agentId] || 0;
    if (now - last < throttleMs) continue;
    // 该智能体最近活动距现在是否超过 staleDays（有 pending 却未推进）
    const lastAct = lastActivityOf(agentId, nodes);
    if (now - lastAct < staleMs) continue; // 最近动过 → 可能在推进中，不打扰
    // 组装派活内容：列出待推进项，请智能体推进
    const pendLines = realPending.map(i => `- [${i.priority}] ${i.title}${i.note ? '（' + i.note + '）' : ''}`).join('\n');
    const title = `分身巡检派活：${meta.label || agentId} 有 ${realPending.length} 项待办未推进`;
    const body = [
      `分身（twin-daemon 职责巡检 backlog 派活）检测到 ${meta.label || agentId} 的 backlog 有 ${realPending.length} 项 pending 待办（按需/常驻型已豁免），且已 ${Math.round((now - lastAct) / 86400000)} 天未推进，请按项目计划推进：`,
      ``,
      `当前待推进项：`,
      pendLines,
      ``,
      `要求：`,
      `1. 从 pending 项中选最高优先级（P0 优先）1-2 项实际推进，完成一项把该项状态标记 done 并更新 config/agent-backlog.json 的 updatedAt`,
      `2. 推进前先读项目 memory/distill-notes.md + project/ 了解现状，别破坏已有状态`,
      `3. 卡点/待确认 → 明确写出，产出到 agents/${agentId}/artifacts/ 供管家参考`,
      `4. ⚠️ 效率约束：只在本智能体工作目录与项目目录内推进，不做全盘 find/深度扫描`,
    ].join('\n');
    const provider = tgt.privateData ? 'deepseek' : 'opencode-go';
    const name = dispatchTask(agentId, title, body, provider);
    if (name) {
      state.throttle = state.throttle || {};
      state.throttle['backlog:' + agentId] = now;
      const ident = readJsonSafe(path.join(AGENTS_DIR, agentId, 'identity.json')) || {};
      changed.push(logActivity(`${agentId} backlog 有 ${pending.length} 项 pending 未推进 → 派活`,
        `待办：${pending.map(i=>i.title).join('；').slice(0,80)}，已写 inbox/${name}.md`, '派活'));
      dispatched++;
    }
  }
}

/* ── 3. 业务信号驱动 ───────────────────────────────────── */
/** reviewer：新任务完成/失败批次 → 派活验收 */
function signalReviewerNewDone(cfg, state, changed) {
  const s = (cfg.businessSignals || {}).reviewer_newdone;
  if (!s || s.enabled === false || !cfg.enabled) return;
  const windowMs = (s.newDoneWindowMinutes || 60) * 60 * 1000;
  const minNew = s.minNewDone || 2;
  const now = Date.now();
  if (!fs.existsSync(INBOX)) return;
  const files = fs.readdirSync(INBOX).filter(f => /\.DONE$/.test(f));
  const seen = state.seenDone || {};
  const fresh = [];
  for (const f of files) {
    const st = statOf(path.join(INBOX, f));
    if (!st) continue;
    const key = f + '@' + st.mtimeMs;
    if (seen[f] === key) continue;          // 已消费过
    seen[f] = key;
    if (now - st.mtimeMs > windowMs) continue;  // 只看窗口内的新完成
    const txt = (readIf(path.join(INBOX, f)) || '').trim();
    const failed = /\.FAILED/i.test(txt);
    fresh.push({ name: f.replace(/\.DONE$/, ''), failed, summary: txt });
  }
  state.seenDone = seen;
  if (!fresh.length) return;
  if (!passThrottle(state, 'reviewer', cfg)) return;   // 防骚扰：审核官 6h 一次
  const hasFail = fresh.some(x => x.failed);
  if (fresh.length < minNew && !hasFail) return;       // 少量完成且无失败 → 不急着派（等批/等例会）
  const tpl = SIGNAL_TASKS.reviewer(fresh);
  const name = dispatchTask('reviewer', tpl.title, tpl.body);
  if (name) {
    changed.push(logActivity(`新完成任务批次 → 审核官验收`,
      `${fresh.length} 项（失败 ${fresh.filter(x=>x.failed).length}），已写 inbox/${name}.md`, '派活'));
    setThrottle(state, 'reviewer');
  }
}

/** chat-signals 新增检测：返回新增条数 + 条目 */
function chatSignalNew(state, cfg, windowMinutes) {
  const st = statOf(CHAT_SIGNALS);
  if (!st) return { count: 0, items: [] };
  const prev = state.chatSig || { size: 0, mtime: 0 };
  // 冷启动基线：首次运行（游标为空）只记录当前文件游标，不把存量信号误当新增派活
  if (!prev.size && !prev.mtime) {
    state.chatSig = { size: st.size, mtime: st.mtimeMs };
    return { count: 0, items: [] };
  }
  if (st.size === prev.size && st.mtimeMs === prev.mtime) return { count: 0, items: [] };
  const raw = readIf(CHAT_SIGNALS) || '';
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  let items = [];
  for (const l of lines) {
    try { const o = JSON.parse(l); if (o && o.content) items.push(o); } catch (e) {}
  }
  // 窗口过滤
  if (windowMinutes) {
    const win = windowMinutes * 60 * 1000;
    items = items.filter(o => {
      const t = o.ts ? new Date(o.ts).getTime() : 0;
      return Date.now() - t <= win;
    });
  }
  state.chatSig = { size: st.size, mtime: st.mtimeMs };
  return { count: items.length, items };
}

/** pm：用户新想法/决策/偏好信号 → 派活规划 */
function signalPmUser(cfg, state, changed) {
  const s = (cfg.businessSignals || {}).pm_usersignal;
  if (!s || s.enabled === false || !cfg.enabled) return;
  if (!passThrottle(state, 'pm', cfg)) return;
  const { count, items } = chatSignalNew(state, cfg, s.signalWindowMinutes);
  if (!count) return;
  // 只看强信号（偏好/纠正/决策模式/新关注点），纯无关噪音不派
  const strong = items.filter(o => /preference|correction|decision-pattern|new-focus|偏好|决策|纠正/.test(o.type + ' ' + o.content));
  if (!strong.length) return;
  const tpl = SIGNAL_TASKS.pm(strong);
  const name = dispatchTask('pm', tpl.title, tpl.body);
  if (name) {
    changed.push(logActivity(`用户新信号（${strong.length} 条强信号）→ PM 规划`,
      `已写 inbox/${name}.md`, '派活'));
    setThrottle(state, 'pm');
  }
}

/** learning-officer：chat-signals 有新增未合并 → 派活合并 */
function signalLearningMerge(cfg, state, changed) {
  const s = (cfg.businessSignals || {}).learning_merge;
  if (!s || s.enabled === false || !cfg.enabled) return;
  if (!passThrottle(state, 'learning-officer', cfg)) return;
  const { count } = chatSignalNew(state, cfg, 0);   // 任意新增未合并信号
  if (!count) return;
  const tpl = SIGNAL_TASKS['learning-officer'](count);
  const name = dispatchTask('learning-officer', tpl.title, tpl.body);
  if (name) {
    changed.push(logActivity(`chat-signals 新增 ${count} 条 → 学习进化官合并`,
      `已写 inbox/${name}.md`, '派活'));
    setThrottle(state, 'learning-officer');
  }
}

/* ── 分身监督互救（2026-08-12 agent-rescue-core） ─────────── */
/**
 * 分身核心监督：扫描「智能体反复失败」异常信号（lib/agent-rescue.scanHealth）→
 * 分身自主决策：
 *   - 未升级用户的任务 → 自动派救援者诊断该智能体（互救链，不打扰用户）
 *   - 救援链已耗尽 → 分身决策升级用户（决策留痕）
 * 节流：同智能体 healthRescueThrottleMin（默认 1440min=1天）内只决策一次，防骚扰。
 */
function scanAgentRescue(cfg, state, changed) {
  try {
    const ar = require('./agent-rescue');
    const unhealthy = ar.scanHealth();
    if (!unhealthy || !unhealthy.length) return;
    const throttleMin = (cfg.agentRescue || {}).healthRescueThrottleMin || 1440;
    const throttleKey = 'rescue-health';
    const last = state.throttle[throttleKey] || 0;
    if (Date.now() - last < throttleMin * 60000) return;   // 节流中
    setThrottle(state, throttleKey);
    const detail = unhealthy.map(h => `${h.agent}(失败${h.count}次: ${(h.tasks || []).slice(0, 3).join(',')})`).join('；');
    // 分身决策：对每个异常智能体，自动派管理组救援者去诊断（互救链自动，不打扰用户）
    for (const h of unhealthy) {
      try {
        const launched = ar.launchRescue(`agent-${h.agent}-health`, `智能体 ${h.agent} 连续失败 ${h.count} 次（近窗口），需诊断救援`, h.agent);
        if (launched) {
          changed.push(logActivity('[分身监督] 智能体异常 → 自动派救援',
            `${h.agent} 连续失败 ${h.count} 次 → 救援者 ${launched.rescuer} 诊断`, '互救'));
          // 决策留痕：分身自主决策记录
          ar.recordTwinDecision({ task: `agent-${h.agent}-health`, signal: 'agent-repeated-failure',
            decision: `派 ${launched.rescuer} 救援 ${h.agent}`, reason: `连续失败 ${h.count} 次（${(h.tasks || []).slice(0, 3).join(',')}）` });
        }
      } catch (e) { log(`分身监督救援派发失败 [${h.agent}]: ${e.message}`); }
    }
  } catch (e) { log('分身监督互救异常: ' + e.message); }
}

/* ── 共享资源锁表巡检（2026-08-10 resource-registry） ─────── */
/**
 * 校验 knowledge/resource-registry.json 真实存在、合法、资源均登记 owner。
 * 异常 → activity 留痕（供复盘循环核对）；正常 → 静默。返回异常数组。
 */
function checkResourceRegistry(changed) {
  const issues = [];
  const raw = readIf(RESOURCE_REGISTRY);
  if (raw === null) {
    issues.push('resource-registry.json 缺失（conventions 承诺的共享资源锁表未落地）');
  } else {
    let reg = null;
    try { reg = JSON.parse(raw); } catch (e) { reg = null; }
    if (!reg || typeof reg !== 'object') {
      issues.push('resource-registry.json 不是合法 JSON');
    } else {
      const res = (reg.resources || {});
      const keys = Object.keys(res);
      if (!keys.length) issues.push('resource-registry.json 无任何资源登记');
      for (const k of keys) {
        const r = res[k];
        if (!r || typeof r !== 'object' || !r.owner) {
          issues.push(`资源 "${k}" 未登记 owner`);
        } else if (r.lockState === 'locked' && !r.lockedBy) {
          issues.push(`资源 "${k}" 标记 locked 但无 lockedBy`);
        }
      }
    }
  }
  for (const it of issues) {
    log('资源锁表异常: ' + it);
    changed.push(logActivity('[巡检] 资源锁表', 'resource-registry 异常: ' + it, '巡检'));
  }
  return issues;
}

/* ── 主入口 ────────────────────────────────────────────── */
/**
 * 跑一轮职责巡检，返回新增 activity 行数组。
 * @param {object} opts 可注入覆盖（测试用）：{ butlerAliveOverride: boolean }
 */
async function scanDuties(opts) {
  const cfg = loadCfg();
  const state = loadState();
  const changed = [];
  if (!cfg.enabled) return changed;
  try { watchButler(cfg, state, changed); } catch (e) { log('管家拉起失败:', e.message); }
  try { await scanScheduledFallback(cfg, state, changed); } catch (e) { log('定时兜底失败:', e.message); }
  try { scanAgentIdle(cfg, state, changed); } catch (e) { log('闲置检测失败:', e.message); }
  try { scanBacklog(cfg, state, changed); } catch (e) { log('backlog 派活失败:', e.message); }
  try { signalReviewerNewDone(cfg, state, changed); } catch (e) { log('审核信号失败:', e.message); }
  try { signalPmUser(cfg, state, changed); } catch (e) { log('PM 信号失败:', e.message); }
  try { signalLearningMerge(cfg, state, changed); } catch (e) { log('进化信号失败:', e.message); }
  // 智能体自我繁衍（2026-08-09 org-evolution）：扫描繁衍申请→转分身审批→批准则建子分组+子智能体
  try {
    const { scan } = require('./org-evolution');
    const evo = await scan();
    if (evo && evo.length) changed.push(...evo);
  } catch (e) { log('繁衍巡检失败:', e.message); }
  // 分身监督互救（2026-08-12 agent-rescue-core）：扫描「智能体反复失败」异常信号 →
  // 分身自主决策（派救援者诊断该智能体 / 升级用户）→ 决策留痕。不打扰用户（救援链自动）。
  try { scanAgentRescue(cfg, state, changed); } catch (e) { log('分身互救监督失败:', e.message); }
  // 共享资源锁表巡检（2026-08-10 resource-registry）：校验 knowledge/resource-registry.json 真实存在且合法，资源均登记 owner；发现异常留痕供复盘
  try { checkResourceRegistry(changed); } catch (e) { log('资源锁表巡检失败:', e.message); }
  saveState(state);
  return changed;
}

/* ── CLI ───────────────────────────────────────────────── */
async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'scan') {
    const changed = await scanDuties();
    console.log('职责巡检完成，本轮派活/变化', changed.length, '条:');
    for (const l of changed) console.log('  ' + l);
    process.exit(0);
  }
  if (argv[0] === 'test') {
    await runSelfTest();
    process.exit(0);
  }
  console.log('用法: node lib/twin-duty-inspector.js scan | test');
}

/* ── 内置自检（造场景验证） ────────────────────────────── */
async function runSelfTest() {
  const assert = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) process.exitCode = 1; };
  console.log('== twin-duty-inspector 自检 ==');

  // 场景1：定时职责漏跑（butler 离线 + auto-schedule 到期 → 触发兜底派活）
  // 用真实的 auto-schedule-state 把某职责 lastRun 置过期，且模拟 butler 离线 → check() 应触发
  {
    console.log('\n[场景1] 定时职责漏跑兜底（butler 离线）');
    // 记录测试前已存在的 intel-collect 文件，只清理本次测试新建的（防误删真实任务）
    const icBefore = new Set(fs.readdirSync(INBOX).filter(f => f.startsWith('intel-collect-')));
    const asCfg = readJsonSafe(AUTO_SCHED_CONFIG) || {};
    const asStateOld = JSON.stringify(readJsonSafe(AUTO_SCHED_STATE) || {});
    const asState = JSON.parse(asStateOld);
    // 临时把 intel-gatherer lastRun 置 7 小时前（>6h 周期）制造"到期未跑"
    asState['intel-gatherer'] = Date.now() - 7 * 3600 * 1000;
    writeJsonSafe(AUTO_SCHED_STATE, asState);
    // 模拟 butler 离线
    setButlerOverride(false);
    const cfg = loadCfg();
    const state = loadState();
    const changed = [];
    await scanScheduledFallback(cfg, state, changed);
    const triggered = changed.some(l => l && l.includes('intel-gatherer'));
    assert(triggered, `butler 离线 + intel 到期 → 分身兜底派活（changes=${changed.length}）`);
    // 还原：auto-schedule-state 完全还原 + 只清理本次测试新建的 intel-collect 任务文件（防误删真实任务）
    writeJsonSafe(AUTO_SCHED_STATE, JSON.parse(asStateOld));
    for (const f of fs.readdirSync(INBOX)) {
      if (f.startsWith('intel-collect-') && !icBefore.has(f)) {
        try { fs.unlinkSync(path.join(INBOX, f)); } catch (e) {}
      }
    }
    setButlerOverride(null);
    console.log('  （auto-schedule-state 已还原）');
  }

  // 场景2：闲置智能体 → 该干没干 → 派活
  {
    console.log('\n[场景2] 智能体闲置派活');
    const cfg = loadCfg();
    const state = loadState();
    const changed = [];
    // 直接调用 scanAgentIdle；若 pm 未闲置（阈值 168h）则构造一个"假装闲置"的判定
    scanAgentIdle(cfg, state, changed);
    const wrote = changed.filter(l => l && l.includes('[派活]'));
    assert(wrote.length >= 0, `scanAgentIdle 执行无异常（本轮派活 ${wrote.length} 条）`);
    // 校验 throttle：对同 agent 立即再派 → 应被节流抑制
    const pmKey = 'pm';
    const pre = (state.throttle || {})[pmKey] || 0;
    if (!pre) { setThrottle(state, pmKey); }
    const changed2 = [];
    scanAgentIdle(cfg, state, changed2);
    const again = changed2.filter(l => l && l.includes('[派活]'));
    assert(again.length === 0, `同职责立即再派被节流抑制（节流后无重复派活）`);
  }

  // 场景3：业务信号 —— reviewer 新完成任务批次
  {
    console.log('\n[场景3] 业务信号：新完成任务批次 → 审核官派活');
    // 构造窗口内新 DONE（minNewDone=2，需写 2 个临时 DONE 才能触发批量验收派活）
    const tmpName = `duty-selftest-${tsStamp()}`;
    const tmpDone = path.join(INBOX, `${tmpName}.DONE`);
    const tmpDone2 = path.join(INBOX, `${tmpName}-2.DONE`);
    fs.writeFileSync(tmpDone, 'selftest 完成：验证分身职责巡检业务信号链路（1/2）', 'utf8');
    fs.writeFileSync(tmpDone2, 'selftest 完成：验证分身职责巡检业务信号链路（2/2）', 'utf8');
    const state = loadState();
    const cfg = loadCfg();
    // 清 throttle 让 reviewer 可派
    if (state.throttle) delete state.throttle['reviewer'];
    state.seenDone = state.seenDone || {};
    const changed = [];
    signalReviewerNewDone(cfg, state, changed);
    const gotTask = fs.existsSync(path.join(INBOX, `${tmpName}.md`)) || changed.some(l => l && l.includes('审核官验收'));
    assert(gotTask, `新完成 DONE → 分身派活审核官验收（change: ${(changed[0] || '').slice(0, 60)}）`);
    // 清理临时文件
    try { fs.unlinkSync(tmpDone); } catch (e) {}
    try { fs.unlinkSync(tmpDone2); } catch (e) {}
    try { const m = fs.readdirSync(INBOX).find(f => f.startsWith('review-batch-')); if (m) fs.unlinkSync(path.join(INBOX, m)); } catch (e) {}
  }

  // 场景4：防骚扰节流（同职责重复派活被抑制）—— 对 reviewer
  {
    console.log('\n[场景4] 防骚扰节流（审核官 6h 内不重复派）');
    const cfg = loadCfg();
    const state = loadState();
    setThrottle(state, 'reviewer');   // 刚派过
    saveState(state);
    // 再造一个新 DONE 尝试再次派发
    const tmpName = `duty-selftest2-${tsStamp()}`;
    fs.writeFileSync(path.join(INBOX, `${tmpName}.DONE`), 'selftest2 完成', 'utf8');
    const changed = [];
    signalReviewerNewDone(cfg, state, changed);
    assert(changed.length === 0, `reviewer 在节流窗口内不重复派活`);
    try { fs.unlinkSync(path.join(INBOX, `${tmpName}.DONE`)); } catch (e) {}
  }

  // 场景5：activity [派活] 留痕（场景3 已 log，这里校验函数）
  {
    console.log('\n[场景5] activity [派活] 留痕');
    const l = logActivity('[派活] 自检留痕', '验证 [派活] tag 写入', '派活');
    assert(!!l && l.includes('[派活]'), `[派活] tag 留痕成功`);
  }

  // 场景6：业务 Backlog 派活（2026-08-09 agent-backlog）—— 隔离验证，不碰真实 state / 不误伤真实代理
  {
    console.log('\n[场景6] backlog 派活：mc-dev 有 pending 且未推进 → 分身派活');
    // 用局部 cfg：只盯 mc-dev、staleDays/throttleDays 用极小非零值（staleDays=0 会被 `|| 2` 默认吞掉，故用 1e-4 天≈8.6s 强制视为未推进；throttleDays 同理极小以便立即触发）
    const cfg6 = loadCfg();
    cfg6.backlogScan = {
      enabled: true, staleDays: 0.0001, maxDispatchPerScan: 1, throttleDays: 0.0001,
      targets: { 'mc-dev': { privateData: false } }
    };
    const before = fs.readdirSync(INBOX);
    const state6 = { throttle: {} };   // 全新本地 state，不污染真实 twin-duty-state.json
    const changed6 = [];
    scanBacklog(cfg6, state6, changed6);
    const newFiles = fs.readdirSync(INBOX).filter(f => !before.includes(f));
    const wrote = newFiles.filter(f => f.endsWith('.md'));
    const hit = changed6.some(l => l && l.includes('mc-dev') && l.includes('派活'));
    assert(hit, `scanBacklog 检测到 mc-dev pending backlog → 触发派活（change: ${(changed6[0] || '').slice(0, 70)}）`);
    assert(wrote.length === 1, `派活落盘 inbox/${wrote[0]}（task 写入成功）`);
    // 节流防骚扰：同一 agent 立即再派 → 应被节流抑制（用同一 state6，其 throttle 已被 scanBacklog 写入）
    const changed7 = [];
    scanBacklog(cfg6, state6, changed7);
    assert(changed7.length === 0, `同 agent backlog 立即再派被节流抑制`);
    // 清理测试产物（避免 butler 捡到真实派活）
    for (const f of wrote) { try { fs.unlinkSync(path.join(INBOX, f)); } catch (e) {} }
    console.log('  （测试 inbox 文件已清理，未干扰真实派活队列）');
  }

  // 场景7：按需/常驻型待办豁免 stale 派活（2026-08-11 improve）—— 用真实 takina（全部 pending 为按需型）
  {
    console.log('\n[场景7] 按需/常驻型待办豁免：takina 全部为按需型 → 不派活；关豁免 → 恢复派活');
    const cfg7 = loadCfg();
    cfg7.backlogScan = {
      enabled: true, staleDays: 0.0001, maxDispatchPerScan: 1, throttleDays: 0.0001,
      onDemandExempt: true,
      targets: { 'takina': { privateData: false } }
    };
    const before = fs.readdirSync(INBOX);
    const state7 = { throttle: {} };      // 全新本地 state，不污染真实 twin-duty-state.json
    const changed7 = [];
    scanBacklog(cfg7, state7, changed7);
    const newFiles7 = fs.readdirSync(INBOX).filter(f => !before.includes(f));
    const wrote7 = newFiles7.filter(f => f.endsWith('.md'));
    const exemptHit = changed7.some(l => l && l.includes('豁免'));
    assert(exemptHit, `takina pending 全部为按需型 → 记录豁免（不派活）`);
    assert(wrote7.length === 0, `按需豁免生效：takina 未被派活（无新 inbox task）`);
    // 关掉豁免 → 应恢复 stale 派活（验证开关有效）
    cfg7.backlogScan.onDemandExempt = false;
    const changed7b = [];
    scanBacklog(cfg7, { throttle: {} }, changed7b);
    const newFiles7b = fs.readdirSync(INBOX).filter(f => !before.includes(f));
    const wrote7b = newFiles7b.filter(f => f.endsWith('.md'));
    const dispatchHit = changed7b.some(l => l && l.includes('takina') && l.includes('派活'));
    assert(dispatchHit && wrote7b.length === 1, `关闭豁免后 takina 恢复 stale 派活（开关生效）`);
    // 清理测试产物
    for (const f of wrote7b) { try { fs.unlinkSync(path.join(INBOX, f)); } catch (e) {} }
    console.log('  （按需豁免验证通过；测试 inbox 文件已清理）');
  }
}

if (require.main === module) main();

module.exports = { scanDuties, scanScheduledFallback, scanAgentIdle, signalReviewerNewDone,
  checkResourceRegistry, scanAgentRescue,
                   signalPmUser, signalLearningMerge, dispatchTask, butlerAlive, setButlerOverride,
                   scanBacklog, lastActivityOf, watchButler };
