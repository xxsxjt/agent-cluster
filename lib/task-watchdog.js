#!/usr/bin/env node
/**
 * lib/task-watchdog.js — 长任务定时自检反馈机制（2026-08-09 task-watchdog）
 *
 * 痛点来源（用户 2026-08-09 21:3x）："我想让它们这些长时间的工作定时自检反馈……我试过几次，
 * 说完之后它就当放屁，感觉没有东西去执行"——口头要求无用，必须机制化。
 * 本模块由 butler 主进程主动看护长任务，定时强制智能体汇报进度——**不依赖智能体"记得"**。
 *
 * 职责：
 *   1. 长任务识别：butler 活动表（logs/active-tasks.json）中运行超过 watchAfterMin(默认30)分钟的任务进入看护
 *   2. 看护循环（每 checkIntervalMin=5 分钟）：
 *      - 读任务日志 logs/<task>.log 最后活动时间（mtime）
 *      - 连续 silentThresholdMin(默认10)分钟无新输出（卡住/静默）→ 自动生成进度询问：
 *        写 inbox/checkpoint-<task>-<stamp>.md（问进度/卡点/预计完成，要求 replyDeadlineMin=3 分钟内回复）
 *      - 智能体回复写入 logs/<task>.progress.jsonl（时间/进度/卡点/剩余/eta，一行一条 JSON）
 *   3. 定期主动汇报：任务运行满 progressNodesMin=[30,60,120,240] 分钟节点 → 自动触发一次进度汇报（不等卡住才问）
 *   4. 汇报汇总：进度记录汇总到 activity（分身巡查可见）；长任务完成时把进度链附在 .DONE 摘要里
 *
 * 配置：org/config/task-watchdog.json（改即生效，每次 check 重读表）
 * 状态：org/logs/task-watchdog-state.json（各任务 lastNodeFired / lastCheckpointAt / 进度链落盘游标）
 *
 * 与 task-auto-recovery 分工（避免重叠）：
 *   - 本模块管"汇报"：记录进度/卡点，让分身和管家"看得见"长任务在干嘛
 *   - 异常恢复管"重启"：卡死判定（日志停滞 20min / pid 死）→ 强制结束 + 恢复决策，由 butler.checkActive 负责
 *   - 静默询问阈值(10min) < 卡死判定(20min)：看护先问，若智能体被问后恢复输出则避免误杀；仍未恢复才走恢复链
 *
 * 用法：
 *   node lib/task-watchdog.js check                    # 跑一轮看护（butler 每 5 分钟调）
 *   node lib/task-watchdog.js --cfg <path> check       # 用指定配置文件跑一轮（测试用）
 *   node lib/task-watchdog.js self-test                # 内置自检（造模拟长任务验证节点+静默+回复+落盘）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ORG_ROOT   = path.join(__dirname, '..');
const CONFIG     = path.join(ORG_ROOT, 'config', 'task-watchdog.json');
const STATE_FILE = path.join(ORG_ROOT, 'logs', 'task-watchdog-state.json');
const ACTIVE_FILE= path.join(ORG_ROOT, 'logs', 'active-tasks.json');
const INBOX      = path.join(ORG_ROOT, 'inbox');
const LOGS       = path.join(ORG_ROOT, 'logs');

const { logActivity } = require('./twin-log');

const readIf  = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const readJsonSafe = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const writeJsonSafe = (p, o) => { try { fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8'); } catch (e) {} };
const ensure = d => fs.mkdirSync(d, { recursive: true });
const tsISO  = () => new Date().toISOString();
function tsStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function log(...a) {
  const line = `[${new Date().toLocaleTimeString()}] [task-watchdog] ${a.join(' ')}`;
  console.log(line);
  // 注意：不用 task-watchdog.log（可能撞名某个名为 task-watchdog 的 butler 任务日志，会互相污染）→ 用独立 watchdog 日志名
  try { ensure(LOGS); fs.appendFileSync(path.join(LOGS, 'task-watchdog-watcher.log'), line + '\n', 'utf8'); } catch (e) {}
}

function loadCfg(cfgPath) {
  const def = {
    enabled: true,
    watchAfterMin: 30,          // 任务运行超过此分钟进入看护
    checkIntervalMin: 5,        // 看护循环间隔（butler 实际调度用；check 自身幂等不受此限）
    silentThresholdMin: 10,     // 连续无日志输出超过此分钟 → 判定静默，主动询问
    silentRecheckMin: 15,       // 同一任务静默询问后最小重问间隔（防骚扰）
    replyDeadlineMin: 3,        // 要求智能体回复时限（写进 prompt）
    progressNodesMin: [30, 60, 120, 240],   // 定期主动汇报节点（运行分钟）
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
    thinking: 'off',
    // 隐私铁律：这些智能体处理用户偏好/隐私数据，其 checkpoint 询问路由 deepseek 官方渠道（不进第三方）
    privateAgents: ['pm', 'reviewer', 'intel-gatherer', 'learning-officer', 'channel-manager', 'twin', 'coo'],
    // 永不进入看护的任务前缀（控制/自动派发类，避免看护 checkpoint 自身、例会、验收等）
    excludePrefixes: ['checkpoint-', 'daily-meeting-', 'review-', 'intel-collect-', 'improve-', 'decision-']
  };
  try { return Object.assign(def, readJsonSafe(cfgPath || CONFIG)); }
  catch (e) { return def; }
}
function loadState(statePath) {
  const s = readJsonSafe(statePath || STATE_FILE) || {};
  if (!s.tasks || typeof s.tasks !== 'object') s.tasks = {};   // 兜底：老/空状态文件必有 tasks 对象
  return s;
}
function saveState(s, statePath) { ensure(LOGS); writeJsonSafe(statePath || STATE_FILE, s); }

/** 读 butler 持久化的活动任务表（实时）。返回 {name: {agentId, pid, startedAt, ...}} */
function readActive() {
  const d = readJsonSafe(ACTIVE_FILE);
  return d && typeof d === 'object' ? d : {};
}

