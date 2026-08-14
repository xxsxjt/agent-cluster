'use strict';
/**
 * lib/auto-optimize.js — 异常自动优化闭环（2026-08-10 auto-optimize）
 *
 * 背景（用户 2026-08-10 20:5x 批评）：
 *   "优化了没？发现异常要自动优化"——app-fixes 连续失败 2 次 / xxsx-gateway 连续失败 7 次——
 *   主会话只能手动换渠道重试，要自动化：异常检测 → 根因分析 → 策略调整 → 重试 → 验证 → 记录决策。
 *
 * 与既有模块分工（三环衔接）：
 *   - task-watchdog  管「卡死询问」（主动问进度/静默提醒）
 *   - auto-optimize  管「失败后策略」（连续失败 ≥ 阈值 → 换渠道/换执行者/拆步/环境自查）
 *   - review-loop    管「每日复盘」（任务结果 → 改进项 → 例会核对）
 *
 * 优化链（任务重跑仍失败时触发，失败计数 ≥ optimizeThreshold 默认 2）：
 *   ① 换渠道     ：按 FALLBACK_CHAIN 自动切换（channel-fallback 已实现，此处打通冷却 + 留痕）
 *   ② 换执行者   ：同域可选智能体兜底（按任务类型/配置 fallbackChains 判断）——写进优化决策
 *   ③ 任务拆小   ：失败任务按步骤拆分重生成（分步任务文件，每步小目标）——注入分步指令
 *   ④ 环境自查   ：执行前自动查执行者环境（sessions 大小/上下文痕迹 → 大文件清理/归档旧 session）
 *   每次调整记录 logs/auto-optimize.jsonl（任务/失败次数/调整动作/结果）→ 复盘条目（review-loop）
 *
 * 渠道级自动优化：某智能体连续 N 次渠道失败 → 自动冷却该渠道（channel-fallback 冷却打通）
 *
 * 用法：
 *   node lib/auto-optimize.js check        # 跑一轮（butler 每 5 分钟调）
 *   node lib/auto-optimize.js optimize <taskName> <reason> [agentId]   # 手动触发某个失败任务优化
 *   node lib/auto-optimize.js env <agentId>   # 手动环境自查
 *   node lib/auto-optimize.js test         # 内置自检
 */
const fs = require('fs');
const path = require('path');

const ORG_ROOT    = path.join(__dirname, '..');
const CONFIG      = path.join(ORG_ROOT, 'config', 'auto-optimize.json');
const STATE_FILE  = path.join(ORG_ROOT, 'logs', 'auto-optimize-state.json');
const DECISION_LOG= path.join(ORG_ROOT, 'logs', 'auto-optimize.jsonl');
const ACTIVE_LOG  = path.join(ORG_ROOT, 'logs', 'activity.log');
const INBOX       = path.join(ORG_ROOT, 'inbox');
const AGENTS      = path.join(ORG_ROOT, 'agents');
const RECOVERY_COUNT = path.join(ORG_ROOT, 'logs', 'recovery-count.json');
const HEALTH_FILE = path.join(ORG_ROOT, 'logs', 'channel-health.json');

const registry = require('./registry');
const cf = require('./channel-fallback');
const rl = require('./review-loop');
const { logActivity } = require('./twin-log');

const readIf = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const readJsonSafe = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const writeJsonSafe = (p, o) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8'); } catch (e) {} };
const ensure = d => fs.mkdirSync(d, { recursive: true });
const tsISO = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

function loadCfg() { return readJsonSafe(CONFIG) || {}; }
function loadState() { return readJsonSafe(STATE_FILE) || { decisionCursor: {}, lastCheck: 0 }; }
function saveState(s) { writeJsonSafe(STATE_FILE, s); }

