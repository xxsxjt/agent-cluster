#!/usr/bin/env node
/**
 * lib/auto-schedule.js — 职责调度表（2026-08-09 auto-schedule）
 *
 * 统一调度三个"建了但从不自动干活"的智能体职责，全部挂在一个入口（butler 主进程每分钟检查本模块）：
 *   1. channel-manager 渠道健康自动巡检（每 30 分钟，inline：读 channel-health.json → 冷却渠道恢复探测 → 留痕）
 *   2. intel-gatherer 信息搜集官自动收集（每 6 小时，dispatch：写 inbox/intel-collect-<ts>.md 自动派发）
 *   3. reviewer 审核官自动验收（每日 21:30，dispatch：写 inbox/review-daily-<date>.md，daily-meeting 前自动准备）
 *
 * 配置：org/config/auto-schedule.json（改间隔即生效，无需重启，每次 check 重新读表）
 * 状态：org/logs/auto-schedule-state.json（各调度 lastRun 游标）
 *
 * 用法：
 *   node lib/auto-schedule.js check        # 检查各调度是否到点并触发（butler 每分钟调）
 *   node lib/auto-schedule.js force <name> # 强制触发某调度（手动验证用：channel-manager / intel-gatherer / reviewer）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ORG_ROOT   = path.join(__dirname, '..');
const CONFIG     = path.join(ORG_ROOT, 'config', 'auto-schedule.json');
const STATE_FILE = path.join(ORG_ROOT, 'logs', 'auto-schedule-state.json');
const INBOX      = path.join(ORG_ROOT, 'inbox');
const LOGS       = path.join(ORG_ROOT, 'logs');
const KNOWLEDGE  = path.join(ORG_ROOT, 'knowledge');

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
  const line = `[${new Date().toLocaleTimeString()}] [auto-schedule] ${a.join(' ')}`;
  console.log(line);
  // 注意：不用 auto-schedule.log（会与 butler 任务日志 <taskname>.log 冲突，本调度就叫 auto-schedule）
  try { ensure(LOGS); fs.appendFileSync(path.join(LOGS, 'auto-scheduler.log'), line + '\n', 'utf8'); } catch (e) {}
}

function loadCfg() {
  let c = { enabled: true, 'channel-manager': {}, 'intel-gatherer': {}, reviewer: {} };
  try { c = Object.assign(c, readJsonSafe(CONFIG)); } catch (e) {}
  return c;
}
function loadState() { return readJsonSafe(STATE_FILE) || {}; }
function saveState(s) { ensure(LOGS); writeJsonSafe(STATE_FILE, s); }

/* ── 1. channel-manager 渠道巡检（inline） ─────────────── */
async function triggerChannelManager() {
  const fired = [];
  try {
    const cf = require('./channel-fallback');
    // 读健康表 → 汇报当前渠道状态（即便无冷却渠道也留痕，证明巡检在跑）
    const health = cf.readHealth ? cf.readHealth() : (readJsonSafe(path.join(LOGS, 'channel-health.json')) || {});
    const providers = Object.keys(health || {});
    const cooling = (health || {}) && Object.keys(health).filter(p => (health[p] || {}).fails > 0);
    // 冷却渠道恢复探测（内部按 30 分钟节流，幂等）
    const results = await cf.probeCoolingChannels();
    const recovered = results.filter(r => r.recovered);
    const still = results.filter(r => !r.recovered);
    const detail = `渠道 ${providers.length} 个：${cooling.length} 个冷却中待探；本轮恢复 ${recovered.length}、未恢复 ${still.length}`;
    logActivity('[渠道] 渠道管理自动巡检', detail, '渠道');
    fired.push(`channel-manager: ${detail}`);
    // 全挂/重要状态变化写告警
    if (providers.length && cooling.length === providers.length) {
      logActivity('[渠道] ⚠ 所有渠道冷却中，建议关注模型可用性', Object.keys(health).join('、'), '渠道');
      fired.push('channel-manager: 全渠道冷却告警');
    }
  } catch (e) {
    log('渠道巡检异常:', e.message);
    logActivity('[渠道] 渠道巡检异常', String(e.message || '?').slice(0, 120), '渠道');
    fired.push('channel-manager: 异常 ' + e.message);
  }
  return fired;
}