/** 是否应进入看护的任务名（排除控制类） */
function isWatchableTask(name, cfg) {
  const pre = cfg.excludePrefixes || [];
  return !pre.some(p => name.startsWith(p));
}

/** 任务日志路径 */
function taskLogPath(name) { return path.join(LOGS, `${name}.log`); }
function progressPath(name) { return path.join(LOGS, `${name}.progress.jsonl`); }

/** 日志最后活动年龄（ms）。日志不存在 → 用任务运行时长（视为刚有活动，避免误判静默） */
function logIdleMs(name, startedAtMs) {
  const lp = taskLogPath(name);
  try {
    const st = fs.statSync(lp);
    return Date.now() - st.mtimeMs;
  } catch (e) {
    return Date.now() - (startedAtMs || Date.now());
  }
}

/** 读任务进度链（JSONL） */
function readProgress(name) {
  const p = progressPath(name);
  const raw = readIf(p) || '';
  const rows = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch (e) { rows.push({ ts: tsISO(), raw: line.slice(0, 200) }); }
  }
  return rows;
}

/** 追加一条进度记录到 logs/<task>.progress.jsonl */
function appendProgress(name, rec) {
  const p = progressPath(name);
  ensure(LOGS);
  const line = Object.assign({ ts: tsISO() }, rec);
  fs.appendFileSync(p, JSON.stringify(line) + '\n', 'utf8');
  return line;
}

/** 隐私路由：隐私智能体 → deepseek 官方渠道 */
function pickProvider(agentId, cfg) {
  const priv = (cfg.privateAgents || []).includes(agentId);
  return priv ? 'deepseek' : (cfg.provider || 'opencode-go');
}

/**
 * 投递一次进度询问：写 inbox/checkpoint-<task>-<stamp>.md
 * （butler 会自动捡起，spawn 轻量 flash 会话读取源任务+日志后回报进度）
 */