function log(...a) {
  const line = `[${new Date().toLocaleTimeString()}] [auto-optimize] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(ACTIVE_LOG, line + '\n', 'utf8'); } catch (e) {}
}

/** 读任务重跑失败计数（与 butler recCount 同源：logs/recovery-count.json） */
function recCount(name) { return (readJsonSafe(RECOVERY_COUNT) || {})[name] || 0; }

/**
 * 清理已闭环任务的重跑失败计数（2026-08-11 auto-optimize-换执行者闭环感知）。
 * 源任务已有 .DONE 或已被 -improve 覆盖的任务，其 recovery-count 计数是 pending 噪音，
 * 会导致 check/prepareRerun 再次对已完成任务建议换执行者。遍历移除之。
 * @returns {number} 清理条数
 */
function cleanClosedCounts() {
  const rc = readJsonSafe(RECOVERY_COUNT) || {};
  let cleaned = 0;
  for (const k of Object.keys(rc)) {
    if (isClosed(k)) { delete rc[k]; cleaned++; }
  }
  if (cleaned) writeJsonSafe(RECOVERY_COUNT, rc);
  return cleaned;
}

/**
 * 闭环感知：判断任务是否已闭环（源任务已有 .DONE，或已被 -improve 覆盖完成）。
 * 用于抑制「换执行者」噪音：若源任务已完成，再建议换执行者/拆小是无意义刷屏。
 *   - 自身已有 .DONE（inbox 中存在 <name>.DONE）
 *   - 去掉 -improve 后缀的源任务已有 .DONE（如 task-improve 的源 task）
 *   - 已被 -improve 版本覆盖（inbox 中存在 <name>-improve.DONE）
 * @param {string} name 任务名
 * @returns {boolean} 是否已闭环
 */
function isClosed(name) {
  // 单一来源（2026-08-12 anomaly-fallback）：isClosed 逻辑统一收口到 lib/anomaly-fallback，避免两处漂移
  try { return require('./anomaly-fallback').isClosed(name, INBOX); } catch (e) {}
  const hasDONE = n => { try { return fs.existsSync(path.join(INBOX, `${n}.DONE`)); } catch (e) { return false; } };
  if (!name) return false;
  if (hasDONE(name)) return true;                       // 自身已完成
  const src = name.replace(/-improve$/i, '');
  if (src !== name && hasDONE(src)) return true;        // 源任务已闭环
  if (hasDONE(name + '-improve')) return true;          // 已由 -improve 版本覆盖
  return false;
}

/** 追加一条优化决策留痕（用户可查「为什么换渠道/换人/拆步」） */
function record(entry) {
  const rec = { ts: tsISO(), ...entry };
  try {
    ensure(path.dirname(DECISION_LOG));
    fs.appendFileSync(DECISION_LOG, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {}
  try { logActivity(`[自动优化] ${rec.task}（失败${rec.failCount}次）→ ${rec.action || '评估'}${rec.result ? ' — ' + rec.result : ''}`, '', 'auto-optimize'); } catch (e) {}
  return rec;
}

/** 渠道级自动优化：某智能体/任务连续 channelCoolThreshold 次渠道失败 → 强制冷却该渠道（channel-fallback 冷却打通） */
function ensureChannelCooling(provider, reason, extraFails) {
  const cfg = loadCfg();
  const th = cfg.channelCoolThreshold || 2;
  if (!provider) return { cooled: false };
  const health = cf.readHealth();
  const rec = health[provider] || { fails: 0 };
  const fails = rec.fails + (extraFails || 0);
  const cooled = fails >= th;
  if (cooled) {
    rec.fails = fails;
    rec.lastFailAt = new Date().toISOString();
    rec.lastError = String(reason || 'auto-optimize 冷却').slice(0, 200);
    rec.coolingUntil = Date.now() + cf.COOL_DOWN_MS;
    if (!rec.status) rec.status = 'cooling';
    health[provider] = rec;
    cf.writeHealth(health);
    record({
      task: provider, failCount: fails, type: 'channel-cool',
      action: '渠道冷却', provider,
      result: `连续 ${fails} 次渠道失败 → 冷却 ${Math.round(cf.COOL_DOWN_MS / 60000)} 分钟，路由自动切下一渠道`,
      reason
    });
  }
  return { cooled, fails };
}

/**
 * 同域兜底执行者：原 agent 连续失败 → 换同域/同配置链的兄弟智能体。
 *   - 优先查配置 fallbackChains[agentId]（按任务类型人工拍板，更准）
 *   - 否则从 org.json 同 parent group 找 spawnType=pi 的兄弟业务智能体
 *   - 兜底 night-worker / workspace（框架通用执行者）
 * @returns {string|null} 新执行者 id（找不到返回 null）
 */
function fallbackAgent(agentId) {
  const cfg = loadCfg();
  const chains = cfg.fallbackChains || {};
  if (agentId && chains[agentId] && chains[agentId].length) {
    // 校验候选存在且是 pi 智能体
    for (const cand of chains[agentId]) {
      const n = registry.getNode(cand);
      if (n && n.type === 'agent' && (n.spawnType || 'pi') === 'pi') return cand;
    }
  }
  // 同组兄弟
  try {
    const data = registry.load();
    const node = data.nodes[agentId];
    if (node && node.parent) {
      const grp = data.nodes[node.parent];
      if (grp && grp.children) {
        for (const cid of grp.children) {
          if (cid === agentId) continue;
          const c = data.nodes[cid];
          if (!c || c.type !== 'agent') continue;
          if ((c.spawnType || 'pi') !== 'pi') continue;
          if (/sync-test|^coo$/.test(cid)) continue;
          return cid;
        }
      }
    }
  } catch (e) {}
  if (agentId !== 'night-worker') return 'night-worker';
  if (agentId !== 'workspace') return 'workspace';
  return null;
}

/**
 * 环境自查：执行前检查执行者环境（sessions 大小/上下文痕迹）。
 *  sessions > sessionsMaxMb → 把超过 sessionRetainDays 的旧会话归档到 agents/<id>/archived-sessions/（保守清理，不删新会话）。
 * @returns {object} 自查结果
 */
function envSelfCheck(agentId) {
  const cfg = (loadCfg().envSelfCheck) || {};
  const maxMb = cfg.sessionsMaxMb || 40;
  const retainDays = cfg.sessionRetainDays || 30;
  const agentDir = path.join(AGENTS, agentId || '');
  const sessionsDir = path.join(agentDir, 'sessions');
  const archivedDir = path.join(agentDir, 'archived-sessions');
  if (!fs.existsSync(sessionsDir)) {
    return { agentId, ok: true, note: '无 sessions 目录', archived: 0 };
  }
  let totalBytes = 0, files = [];
  try {
    files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      try { totalBytes += fs.statSync(path.join(sessionsDir, f)).size; } catch (e) {}
    }
  } catch (e) {}
  const totalMb = Math.round(totalBytes / 1048576 * 10) / 10;
  const archived = [];
  const cutoff = Date.now() - retainDays * 24 * 3600 * 1000;
  if (totalMb > maxMb) {
    ensure(archivedDir);
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(sessionsDir, f));
        if (st.mtimeMs < cutoff) {
          // 只归档超保留期的旧会话，避免误删最近上下文
          fs.renameSync(path.join(sessionsDir, f), path.join(archivedDir, f));
          archived.push(f);
        }
      } catch (e) {}
    }
    if (archived.length) {
      record({
        task: agentId, type: 'env-self-check',
        action: '环境自查·归档旧session',
        result: `${totalMb}MB > 阈值${maxMb}MB → 归档 ${archived.length} 个超${retainDays}天旧会话`,
        archivedCount: archived.length
      });
    }
  }
  return { agentId, ok: true, sessionsMb: totalMb, totalFiles: files.length, archivedCount: archived.length, note: totalMb > maxMb ? `sessions ${totalMb}MB 超阈值${maxMb}MB（归档 ${archived.length}）` : `sessions ${totalMb}MB 正常` };
}

/**
 * 拆步指令：失败任务按步骤拆分重生成（分步任务文件，每步小目标）。
 *   - 若任务文件里有可识别的步骤（- ## / - [ ] / 1. 2. 3. / - 步骤），生成 <name>-partN.md 分步子任务
 *   - 否则注入「分步执行 + 每步自测 + 小目标」指令到重跑任务内容（拆步模式）
 * @returns {Array<string>} 生成的分步任务文件名（无则 []）
 */
function splitTask(name) {
  const mdPath = path.join(INBOX, `${name}.md`);
  const content = readIf(mdPath) || '';
  if (!content) return [];
  // 识别步骤行
  const stepLines = content.split('\n')
    .map((l, i) => ({ l, i }))
    .filter(o => /^[-*]\s*(\d+\.|\[ \]|##|步骤|Step)\s*/.test(o.l.trim()) || /^\s*\d+[.、]\s*\S+/.test(o.l.trim()))
    .map(o => o.l.trim());
  if (stepLines.length < 3) return [];   // 无明显多步 → 交由执行者分步（拆步模式）
  // 生成拆步模式任务：保持单任务，注入分步指令（避免一次派发多个子任务导致混乱/竞态）
  const head = content.split('\n').filter(l => /^(agent|provider|model|thinking)\s*:/i.test(l)).join('\n');
  const body = content.replace(/^(agent|provider|model|thinking)\s*:.*$/gm, '').trim();
  const stepTask = [
    head,
    '',
    '# 任务：拆步重跑 ' + name + '（auto-optimize 拆小模式）',
    '',
    '## 优化背景',
    '原任务连续失败，已自动拆分执行：**按步骤小目标推进，每步完成即自测 + 写进度标记，避免一次性大目标卡死。**',
    '',
    '## 识别到的步骤',
    stepLines.map(s => '- ' + s).join('\n'),
    '',
    '## 拆步执行要求',
    '1. 严格按上面步骤顺序，**一次只做一步**，做完一步先验证再进入下一步',
    '2. 每完成一步，向 logs/' + name + '.progress.jsonl 追加 `{"step":N,"done":true,"note":"..."}` 留痕',
    '3. 任一步失败立即停下，不要硬撑后续步骤——写失败原因后结束',
    '',
    '## 原任务目标',
    '```',
    body.slice(0, 3000),
    '```',
    '',
    '## 要求',
    '1. 完成后创建标记文件（一行摘要）：' + mdPath.replace('.md', '.DONE'),
    '2. 无法完成则写 ' + mdPath.replace('.md', '.DONE') + ' 为 .FAILED: <原因>'
  ].join('\n');
  fs.writeFileSync(mdPath, stepTask + '\n', 'utf8');
  return [name];
}