/* ── 2. intel-gatherer 信息自动收集（dispatch 派发给智能体） ─ */
function triggerIntelGatherer() {
  const fired = [];
  const ts = tsStamp();
  const taskName = `intel-collect-${ts}`;
  const donePath = path.join(INBOX, `${taskName}.DONE`);
  if (readIf(path.join(INBOX, `${taskName}.md`))) { log(`intel 收集任务已在队列 ${taskName}`); return fired; }
  const content = [
    `agent: intel-gatherer`,
    `provider: opencode-go`,
    `model: deepseek-v4-flash`,
    `thinking: off`,
    ``,
    `# 信息自动收集：${ts}`,
    ``,
    `按信息搜集官职责做一次自动化增量收集（定时触发，无需等用户提醒）：`,
    ``,
    `0. 先跑结构化入库：node scripts/intel-observer-sync.js（幂等，观察员信息→knowledge/observer-intel/；HK 不可达则跳过并在结果注明）`,
    `1. 对比上次游标（见 memory/index.json 或 knowledge/observer-intel/index.json），只收集新增量，不重复`,
    `2. 可用的信息源按顺序尝试：`,
    `   - HK 服务器聊天频道记忆 / 公共知识 / 观察员实时讨论（若 HK 桥可用：node scripts/hk-task.js 或 intel-observer-sync.js 拉取；不可用则跳过并在结果注明）`,
    `   - 集群 knowledge/ 下新增/更新的情报、讨论、会议纪要（含 observer-intel/ 结构化库）`,
    `   - 你自身能读取的共享进度（inbox 近期 DONE / knowledge 沉淀）`,
    `3. 把新增量整理成结构化素材，增量追加到 knowledge/channel-intelligence.md（每条标注来源+时间，不堆原文）`,
    `4. 有值得让分身/管家看的情报 → 在结果里单独列出`,
    ``,
    `⚠️ 隐私铁律：涉及微信/个人数据必须只在本任务 deepseek 渠道处理，不派第三方、不写原文出圈。`,
    ``,
    `执行要求：`,
    `1. 独立完成，轻量执行（不抢正常任务资源）`,
    `2. 完成后创建标记文件（一行摘要）：${donePath}`,
    `3. 若无法完成，写 ${donePath} 内容为 .FAILED: <原因>`,
  ].join('\n');
  ensure(INBOX);
  fs.writeFileSync(path.join(INBOX, `${taskName}.md`), content, 'utf8');
  log(`信息搜集定时触发 → inbox/${taskName}.md`);
  logActivity('[信息搜集] 信息搜集官自动收集定时触发', `已写 inbox/${taskName}.md 待派发`, '信息搜集');
  fired.push(`intel-gatherer: 已写 ${taskName}.md`);
  return fired;
}