function dispatchCheckpoint(taskName, agentId, reason, cfg, startedAtMs, tag) {
  const stamp = tsStamp();
  const taskFile = `checkpoint-${taskName}-${stamp}-${tag || 'ask'}`;
  const donePath = path.join(INBOX, `${taskFile}.DONE`);
  if (readIf(path.join(INBOX, `${taskFile}.md`))) return null;   // 已在队列（幂等）
  const provider = pickProvider(agentId, cfg);
  const priv = (cfg.privateAgents || []).includes(agentId);
  const runningMin = startedAtMs ? Math.max(0, Math.round((Date.now() - startedAtMs) / 60000)) : '?';
  const content = [
    `agent: ${agentId}`,
    `provider: ${provider}`,
    `model: ${cfg.model || 'deepseek-v4-flash'}`,
    `thinking: ${cfg.thinking || 'off'}`,
    ``,
    `# 进度汇报请求：任务 ${taskName}（长任务看护）`,
    ``,
    `这是 butler 任务看护自动发起的进度询问（原因：${reason}），不是新任务。请**轻量快速**回答，${cfg.replyDeadlineMin || 3} 分钟内完成，不要展开做事。`,
    ``,
    `## 你要做的（只读 + 汇报，不执行任何修改）`,
    `1. 读源任务定义：inbox/${taskName}.md（了解它本该做什么）`,
    `2. 读任务执行日志（客观进度证据）：logs/${taskName}.log 的最后一段输出（tail 即可，不必全文）`,
    `3. 综合源任务 + 日志，给出一次**进度快照**汇报`,
    ``,
    `## 汇报格式（关键：追加到进度文件，一行一条 JSON）`,
    `把以下字段作为一行 JSON 追加到文件末尾：logs/${taskName}.progress.jsonl`,
    ``,
    `{"task":"${taskName}","source":"checkpoint","progress":"当前进度(已完成什么/进行到哪，基于日志客观描述)","blockers":"卡点(无则写'无')","remaining":"剩余工作","eta":"预计完成(如'约30分钟后'或'不确定')"}`,
    ``,
    `## 要求`,
    `1. 进度基于 logs/${taskName}.log 真实输出描述，不编造；日志静止就如实写"日志自 xx 起无新输出，疑似停滞"`,
    `2. 若任务明显卡死/失败（日志长时间无进展或报错），在 blockers 里明确标注"疑似停滞/失败"，供分身看护处理`,
    `3. ${priv ? '⚠️ 该任务可能含隐私数据：汇报只写脱敏概括，不贴原始日志内容' : '汇报只写概括，不贴超长日志原文'}（blockers 单条 ≤60 字）`,
    `4. 汇报完成后写完成标记文件：${donePath}（内容一行摘要即可）`,
    ``,
    `执行要求：轻量执行，${cfg.replyDeadlineMin || 3} 分钟内完成并写标记文件，不做多余动作。`,
    `若无法汇报，写 ${donePath} 内容为 .FAILED: <原因>`,
  ].join('\n');
  ensure(INBOX);
  fs.writeFileSync(path.join(INBOX, `${taskFile}.md`), content, 'utf8');
  log(`📋 看护询问 [${taskName}] → ${agentId}（${reason}，运行 ${runningMin}min）→ inbox/${taskFile}.md 渠道=${provider}${priv ? ' [隐私→deepseek官方]' : ''}`);
  logActivity('[任务看护] 长任务进度询问',
    `${taskName} → ${agentId}（${reason}，运行 ${runningMin}min）`, '任务看护');
  return taskFile;
}

/** 任务完成时，把进度链附到 .DONE 摘要里（幂等：已附过则跳过） */
function appendProgressToDone(name) {
  const donePath = path.join(INBOX, `${name}.DONE`);
  const failedPath = path.join(INBOX, `${name}.FAILED`);
  const marker = readIf(donePath) || readIf(failedPath);
  if (!marker) return false;
  if (/--- 看护进度链/.test(marker)) return true;   // 已附过（幂等）
  const rows = readProgress(name);
  if (!rows.length) return false;
  const chain = rows.map(r => {
    const t = (r.ts || '').slice(11, 19);
    return `  [${t}] ${r.progress || ''}${r.blockers && r.blockers !== '无' ? '｜卡点:' + r.blockers : ''}${r.remaining ? '｜剩余:' + r.remaining : ''}`;
  }).join('\n');
  const append = `\n--- 看护进度链（${rows.length} 条） ---\n${chain}\n`;
  try {
    if (readIf(donePath)) fs.appendFileSync(donePath, append, 'utf8');
    else fs.appendFileSync(failedPath, append, 'utf8');
    log(`🔗 长任务 [${name}] 完成，进度链已附入 .DONE（${rows.length} 条）`);
    return true;
  } catch (e) { log(`附进度链失败 [${name}]: ${e.message}`); return false; }
}