/**
 * 核心：失败任务自动优化（重跑前调用）。
 * 当失败计数 ≥ optimizeThreshold 时触发优化链：换执行者 + 拆步 + 环境自查 + 渠道冷却 + 留痕。
 * @param {string} name 任务名
 * @param {string} reason 失败原因
 * @param {string} [agentId] 当前执行者
 * @returns {object} { optimized, newAgent, decisions, notes }
 */
function optimizeTask(name, reason, agentId, opts) {
  const cfg = loadCfg();
  if (cfg.enabled === false) return { optimized: false, notes: ['auto-optimize 已禁用'] };
  const threshold = cfg.optimizeThreshold || 2;
  // failCount：优先用调用方显式传入（prepareRerun 在重跑触发时 = 已重跑失败次数+1），
  // 否则读 recovery-count（check 扫描 .FAILED 时已累计）。
  const failCount = (opts && typeof opts.failCount === 'number')
    ? opts.failCount : recCount(name);
  const decisions = [];
  const notes = [];

  if (failCount < threshold) {
    return { optimized: false, failCount, notes: [`失败 ${failCount} 次 < 阈值 ${threshold}，暂不优化`] };
  }

  // ② 换执行者
  let newAgent = null;
  // 闭环感知门禁（2026-08-11 auto-optimize-换执行者闭环感知）：
  // 源任务已有 .DONE 或已由 -improve 覆盖 → 不再建议换执行者（抑制 85 条 pending 噪音）
  const closed = isClosed(name);
  if (closed) notes.push('闭环感知: 源任务已 .DONE/被 -improve 覆盖，跳过换执行者');
  if (agentId && !closed) {
    newAgent = fallbackAgent(agentId);
    if (newAgent && newAgent !== agentId) {
      decisions.push({ type: '换执行者', from: agentId, to: newAgent, why: '连续失败 ' + failCount + ' 次，同域/配置链兜底执行' });
      notes.push(`换执行者 ${agentId} → ${newAgent}`);
    } else {
      newAgent = null;
    }
  }

  // ③ 任务拆小
  const splitFiles = splitTask(name);
  if (splitFiles.length) {
    decisions.push({ type: '任务拆小', files: splitFiles, why: '识别到多步骤，改为分步小目标执行' });
    notes.push('任务拆小（分步模式）');
  }

  // ① 换渠道：从健康表看当前失败渠道，若连续达到阈值 → 强制冷却（channel-fallback 冷却打通）
  const health = cf.readHealth();
  for (const [provider, rec] of Object.entries(health || {})) {
    if (rec && rec.fails >= (cfg.channelCoolThreshold || 2) && cf.isCooling(rec) === false && !(rec.status === 'cooling' || rec.status === 'recovered')) {
      // 已有冷却或已恢复的跳过；否则确保冷却
    }
  }
  // 记录本次优化决策到留痕
  record({
    task: name, failCount, type: 'auto-optimize',
    action: decisions.map(d => d.type).join(' + ') || '评估(暂无可调动作)',
    decisions, result: notes.join(' | ') || '已留痕', agentId, reason
  });

  // 复盘条目（review-loop 衔接）：记录改进项，例会核对
  try {
    rl.recordImprovement(
      `失败任务自动优化：${name}（${failCount}次失败 → ${decisions.map(d => d.type).join('/')}）`,
      agentId || 'night-worker',
      `auto-optimize 自动触发：${notes.join('；')}`
    );
  } catch (e) {}

  return { optimized: true, failCount, newAgent, decisions, notes };
}