/* ── 3. reviewer 审核官自动验收（dispatch，每日例会前） ──── */
function triggerReviewer() {
  const fired = [];
  const date = new Date().toISOString().slice(0, 10);
  const taskName = `review-daily-${date}`;
  const donePath = path.join(INBOX, `${taskName}.DONE`);
  // 已开过/在队列 → 跳过
  if (readIf(path.join(INBOX, `${taskName}.DONE`))) { return fired; }
  if (readIf(path.join(INBOX, `${taskName}.md`))) { return fired; }
  // 盘点当日完成/失败任务（DONE 文件）
  const files = fs.existsSync(INBOX) ? fs.readdirSync(INBOX) : [];
  const today = [];
  for (const f of files) {
    if (!/\.DONE$/.test(f)) continue;
    const st = (() => { try { return fs.statSync(path.join(INBOX, f)); } catch (e) { return null; } })();
    if (!st) continue;
    const day = new Date(st.mtime).toISOString().slice(0, 10);
    if (day !== date) continue;
    const txt = (readIf(path.join(INBOX, f)) || '').trim();
    const failed = /\.FAILED/i.test(txt);
    today.push(`- ${f.replace(/\.DONE$/, '')} ${failed ? '❌失败' : '✅完成'}：${txt.slice(0, 80)}`);
  }
  if (!today.length) {
    log(`审核定时：今日(${date})暂无已完成/失败任务，跳过验收派发`);
    // 仍留痕一次，但为防每天刷屏，只在有任务时写 activity
    fs.writeFileSync(donePath, `今日 ${date} 无完成/失败任务可验收（自动跳过）`, 'utf8');
    return fired;
  }
  const content = [
    `agent: reviewer`,
    `provider: opencode-go`,
    `model: deepseek-v4-flash`,
    `thinking: off`,
    ``,
    `# 审核官自动验收：${date}（每日例会前准备）`,
    ``,
    `按审核官职责对今日（${date}）已完成/失败的任务做一次自动验收（每日例会 22:00 前自动准备材料）：`,
    ``,
    `## 今日待验收任务`,
    today.join('\n'),
    ``,
    `## 要求`,
    `1. 对每个任务按「报告完整性 / 证据可核验 / 回归通过」三项验收，明确给出 ✅通过 或 ❌驳回`,
    `2. 发现谎报/夸大（DONE 摘要 vs 真实产物不符、缺验证证据）→ 标记并说明`,
    `3. 验收结论整理成结构化材料：knowledge/meetings/${date}-review.md（供每日例会使用）`,
    `4. 有驳回/需返工的任务 → 在结论里单列，给管家/分身参考`,
    `5. ⚠️ 效率约束：验收只核对关键证据（DONE 摘要 vs 真实产物路径/哈希/日志），不做全盘 find/C 盘深度扫描（避免卡死）；搜索限定在 org 项目目录与任务声明的产物路径内`,
    `6. 若个别任务证据复杂/耗时过长，先验收可快速确认的任务并出结论，复杂项在材料里标注“待人工复核”即可，不要长时间卡在一个任务上`,
    ``,
    `执行要求：`,
    `1. 独立完成，验收基于真实文件与证据，不臆断`,
    `2. 完成后创建标记文件（一行摘要）：${donePath}`,
    `3. 若无法完成，写 ${donePath} 内容为 .FAILED: <原因>`,
  ].join('\n');
  ensure(INBOX);
  fs.writeFileSync(path.join(INBOX, `${taskName}.md`), content, 'utf8');
  log(`审核定时触发 → inbox/${taskName}.md（${today.length} 项待验收）`);
  logActivity('[审核] 审核官自动验收定时触发', `${today.length} 项任务，材料 knowledge/meetings/${date}-review.md`, '审核');
  fired.push(`reviewer: 已写 ${taskName}.md（${today.length} 项）`);
  return fired;
}