/**
 * 看护主入口：butler 每 checkIntervalMin 调一次。
 * @param {object} opts { cfgPath: '覆盖配置文件路径(测试用)' }
 */
function check(opts) {
  const opt = opts || {};
  const cfg = loadCfg(opt.cfgPath);
  if (!cfg.enabled) { log('task-watchdog 已禁用（config enabled=false）'); return { dispatched: [], completed: [] }; }
  const state = loadState(opt.statePath);
  const now = Date.now();
  const active = readActive();
  const dispatched = [];
  const completed = [];
  const names = Object.keys(active);
  const watchable = names.filter(n => isWatchableTask(n, cfg));

  // 本轮是否触发看护：任务运行 >= watchAfterMin
  for (const name of watchable) {
    const entry = active[name];
    const startedAtMs = entry.startedAt ? new Date(entry.startedAt).getTime() : now;
    const runningMin = (now - startedAtMs) / 60000;
    if (runningMin < (cfg.watchAfterMin || 30)) {
      // 未达看护线：清掉残留 state（若存在且已不再看护），避免状态残留
      if (state.tasks[name]) delete state.tasks[name];
      continue;
    }
    const agentId = entry.agentId || 'coo';
    const st = state.tasks[name] || { lastNodeIdx: -1, lastCheckpointAt: 0, lastSilentAt: 0, lastCheckedAt: 0 };
    // 1) 定期主动汇报节点（30/60/120/240）——到点主动问，不等卡住
    const nodes = (cfg.progressNodesMin || [30, 60, 120, 240]).slice().sort((a, b) => a - b);
    for (let i = 0; i < nodes.length; i++) {
      if (runningMin >= nodes[i] && i > (st.lastNodeIdx || -1)) {
        const t = dispatchCheckpoint(name, agentId, `定期进度汇报（运行 ${Math.round(runningMin)}min ≥ ${nodes[i]}min 节点）`, cfg, startedAtMs, `n${nodes[i]}`);
        if (t) dispatched.push({ task: name, kind: 'node', node: nodes[i], file: t });
        st.lastNodeIdx = i;
        st.lastCheckpointAt = now;
        break;   // 本轮一个任务最多发一个节点汇报
      }
    }
    // 2) 静默检测：日志无新输出 >= silentThresholdMin，且距上次【静默】询问 >= silentRecheckMin
    //    （用独立的 lastSilentAt 节流，不被同轮节点汇报覆盖——节点问完若日志仍静默，仍要再问）
    const idleMs = logIdleMs(name, startedAtMs);
    const idleMin = idleMs / 60000;
    if (idleMin >= (cfg.silentThresholdMin || 10) && (now - (st.lastSilentAt || 0)) >= (cfg.silentRecheckMin || 15) * 60000) {
      const t = dispatchCheckpoint(name, agentId, `连续 ${Math.round(idleMin)}min 无新输出（疑似静默/卡住）`, cfg, startedAtMs, `s${Math.round(idleMin)}`);
      if (t) {
        dispatched.push({ task: name, kind: 'silent', idleMin: Math.round(idleMin), file: t });
        st.lastSilentAt = now;
      }
    }
    st.lastCheckedAt = now;
    state.tasks[name] = st;
  }

  // 完成处理：曾经在看护、但现在不在活动表，且已产生完成标记 → 附进度链
  for (const name of Object.keys(state.tasks || {})) {
    if (active[name]) continue;   // 仍在运行
    const donePath = path.join(INBOX, `${name}.DONE`);
    const failedPath = path.join(INBOX, `${name}.FAILED`);
    if (readIf(donePath) || readIf(failedPath)) {
      if (appendProgressToDone(name)) completed.push(name);
    }
    delete state.tasks[name];   // 结束/消失即移出状态
  }

  saveState(state, opt.statePath);
  if (dispatched.length) log(`本轮看护：派发 ${dispatched.length} 个进度询问` +
    dispatched.map(d => `[${d.task} ${d.kind}${d.node ? '#' + d.node : ''}${d.idleMin ? ' 静默' + d.idleMin + 'min' : ''}]`).join(' '));
  return { dispatched, completed };
}