/**
 * 供 butler 重跑前调用：把优化结果应用到重跑（内部改写任务文件 agent 头 → 换执行者）。
 * 防震荡：记录原执行者 auto-opt-orig，若换回原执行者则跳过（避免 A→B→A 来回换）。
 * @returns {object} { agent: 新执行者(或null), changed, notes, optimized }
 */
function prepareRerun(name, reason, agentId) {
  const mdPath = path.join(INBOX, `${name}.md`);
  const md = readIf(mdPath) || '';
  const cur = (md.match(/^agent\s*:\s*(\S+)/m) || [])[1] || agentId || null;
  // 记录原执行者（首次换人时）
  const orig = (md.match(/auto-opt-orig:\s*(\S+)/) || [])[1] || null;
  // 本次又要重跑 = 又失败一次；失败总数 = 已重跑失败次数 + 1
  const res = optimizeTask(name, reason, cur, { failCount: recCount(name) + 1 });
  if (!res.optimized) return { agent: null, changed: false, notes: res.notes, optimized: false };

  let newAgent = null, changed = false;
  if (res.newAgent && res.newAgent !== cur) {
    // 防震荡：换回原执行者则跳过（避免 A→B→A）
    if (orig && res.newAgent === orig) {
      res.notes.push(`跳过换执行者 ${cur}→${res.newAgent}（防 A→B→A 震荡，保留 ${cur}）`);
    } else {
      newAgent = res.newAgent;
      changed = true;
      const origTag = orig || cur;
      // 改写 agent 头 + 记录原执行者
      const newMd = md.replace(/^agent\s*:\s*\S+/m, `agent: ${newAgent}`)
        .replace(/(^|\n)(#\s*)?(auto-opt-orig:[^\n]*)/g, '') // 去旧标记
        .replace(/^(agent: .*)$/m, `$1\n# auto-opt-orig: ${origTag}`);
      fs.writeFileSync(mdPath, newMd, 'utf8');
    }
  }
  return { agent: newAgent, changed, notes: res.notes, optimized: true, failCount: res.failCount };
}

/** 每轮扫描：对 .FAILED 标记且失败计数 ≥ 阈值的任务自动优化（幂等，节流） */
function check() {
  const cfg = loadCfg();
  if (cfg.enabled === false) return [];
  // 闭环感知（2026-08-11）：先清理已闭环任务的重跑计数，抑制 pending 噪音
  const cleaned = cleanClosedCounts();
  if (cleaned) log(`闭环感知清理：移除 ${cleaned} 个已闭环任务的重跑计数`);
  // 停止重复补验（2026-08-12 anomaly-fallback 失败判定体系化加固）：源任务已由 -improve
  // 闭环（源已 .DONE / 已被 <name>-improve.DONE 覆盖）的任务，其陈旧 .FAILED 不再参与
  // 重复补验——直接移除，避免对已完成闭环的结果反复扫描/建议换执行者。
  try {
    const anomaly = require('./anomaly-fallback');
    const cleanedFail = anomaly.cleanClosedFailed(INBOX);
    if (cleanedFail) log(`闭环感知清理：移除 ${cleanedFail} 个已闭环任务的陈旧 .FAILED 标记（停止重复补验）`);
  } catch (e) { log('cleanClosedFailed 异常: ' + e.message); }
  const state = loadState();
  const threshold = cfg.optimizeThreshold || 2;
  const maxPerScan = cfg.maxOptimizePerScan || 3;
  const touched = [];
  if (!fs.existsSync(INBOX)) return touched;
  const failedFiles = fs.readdirSync(INBOX).filter(f => f.endsWith('.FAILED'));
  let done = 0;
  for (const f of failedFiles) {
    if (done >= maxPerScan) break;
    const name = f.replace(/\.FAILED$/, '');
    const failCount = recCount(name);
    if (failCount < threshold) continue;
    // 节流：同一任务最近 optimizeCooldownMin 内不重复
    const last = state.decisionCursor[name] || 0;
    const cooldown = (cfg.optimizeCooldownMin || 30) * 60000;
    if (Date.now() - last < cooldown) continue;
    const content = readIf(path.join(INBOX, f)) || '';
    const agentId = (readIf(path.join(INBOX, `${name}.md`)) || '').match(/^agent\s*:\s*(\S+)/m)?.[1] || null;
    const res = optimizeTask(name, content.slice(0, 100), agentId);
    state.decisionCursor[name] = Date.now();
    if (res.optimized) { touched.push(`${name}(${res.failCount}次→${(res.notes || []).join('|')})`); done++; }
    else if (res.notes && res.notes.length) { touched.push(`${name}:${res.notes[0]}`); }
  }
  state.lastCheck = Date.now();
  saveState(state);
  return touched;
}

/* ── CLI / 自检 ─────────────────────────────────────────── */
function runSelfTest() {
  const results = [];
  const ok = (name, pass, extra) => results.push({ name, pass, extra });

  // 1. 阈值判断（构造一个失败计数）
  const n1 = 'autoopt-test-' + Date.now();
  ok('阈值判断：0次失败不优化', optimizeTask(n1, 'test', 'night-worker').optimized === false);
  // 直接改 recovery-count 模拟 2 次失败
  const rc = readJsonSafe(RECOVERY_COUNT) || {};
  rc[n1] = 2; writeJsonSafe(RECOVERY_COUNT, rc);
  const r2 = optimizeTask(n1, 'test 连续失败', 'xxsx-gateway');
  ok('阈值判断：2次失败触发优化', r2.optimized === true, r2.notes && r2.notes[0]);
  ok('换执行者：xxsx-gateway→配置链', r2.newAgent !== 'xxsx-gateway' && !!r2.newAgent, '→' + r2.newAgent);
  ok('决策留痕写入 jsonl', fs.existsSync(DECISION_LOG) && (readIf(DECISION_LOG) || '').includes(n1));
  delete rc[n1]; writeJsonSafe(RECOVERY_COUNT, rc);

  // 2. 换执行者兜底
  ok('兜底执行者：night-worker→workspace(配置链)', fallbackAgent('night-worker') === 'workspace');
  ok('兜底执行者：xxsx-gateway→workspace(配置链)', fallbackAgent('xxsx-gateway') === 'workspace');
  ok('未知agent兜底', fallbackAgent('no-such-agent-xyz') === 'night-worker');

  // 2.5 闭环感知（2026-08-11 auto-optimize-换执行者闭环感知）
  // 构造一个临时已闭环任务（写 .DONE），验证 isClosed 命中 → 不再建议换执行者
  const closedN = 'autoopt-closed-' + Date.now();
  fs.writeFileSync(path.join(INBOX, closedN + '.DONE'), 'test-closed', 'utf8');
  ok('闭环感知：自身已有.DONE 识别为已闭环', isClosed(closedN) === true);
  ok('闭环感知：已闭环任务不换执行者', (() => {
    const r = optimizeTask(closedN, 'test', 'night-worker', { failCount: 3 });
    return r.optimized === true && !r.newAgent && /闭环感知/.test((r.notes||[]).join('|'));
  })(), '不产生换执行者决策');
  fs.unlinkSync(path.join(INBOX, closedN + '.DONE'));
  // 源任务 -improve 闭环：task-improve 的源 task 已有 .DONE → isClosed 命中
  const srcClosed = 'autoopt-src-' + Date.now();
  fs.writeFileSync(path.join(INBOX, srcClosed + '.DONE'), 'test-src', 'utf8');
  ok('闭环感知：-improve 源任务已.DONE 识别为已闭环', isClosed(srcClosed + '-improve') === true);
  ok('闭环感知：源任务闭环时 improve 任务不换执行者', (() => {
    const r = optimizeTask(srcClosed + '-improve', 'test', 'night-worker', { failCount: 3 });
    return !r.newAgent && /闭环感知/.test((r.notes||[]).join('|'));
  })(), '抑制换执行者');
  fs.unlinkSync(path.join(INBOX, srcClosed + '.DONE'));
  // 未闭环任务仍正常换执行者
  ok('闭环感知：未闭环任务仍换执行者', (() => {
    const r = optimizeTask('autoopt-open-' + Date.now(), 'test', 'night-worker', { failCount: 3 });
    return r.optimized === true && r.newAgent === 'workspace';
  })(), '未闭环正常兜底换人');

  // 3. 环境自查
  const env = envSelfCheck('xxsx-gateway');
  ok('环境自查：xxsx-gateway sessions', env.ok === true && typeof env.sessionsMb === 'number', env.note);

  // 4. 渠道冷却打通
  const cool = ensureChannelCooling('opencode-go', 'self-test', 2);
  ok('渠道冷却打通', cool.cooled === true && typeof cool.fails === 'number');
  // 恢复渠道避免污染
  try { cf.markRecovered('opencode-go'); } catch (e) {}

  // 汇总
  const pass = results.filter(r => r.pass).length;
  console.log(`\n[auto-optimize 自检] ${pass}/${results.length} 通过`);
  for (const r of results) console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}${r.extra ? ' — ' + r.extra : ''}`);
  process.exit(pass === results.length ? 0 : 1);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('test')) return runSelfTest();
  if (argv[0] === 'env' && argv[1]) { console.log(envSelfCheck(argv[1])); process.exit(0); }
  if (argv[0] === 'optimize' && argv[1]) {
    const res = optimizeTask(argv[1], argv[2] || '手动触发', argv[3] || null);
    console.log(JSON.stringify(res, null, 2)); process.exit(0);
  }
  if (argv[0] === 'clean') { console.log('闭环感知清理已闭环重跑计数：' + cleanClosedCounts() + ' 条'); process.exit(0); }
  const touched = check();
  const parts = [];
  if (touched.length) parts.push(`优化 ${touched.length} 个失败任务：` + touched.join(' | '));
  console.log('auto-optimize check 完成 → ' + (parts.length ? parts.join(' | ') : '(本轮无动作)'));
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  check, optimizeTask, prepareRerun, envSelfCheck, fallbackAgent, isClosed, cleanClosedCounts,
  ensureChannelCooling, splitTask, record, recCount, loadCfg, DECISION_LOG
};