/* ── 4. daily-reflection 回忆官每日回顾（dispatch 派发给 learning-officer） ─ */
function triggerDailyReflection() {
  const fired = [];
  const date = new Date().toISOString().slice(0, 10);
  const taskName = `daily-reflection-${date}`;
  const donePath = path.join(INBOX, `${taskName}.DONE`);
  // 已开过/在队列 → 跳过
  if (readIf(path.join(INBOX, `${taskName}.DONE`))) return fired;
  if (readIf(path.join(INBOX, `${taskName}.md`))) return fired;
  const recallJs = 'C:\\Users\\du_ji\\pi_workspace\\org\\agents\\learning-officer\\tools\\recall.js';
  const content = [
    `agent: learning-officer`,
    `provider: opencode-go`,
    `model: deepseek-v4-flash`,
    `thinking: off`,
    ``,
    `# 每日轻回顾：${date}（回忆官主动回忆，每日例会前自动触发）`,
    ``,
    `按回忆官职责做一次当日轻回顾（主动回忆——像人翻旧日记重新收获，不是用户问才回忆）：`,
    ``,
    `1. 生成回顾素材：node ${recallJs} reflect --date ${date}（自动读当天 chat-signals + meetings + inbox .DONE）`,
    `2. 用 recall.js 检索当天关键事项（如今天重大成功/失败/纠正/渠道变动），`,
    `   补充素材：node ${recallJs} search --q <关键词> --days 3 --max 8`,
    `3. 在 memory/reflections/${date}.md 的「重新收获」填入 1-3 条真实收获：`,
    `   - 必须是要点**新认知/改进启发/关联**，不是复述流水账`,
    `   - 例如「重跑成功≠根因消除」「失败判定机制是高频故障族」「执行载体向 HK/CNB 迁移」这类跨天的新视角`,
    `4. 有值得走进化流程的收获 → 写进化草稿到 pi_workspace/evolution-drafts/pending/（不自行落地）`,
    `5. 轻量执行，不抢正常任务资源；若当天无值得记的，写明「当天无值得沉淀」即可`,
    ``,
    `⚠️ 铁律：回顾要「收获」（新认知/改进），不是流水账；限量检索防上下文爆炸（recall.js 已内建 grep+head）。`,
    ``,
    `执行要求：`,
    `1. 独立完成，不等待外部指令`,
    `2. 完成后创建标记文件（一行摘要）：${donePath}`,
    `3. 若无法完成，写 ${donePath} 内容为 .FAILED: <原因>`,
  ].join('\n');
  ensure(INBOX);
  fs.writeFileSync(path.join(INBOX, `${taskName}.md`), content, 'utf8');
  log(`每日回顾定时触发 → inbox/${taskName}.md`);
  logActivity('[回忆] 回忆官每日轻回顾定时触发', `已写 inbox/${taskName}.md 待派发`, '回忆');
  fired.push(`daily-reflection: 已写 ${taskName}.md`);
  return fired;
}

/* ── 5. uumit-ops 平台持续运营（dispatch 派发给 uumit-ops） ── */
function triggerUumitOps() {
  const fired = [];
  const ts = tsStamp();
  const taskName = `uumit-running-${ts}`;
  const donePath = path.join(INBOX, `${taskName}.DONE`);
  if (readIf(path.join(INBOX, `${taskName}.md`))) { log(`uumit 运营任务已在队列 ${taskName}`); return fired; }
  const content = [
    `agent: uumit-ops`,
    `provider: opencode-go`,
    `model: deepseek-v4-flash`,
    `thinking: off`,
    ``,
    `# UUMit 平台持续运营：${ts}（每日定时触发，无需等用户）`,
    ``,
    `按 uumit-ops 智能体职责做一轮持续运营（轻量执行，不抢正常任务资源）：`,
    ``,
    `1. 接入检查：tools/uumit-cli.js discover 或 REST 探活（api.uumit.com），不通则修复/记录`,
    `2. 任务市场扫描：GET /api/v1/tasks/hall 拉 open 任务，筛选能力范围内（技术开发/数据处理/AI与自动化/文案/翻译）的任务`,
    `   - 优先选：赏金合理、竞争少（application_count 低）、我们有把握高质量完成的`,
    `   - 有合适的 → 用已上架技能 skill_id 提交申请（POST /api/v1/tasks/{id}/applications）`,
    `   - 质量优先宁缺毋滥：不确定能做好的一律不接`,
    `3. 订单推进：查 GET /api/v1/tasks/applications/mine 待响应申请、GET /api/v1/orders 待交付订单，能推进的推进（交付物在 deliverables/ 下，提交到订单）`,
    `4. 技能维护：GET /api/v1/skills 查已上架技能，对比行情 GET /api/v1/pricing/suggestion 调整价格/描述，滞销或描述过时的更新（PUT /api/v1/skills/{id}）`,
    `5. 钱包对账：GET /api/v1/wallet 记录 UT 余额变化（仅记录，不擅自提现/消费）`,
    ``,
    `参考：artifacts/uumit-running.md 记录接入/接单/技能/机制，保持持续运营连续性。`,
    ``,
    `⚠️ 铁律：接单=对外承诺，只接有把握完成的；上架/改价/停技能是写操作，但本任务是用户授权的持续运营任务（任务 uumit-running），可自主执行并记录；涉及资金（提现/消费）一律不自主。`,
    ``,
    `执行要求：`,
    `1. 独立完成，不等待外部指令`,
    `2. 完成后创建标记文件（一行摘要）：${donePath}`,
    `3. 若无法完成，写 ${donePath} 内容为 .FAILED: <原因>`,
  ].join('\n');
  ensure(INBOX);
  fs.writeFileSync(path.join(INBOX, `${taskName}.md`), content, 'utf8');
  log(`uumit 运营定时触发 → inbox/${taskName}.md`);
  logActivity('[UUMit] uumit-ops 持续运营定时触发', `已写 inbox/${taskName}.md 待派发`, 'UUMit');
  fired.push(`uumit-ops: 已写 ${taskName}.md`);
  return fired;
}