/* ── 内置自检（造模拟长任务验证：节点汇报 + 静默询问 + 回复落盘 + 完成附链） ── */
function selfTest() {
  const TEST_DIR = path.join(LOGS, '_task-watchdog-test');
  ensure(TEST_DIR);
  const clean = () => { try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (e) {} };

  const cfgPath = path.join(TEST_DIR, 'cfg.json');
  const testStatePath = path.join(TEST_DIR, 'state.json');
  writeJsonSafe(cfgPath, {
    enabled: true, watchAfterMin: 30, silentThresholdMin: 10, silentRecheckMin: 15,
    replyDeadlineMin: 3, progressNodesMin: [30, 60, 120, 240],
    provider: 'opencode-go', model: 'deepseek-v4-flash', thinking: 'off', privateAgents: []
  });

  const FAKE = 'watchdog-self-test-task';
  const fakeActive = path.join(TEST_DIR, 'active-tasks.json');
  const fakeLog = path.join(LOGS, `${FAKE}.log`);
  const fakeProgress = progressPath(FAKE);
  const fakeDone = path.join(INBOX, `${FAKE}.DONE`);
  const now = Date.now();
  writeJsonSafe(fakeActive, {
    [FAKE]: { agentId: 'workspace', pid: 99999, startedAt: new Date(now - 40 * 60000).toISOString(), interjectable: true, channel: 'pi-rpc' }
  });
  // 模拟日志 12 分钟无更新（静默）+ 有历史输出
  ensure(LOGS);
  fs.writeFileSync(fakeLog, '[history] 模拟长任务：初始化\n[history] 阶段1完成\n[history] 阶段2进行中…\n');
  const past = new Date(now - 12 * 60000);
  fs.utimesSync(fakeLog, past, past);
  // 清掉假任务残留（幂等起点）
  try { fs.rmSync(fakeDone, { force: true }); } catch (e) {}
  try { fs.rmSync(fakeProgress, { force: true }); } catch (e) {}
  for (const f of fs.readdirSync(INBOX).filter(x => x.startsWith('checkpoint-' + FAKE))) {
    try { fs.unlinkSync(path.join(INBOX, f)); } catch (e) {}
  }

  // 替换 ACTIVE_FILE 为假表跑 check（隔离，不影响真实 active）
  const realActive = ACTIVE_FILE;
  try { fs.copyFileSync(realActive, path.join(TEST_DIR, 'real-active.json')); } catch (e) {}
  // 备份真实 state
  const realState = readJsonSafe(STATE_FILE) || {};
  const results = [];
  let pass = 0, fail = 0;
  const checkOne = (ok, label) => { results.push((ok ? '✅' : '❌') + ' ' + label); ok ? pass++ : fail++; };

  const origCfgFile = CONFIG;
  try {
    // 注入假 active 表 + 假 config
    writeJsonSafe(ACTIVE_FILE, readJsonSafe(fakeActive) || {});
    const res = check({ cfgPath, statePath: testStatePath });
    // 断言1：30min 节点汇报已派发
    const nodeMd = fs.readdirSync(INBOX).find(f => f.startsWith('checkpoint-' + FAKE) && f.endsWith('.md'));
    checkOne(!!nodeMd && res.dispatched.some(d => d.task === FAKE && d.kind === 'node' && d.node === 30),
      '长任务运行40min ≥ 30min节点 → 主动进度汇报已派发');
    // 断言2：静默询问已派发（12min 无输出 ≥ 10min）
    checkOne(res.dispatched.some(d => d.task === FAKE && d.kind === 'silent' && d.idleMin >= 10),
      '日志连续12min无输出 ≥ 静默阈值10min → 静默询问已派发');
    // 断言3：checkpoint 任务头部路由正确（agent/provider 就位）
    const mdContent = nodeMd ? readIf(path.join(INBOX, nodeMd)) || '' : '';
    checkOne(/agent: workspace/.test(mdContent) && /provider: opencode-go/.test(mdContent),
      'checkpoint 任务头部路由正确（agent=workspace, provider=opencode-go flash）');
    // 断言4：模拟智能体回复 → 追加进度 JSONL
    appendProgress(FAKE, { task: FAKE, source: 'checkpoint', progress: '阶段2完成，阶段3开始', blockers: '无', remaining: '阶段3+验证', eta: '约20分钟后' });
    const rows = readProgress(FAKE);
    checkOne(rows.length === 1 && rows[0].progress === '阶段2完成，阶段3开始',
      '智能体回复已写入 logs/watchdog-self-test-task.progress.jsonl');
    // 断言5：任务完成 → 进度链附入 .DONE
    fs.writeFileSync(fakeDone, '任务完成（模拟摘要）', 'utf8');
    // 现在活动表清空（模拟任务结束）再跑一轮完成处理
    writeJsonSafe(ACTIVE_FILE, {});
    const res2 = check({ cfgPath, statePath: testStatePath });
    const doneTxt = readIf(fakeDone) || '';
    checkOne(/--- 看护进度链/.test(doneTxt) && doneTxt.includes('阶段2完成，阶段3开始'),
      '任务完成 → 进度链已附入 .DONE 摘要');
    // 断言6：任务从 state 移除
    const finalState = readJsonSafe(testStatePath) || {};
    checkOne(!finalState.tasks || !finalState.tasks[FAKE], '完成后任务已移出看护状态');
  } catch (e) {
    checkOne(false, '自检执行异常: ' + e.message);
  } finally {
    // 还原真实 active + state
    try { writeJsonSafe(ACTIVE_FILE, readJsonSafe(path.join(TEST_DIR, 'real-active.json')) || {}); } catch (e) {}
    saveState(realState);
    try { fs.rmSync(testStatePath, { force: true }); } catch (e) {}
    // 清理测试痕迹（假日志/假进度/假DONE/checkpoint文件）
    try { fs.rmSync(fakeLog, { force: true }); } catch (e) {}
    try { fs.rmSync(fakeProgress, { force: true }); } catch (e) {}
    try { fs.rmSync(fakeDone, { force: true }); } catch (e) {}
    try { fs.rmSync(path.join(INBOX, `${FAKE}.md`), { force: true }); } catch (e) {}
    for (const f of fs.readdirSync(INBOX).filter(x => x.startsWith('checkpoint-' + FAKE))) {
      try { fs.unlinkSync(path.join(INBOX, f)); } catch (e) {}
    }
    clean();
  }
  console.log('\n=== task-watchdog 内置自检 ===');
  results.forEach(r => console.log('  ' + r));
  console.log(`结果: ${pass}/${pass + fail} 通过${fail ? '（有失败）' : ''}`);
  process.exit(fail ? 1 : 0);
}

/* ── CLI ─────────────────────────────────────────────── */
function main() {
  const argv = process.argv.slice(2);
  let cfgPath = null;
  const i = argv.indexOf('--cfg');
  if (i >= 0 && argv[i + 1]) { cfgPath = argv[i + 1]; argv.splice(i, 2); }
  if (argv.includes('self-test')) return selfTest();
  const res = check({ cfgPath });
  const parts = [];
  if (res.dispatched.length) parts.push(`派发 ${res.dispatched.length} 询问`);
  if (res.completed.length) parts.push(`附链 ${res.completed.length} 完成`);
  console.log('task-watchdog check 完成 → ' + (parts.length ? parts.join(' | ') : '(本轮无动作)'));
  process.exit(0);
}

if (require.main === module) main();

module.exports = { check, dispatchCheckpoint, appendProgressToDone, readProgress, appendProgress, isWatchableTask };