/* 各调度触发函数映射 */
const TRIGGERS = {
  'channel-manager': triggerChannelManager,
  'intel-gatherer':  triggerIntelGatherer,
  reviewer:          triggerReviewer,
  'daily-reflection': triggerDailyReflection,
  'uumit-ops':       triggerUumitOps,
};

/** 判断某调度是否到点 */
function isDue(cfg, state, now) {
  if (!cfg || cfg.enabled === false) return false;
  const last = state[cfg._key] || 0;
  if (cfg.intervalHours) {
    return (now - last) >= cfg.intervalHours * 3600 * 1000;
  }
  if (cfg.intervalMinutes) {
    return (now - last) >= cfg.intervalMinutes * 60 * 1000;
  }
  if (typeof cfg.hour === 'number') {
    const d = new Date();
    const hm = d.getHours() * 60 + d.getMinutes();
    const start = cfg.hour * 60 + (cfg.minute || 0);
    const end = start + (cfg.windowMinutes || 60);
    if (hm < start || hm > end) return false;
    // 每日定点：用日期做 key 防止同日重复
    const todayKey = new Date().toISOString().slice(0, 10);
    if (state['_daily_' + cfg._key] === todayKey) return false;
    return true;
  }
  return false;
}

/**
 * 统一检查入口：butler 主进程每分钟调用一次。
 * @param {object} opts { force: 'channel-manager'|'intel-gatherer'|'reviewer'|null }
 */
async function check(opts) {
  const opt = opts || {};
  const cfg = loadCfg();
  if (!cfg.enabled) { log('auto-schedule 已禁用（config enabled=false）'); return []; }
  const state = loadState();
  const now = Date.now();
  const fired = [];
  const names = Object.keys(TRIGGERS);
  for (const name of names) {
    const sc = Object.assign({ _key: name }, cfg[name]);
    // force 模式：只触发指定调度
    if (opt.force) {
      if (name !== opt.force) continue;
    }
    let due = opt.force === name || isDue(sc, state, now);
    if (!due) continue;
    try {
      const res = await TRIGGERS[name]();
      fired.push(...res);
    } catch (e) {
      log(`调度 ${name} 触发异常:`, e.message);
      fired.push(`${name}: 异常 ${e.message}`);
    }
    // 记录 lastRun（定点调度用 _daily_ 键防同日重复，且不覆盖 lastRun 以便窗口内重试逻辑）
    if (typeof sc.hour === 'number' && !opt.force) {
      state['_daily_' + name] = new Date().toISOString().slice(0, 10);
    } else {
      state[name] = now;
    }
    saveState(state);
  }
  return fired;
}

/* ── CLI ──────────────────────────────────────────────── */
async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'force') {
    const name = argv[1];
    if (!TRIGGERS[name]) { console.error('未知调度: ' + name + '（可选 ' + Object.keys(TRIGGERS).join('/') + '）'); process.exit(1); }
    const fired = await check({ force: name });
    console.log('force 触发 ' + name + ' →', fired.length ? fired.join(' | ') : '(无动作)');
    process.exit(0);
  }
  const fired = await check();
  console.log('auto-schedule check 完成 →', fired.length ? fired.join(' | ') : '(本轮无到点)');
  process.exit(0);
}

if (require.main === module) main();

module.exports = { check, triggerChannelManager, triggerIntelGatherer, triggerReviewer, triggerUumitOps };
