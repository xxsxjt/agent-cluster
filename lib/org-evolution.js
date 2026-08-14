#!/usr/bin/env node
/**
 * lib/org-evolution.js — 智能体自我繁衍机制（2026-08-09）
 *
 * 理念（用户 2026-08-09 明示）：集群要"活的"——智能体有自己的智能、主动性、讨论、执行。
 * 项目大到单个智能体难以全盘熟知时 → 智能体主动向管家与分身申请：在自己当前分组下创建子分组
 * + 给自己创建子智能体（分身）→ 分配处理任务 → 父智能体升格组长协调。
 *
 * 流程（申请 → 审批 → 执行 → 留痕）：
 *   1. 智能体自评触发（evaluate：backlog pending 过多 / 项目文件面过广 / 跨领域过杂）
 *   2. 智能体写申请 inbox/reproduce-<agent>.md（含 子分组名 / 分工方案 / 理由）
 *   3. 分身审批：check() 把申请转成 inbox/decisions/ 决策请求 → twin-daemon scanDecisions
 *      让分身大脑(user-twin)决策（批准/驳回/调整，决策留痕 .decision.md）
 *   4. 管家执行：check() 读到"批准"决策 → executeReproduce() 在 org.json 建子分组+子智能体
 *      （identity 继承父智能体子集）+ 父智能体 role 升格"组长/协调者"
 *   5. 全程留痕：activity [繁衍] + 决策记录 + inbox/reproduce-<agent>.DONE
 *
 * 防滥用：审批门槛（分身批）、申请必附分工方案、同智能体节流（默认 7 天一次）。
 * 与现有分组结构兼容：子分组嵌套在父分组下（grp-dev → grp-mcmods），不破坏路由（子智能体
 * parent = 子分组，子分组在父分组域内，任务按域路由仍命中）。
 *
 * 用法：
 *   node lib/org-evolution.js scan                 # 单次巡检（扫描申请+处理决策+自评），twin 巡查调用
 *   node lib/org-evolution.js submit <agent> ...   # 代智能体写申请（验证/演示用）
 *   node lib/org-evolution.js evaluate <agent>     # 自评某智能体项目健康度（返回是否建议繁衍）
 *   node lib/org-evolution.js test                 # 内置自检（模拟 mc-dev 繁衍全链路）
 *   node lib/org-evolution.js demo                 # 端到端演示（提交申请→手动批准→执行）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ORG_ROOT   = path.join(__dirname, '..');
const CONFIG     = path.join(ORG_ROOT, 'config', 'org-evolution.json');
const STATE_FILE = path.join(ORG_ROOT, 'logs', 'org-evolution-state.json');
const INBOX      = path.join(ORG_ROOT, 'inbox');
const DEC_DIR    = path.join(INBOX, 'decisions');
const LOGS       = path.join(ORG_ROOT, 'logs');
const AGENTS_DIR = path.join(ORG_ROOT, 'agents');
const ORG_JSON   = path.join(ORG_ROOT, 'org.json');
const BACKLOG_CONFIG = path.join(ORG_ROOT, 'config', 'agent-backlog.json');

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
  const line = `[${new Date().toLocaleTimeString()}] [org-evolution] ${a.join(' ')}`;
  console.log(line);
  try { ensure(LOGS); fs.appendFileSync(path.join(LOGS, 'org-evolution.log'), line + '\n', 'utf8'); } catch (e) {}
}

function loadCfg() {
  let c = {};
  try { c = readJsonSafe(CONFIG) || {}; } catch (e) {}
  c.enabled = c.enabled !== false;
  c.throttleDays = c.throttleDays || 7;
  c.maxChildrenPerRepro = c.maxChildrenPerRepro || 4;
  c.minDivisionPlanLines = c.minDivisionPlanLines || 1;
  return c;
}
function loadState() {
  return readJsonSafe(STATE_FILE) || { throttle: {}, processed: {}, decisions: {} };
}
function saveState(s) { writeJsonSafe(STATE_FILE, s); }

/** 同智能体繁衍节流：throttleDays 内不再受理新申请 */
function passThrottle(state, agentId, cfg) {
  const last = (state.throttle || {})[agentId] || 0;
  return (Date.now() - last) >= cfg.throttleDays * 24 * 3600 * 1000;
}
function setThrottle(state, agentId) {
  state.throttle = state.throttle || {};
  state.throttle[agentId] = Date.now();
}

/** 读取 org.json */
function loadOrg() { return readJsonSafe(ORG_JSON) || {}; }
function saveOrg(org) {
  const bak = ORG_JSON + '.bak-evo-' + Date.now();
  try { fs.copyFileSync(ORG_JSON, bak); } catch (e) {}
  org.updatedAt = tsISO();
  writeJsonSafe(ORG_JSON, org);
  return bak;
}

/* ── 1. 自评触发（evaluate）：检查智能体项目健康度，返回是否建议繁衍 ── */
/**
 * 评估某智能体"项目健康度"，返回是否建议繁衍 + 理由。
 * 判据：①backlog pending 项数量 ≥ pendingThreshold
 *       ②identity 引用的独立项目路径数 ≥ projectSurfaceThreshold（覆盖面过广）
 * @returns { suggested, score, reasons[], agent, label }
 */
function evaluate(agentId, cfg) {
  cfg = cfg || loadCfg();
  const org = loadOrg();
  const node = org.nodes[agentId] || {};
  const ident = readJsonSafe(path.join(AGENTS_DIR, agentId, 'identity.json')) || {};
  const reasons = [];
  let score = 0;

  // ① backlog pending 堆积
  const backlog = readJsonSafe(BACKLOG_CONFIG) || {};
  const pend = ((backlog.agents || {})[agentId] || {}).backlog || [];
  const pendingCount = pend.filter(i => i.status === 'pending').length;
  if (pendingCount >= (cfg.evaluate || {}).pendingThreshold) {
    reasons.push(`backlog 有 ${pendingCount} 项 pending 待办（≥${(cfg.evaluate||{}).pendingThreshold}，任务堆积可能超出全盘掌控）`);
    score++;
  }

  // ② 项目覆盖面（identity 里出现的独立项目路径 / 项目名）
  const surfaceMatches = (ident.projectSummary || '').split(/[，,、；;]/)
    .map(s => s.trim())
    .filter(s => /mod|项目|模块|系列|_mod|earth|temple|magic|nihil|fantasy/i.test(s) && s.length > 3);
  const projSurface = [...new Set(surfaceMatches)];
  if (projSurface.length >= (cfg.evaluate || {}).projectSurfaceThreshold) {
    reasons.push(`项目覆盖面广（识别到 ${projSurface.length} 个独立项目：${projSurface.slice(0, 4).join(' / ')}…）`);
    score++;
  }

  return {
    agent: agentId, label: node.label || ident.label || agentId,
    suggested: score >= 1, score, reasons,
    detail: reasons.join('；') || '项目尚在单智能体可掌控范围内'
  };
}

/* ── 2. 智能体写申请（inbox/reproduce-<agent>.md） ── */
/**
 * 代智能体写繁衍申请（智能体自己也可直接写同格式文件）。
 * 申请文件格式（头部 agent/provider + 字段行 + 正文）：
 *   agent: <agentId>
 *   provider: opencode-go
 *   子分组名: <subGroupLabel>
 *   理由: <reason>
 *   分工方案:
 *   - <子智能体id> | <职责一句话> | <继承范围描述>
 * @returns {name} 申请文件名（inbox/reproduce-<agent>.md）
 */
function submitRequest(agentId, opts) {
  opts = opts || {};
  const name = `reproduce-${agentId}`;
  const p = path.join(INBOX, name + '.md');
  if (fs.existsSync(p)) return name;   // 已在队列
  const provider = opts.privateData ? 'deepseek' : 'opencode-go';
  const lines = [
    `agent: ${agentId}`,
    `provider: ${provider}`,
    `model: deepseek-v4-flash`,
    `thinking: off`,
    ``,
    `# 繁衍申请：${agentId}`,
    ``,
    `## 子分组名`,
    opts.subGroupLabel || (agentId + ' 域'),
    ``,
    `## 理由`,
    opts.reason || '项目任务堆积/覆盖面超出单智能体全盘掌控，申请创建子分组与子智能体分工处理',
    ``,
    `## 分工方案（子智能体列表）`,
    ``,
    (opts.divisions || []).map(d => `- ${d.id} | ${d.label} | ${d.duty || d.role || '分工执行'}`).join('\n') || '- 未填写（将被驳回）',
    ``,
    `## 预期效果`,
    opts.effect || '父智能体升格组长协调，子智能体各司其职，提升并行效率与掌控度',
  ];
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  return name;
}

/* ── 3. 扫描申请 → 转决策请求（分身审批） ── */
/**
 * 扫描 inbox/reproduce-*.md（未处理的繁衍申请），校验后转成 inbox/decisions/ 决策请求。
 * 决策请求由 twin-daemon scanDecisions 捡起 → 分身大脑(user-twin)审批 → 写 .decision.md。
 * @returns {string[]} 新增 activity 行
 */
function scanRequests(state, cfg, changed) {
  if (!cfg.enabled) return;
  if (!fs.existsSync(INBOX)) return;
  const files = fs.readdirSync(INBOX).filter(f => /^reproduce-.+\.md$/.test(f));
  const processed = state.processed || {};
  for (const f of files) {
    const agentId = f.replace(/^reproduce-/, '').replace(/\.md$/, '');
    if (processed[f]) continue;                       // 已受理过
    const content = readIf(path.join(INBOX, f)) || '';
    const st = statOf(path.join(INBOX, f));
    // 节流防滥用：同智能体 throttleDays 内只受理一次
    if (!passThrottle(state, agentId, cfg)) {
      changed.push(logActivity(`[繁衍] ${agentId} 申请被节流（throttleDays=${cfg.throttleDays} 内已申请过）`, '同智能体繁衍节流防滥用', '繁衍'));
      processed[f] = { ts: tsISO(), status: 'throttled' };
      continue;
    }
    // 校验：必附分工方案（≥minDivisionPlanLines 行）
    const divisionLines = content.split(/\r?\n/).filter(l => /^\s*[-•*]\s+\S+\s*\|/.test(l));
    if (divisionLines.length < cfg.minDivisionPlanLines) {
      changed.push(logActivity(`[繁衍] ${agentId} 申请缺分工方案 → 驳回`, '申请须附子智能体分工方案（分身门槛）', '繁衍'));
      processed[f] = { ts: tsISO(), status: 'rejected-no-plan' };
      fs.writeFileSync(path.join(INBOX, f.replace(/\.md$/, '.DONE')), '驳回：申请缺分工方案，请补充后重新提交', 'utf8');
      continue;
    }
    // 转决策请求：inbox/decisions/<ts>-reproduce-<agent>.md（与 scanDecisions 解析兼容）
    const decReq = path.join(DEC_DIR, `${tsStamp()}-reproduce-${agentId}.md`);
    const subGroupLabel = (content.match(/## 子分组名\s*\n\s*([^\n]+)/) || [])[1] || '';
    const reason = (content.match(/## 理由\s*\n\s*([^\n]+)/) || [])[1] || '';
    const srcTask = `reproduce-${agentId}`;
    const decContent = [
      `# 繁衍审批请求：${agentId}`,
      `- 源任务: ${srcTask}`,
      `- 问题: 智能体 ${agentId} 申请自我繁衍：在当前分组下创建子分组「${subGroupLabel}」+ 给自己创建子智能体分工处理，父智能体升格组长协调。是否批准？`,
      ``,
      `## 申请内容`,
      ``,
      content.slice(0, 2000),
      ``,
      `## 审批提示（分身用）`,
      `请以分身（用户 du_ji 思维）判断：该申请是否合理（项目确实超出单智能体掌控 / 分工方案清晰可行 / 不会造成过度拆分）。输出第一行决策结论（批准 / 驳回 / 调整要求），后续行给一句理由。`,
    ].join('\n');
    ensure(DEC_DIR);
    fs.writeFileSync(decReq, decContent, 'utf8');
    processed[f] = { ts: tsISO(), status: 'awaiting-twin', decReq };
    setThrottle(state, agentId);
    changed.push(logActivity(`[繁衍] ${agentId} 提交繁衍申请 → 分身审批`,
      `子分组「${subGroupLabel}」(${divisionLines.length} 个子智能体)，已转 inbox/decisions/ 审批`, '繁衍'));
  }
  state.processed = processed;
}

/* ── 4. 处理决策：分身批准 → 管家执行 ── */
/**
 * 扫描 inbox/decisions/*reproduce-*.decision.md，若分身批准 → executeReproduce()。
 * 驳回/调整 → 标记申请 .DONE 驳回留痕。决策文件读后归档（防重复执行）。
 * @returns {string[]} 新增 activity 行
 */
function processDecisions(state, cfg, changed) {
  if (!cfg.enabled) return;
  if (!fs.existsSync(DEC_DIR)) return;
  const decisions = state.decisions || {};
  const files = fs.readdirSync(DEC_DIR).filter(f => /reproduce-.*\.decision\.md$/.test(f));
  for (const f of files) {
    if (decisions[f]) continue;                       // 已处理
    const content = readIf(path.join(DEC_DIR, f)) || '';
    const agentId = (content.match(/源任务\s*:\s*reproduce-(\S+)/) || [])[1] || f.match(/reproduce-(\S+)\.decision\.md/)?.[1];
    if (!agentId) { decisions[f] = { ts: tsISO(), status: 'skip-no-agent' }; continue; }
    const decLine = (content.match(/- 决策\s*:\s*(.+)/) || [])[1] || '';
    const reason = (content.match(/- 理由\s*:\s*(.+)/) || [])[1] || '';
    const approved = /批准|同意|通过|执行|准予|approve|approve/i.test(decLine);
    const rejected = /驳回|拒绝|不批准|不予|调整|reject/i.test(decLine);
    // 分工方案/子分组名以申请文件 inbox/reproduce-<agent>.md 为准（决策文件只含决策结论）
    const reqContent = readIf(path.join(INBOX, `reproduce-${agentId}.md`)) || content;
    const divisionLines = reqContent.split(/\r?\n/).filter(l => /^\s*[-•*]\s+\S+\s*\|/.test(l));
    const subGroupLabel = (reqContent.match(/## 子分组名\s*\n\s*([^\n]+)/) || [])[1]
      || (reqContent.match(/子分组名\s*:\s*(.+)/) || [])[1] || `${agentId} 域`;
    if (approved && !rejected) {
      try {
        const res = executeReproduce(agentId, subGroupLabel, divisionLines, reason, state);
        decisions[f] = { ts: tsISO(), status: 'executed', subGroup: res.subGroup, children: res.children };
        changed.push(logActivity(`[繁衍] ${agentId} 申请获批 → 已执行繁衍`,
          `子分组「${res.subGroupLabel}」+ ${res.children.length} 个子智能体，父升格组长`, '繁衍'));
      } catch (e) {
        decisions[f] = { ts: tsISO(), status: 'failed', error: e.message };
        changed.push(logActivity(`[繁衍] ${agentId} 执行繁衍失败`, e.message.slice(0, 120), '繁衍'));
      }
    } else if (rejected && !approved) {
      decisions[f] = { ts: tsISO(), status: 'rejected' };
      const done = path.join(INBOX, `reproduce-${agentId}.DONE`);
      fs.writeFileSync(done, `驳回：分身未批准（${decLine}）${reason ? '——' + reason : ''}`, 'utf8');
      changed.push(logActivity(`[繁衍] ${agentId} 申请被分身驳回`, decLine.slice(0, 80), '繁衍'));
    } else {
      // 调整 / 超时 / 红线升级用户 → 待用户，不执行
      decisions[f] = { ts: tsISO(), status: 'pending-user', decision: decLine };
      changed.push(logActivity(`[繁衍] ${agentId} 审批待用户/需调整`, decLine.slice(0, 80), '繁衍'));
    }
    archiveDecision(f);
  }
  state.decisions = decisions;
}

/** 归档决策文件（防重复执行） */
function archiveDecision(f) {
  try { ensure(path.join(DEC_DIR, 'archive')); fs.renameSync(path.join(DEC_DIR, f), path.join(DEC_DIR, 'archive', f)); } catch (e) {}
}

/* ── 5. 管家执行：org.json 建子分组 + 子智能体 + 父升格组长 ── */
/**
 * 执行繁衍：在父分组下创建子分组，子分组下创建子智能体，父智能体 role 升格"组长/协调者"。
 * 子智能体 identity 继承父智能体子集（persona/capabilities/keyPaths 子集）。
 * @returns { subGroup, subGroupLabel, children, parentUpgraded }
 */
function executeReproduce(agentId, subGroupLabel, divisionLines, reason, state) {
  const org = loadOrg();
  const parentNode = org.nodes[agentId] || {};
  const parentGroupId = parentNode.parent;            // 父智能体所在分组（如 grp-dev）
  const parentGroup = org.nodes[parentGroupId] || {};
  const parentIdent = readJsonSafe(path.join(AGENTS_DIR, agentId, 'identity.json')) || {};
  if (!parentGroupId) throw new Error(`智能体 ${agentId} 无 parent，无法建子分组`);
  if (!divisionLines || !divisionLines.length) throw new Error('无分工方案，拒绝执行');

  // 生成子分组 id：父分组下 <parentGroupId>-<agent>-mods，唯一性加短随机后缀
  const ts = tsStamp().replace(/[-:]/g, '');
  const base = `${parentGroupId}-${agentId}`;
  let subGroupId = `${base}-mods`;
  if (org.nodes[subGroupId]) subGroupId = `${base}-mods-${ts.slice(-6)}`;

  // 解析分工方案：`<id> | <label> | <duty>`
  const divisions = divisionLines.map((l, i) => {
    const parts = l.replace(/^\s*[-•*]\s*/, '').split('|').map(s => s.trim());
    const rawId = parts[0] || `${agentId}-sub${i + 1}`;
    const safeId = rawId.replace(/[^a-zA-Z0-9-_]/g, '-');
    const id = `${agentId}-${safeId}`;
    return { id, label: parts[1] || safeId, duty: parts[2] || `分工执行（${agentId} 子智能体）` };
  }).slice(0, cfgFor().maxChildrenPerRepro);

  // 建子分组节点（parent = 父分组，域仍属父分组 → 路由不破坏）
  const subGroupDir = `groups/${subGroupId}`;
  ensure(path.join(ORG_ROOT, subGroupDir, 'memory'));
  const subGroupNode = {
    id: subGroupId, type: 'group', label: subGroupLabel || (agentId + ' 域'),
    status: 'active', parent: parentGroupId, mainAgent: agentId,
    groupDir: subGroupDir, keywords: parentGroup.keywords || [],
    children: divisions.map(d => d.id), notes: `由 ${agentId} 繁衍生成（${tsISO()}），父智能体升格组长协调`,
  };
  org.nodes[subGroupId] = subGroupNode;

  // 建子智能体节点 + identity（继承父智能体子集）
  const createdChildren = [];
  for (const d of divisions) {
    const agentDir = `agents/${d.id}`;
    ensure(path.join(ORG_ROOT, agentDir, 'memory'));
    ensure(path.join(ORG_ROOT, agentDir, 'tasks'));
    const identity = {
      id: d.id, label: d.label, role: 'sub', status: 'sleeping', onlinePolicy: 'lazy',
      parent: subGroupId, createdAt: tsISO(),
      persona: `${d.duty}。作为 ${agentId} 的子智能体，继承其领域知识并聚焦 ${d.label} 专项。`,
      projectDir: parentIdent.projectDir || null,
      projectSummary: `${parentIdent.projectSummary || ''}（${d.label} 专项：${d.duty}）`.slice(0, 300),
      capabilities: (parentIdent.capabilities || []).slice(0, 3),
      keyPaths: parentIdent.keyPaths || {},
      permissions: parentIdent.permissions || [],
      sourceParent: agentId, notes: `由 ${agentId} 自我繁衍创建（${tsISO()}），领域继承自父智能体`,
    };
    fs.writeFileSync(path.join(ORG_ROOT, agentDir, 'identity.json'), JSON.stringify(identity, null, 2), 'utf8');
    // 初始 memory 引用父记忆
    const diary = path.join(ORG_ROOT, agentDir, 'memory', 'diary.md');
    if (!fs.existsSync(diary)) fs.writeFileSync(diary, `# ${d.label} — 记忆\n\n（由父智能体 ${agentId} 繁衍创建，读取父级记忆继承领域上下文）\n`, 'utf8');
    org.nodes[d.id] = {
      id: d.id, type: 'agent', label: d.label, role: 'sub', status: 'sleeping',
      onlinePolicy: 'lazy', parent: subGroupId, agentDir, spawnType: 'pi', children: [],
      sourceParent: agentId, notes: `由 ${agentId} 繁衍创建，路由继承父域`,
    };
    createdChildren.push(d.id);
  }

  // 父智能体升格组长/协调者：role 升级 + 记录子分组（children 指向子分组，作为组长协调）
  const wasRole = parentNode.role;
  parentNode.role = 'coordinator';
  parentNode.coordinatorOf = subGroupId;
  parentNode.notes = `${parentNode.notes || ''}\n[${tsISO()}] 升格组长/协调者：繁衍创建子分组「${subGroupLabel}」(${subGroupId}) + ${createdChildren.length} 个子智能体（${createdChildren.join('、')}）。role: ${wasRole}→coordinator`;
  parentNode.children = parentNode.children || [];
  if (!parentNode.children.includes(subGroupId)) parentNode.children.push(subGroupId);

  // 挂载：父分组 children 加子分组
  if (!parentGroup.children.includes(subGroupId)) parentGroup.children.push(subGroupId);

  const bak = saveOrg(org);
  return { subGroup: subGroupId, subGroupLabel: subGroupNode.label, children: createdChildren,
           parentGroup: parentGroupId, parentUpgraded: `${wasRole}→coordinator`, backup: bak };
}

function cfgFor() { return loadCfg(); }

/* ── 主入口：scan（twin 巡查调用） ── */
async function scan(opts) {
  const cfg = loadCfg();
  const state = loadState();
  const changed = [];
  if (!cfg.enabled) return changed;
  try { scanRequests(state, cfg, changed); } catch (e) { log('扫描繁衍申请失败:', e.message); }
  try { processDecisions(state, cfg, changed); } catch (e) { log('处理繁衍决策失败:', e.message); }
  saveState(state);
  return changed;
}

/* ── CLI ── */
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === 'scan') {
    const changed = await scan();
    console.log('繁衍巡检完成，本轮变化', changed.length, '条:');
    for (const l of changed) console.log('  ' + l);
    process.exit(0);
  }
  if (cmd === 'submit') {
    const agentId = argv[1];
    const label = argv[2] || (agentId + ' 域');
    const divisions = argv.slice(3).map(s => {
      const [id, duty] = s.split(':');
      return { id, label: id, duty };
    });
    const name = submitRequest(agentId, { subGroupLabel: label, divisions, reason: '演示/验证自我繁衍机制' });
    console.log('已写申请: inbox/' + name + '.md');
    console.log('请运行 twin-daemon scanDecisions 让分身审批（或 demo 手动批准）');
    process.exit(0);
  }
  if (cmd === 'evaluate') {
    const r = evaluate(argv[1] || 'mc-dev');
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }
  if (cmd === 'test') { await runSelfTest(); process.exit(0); }
  if (cmd === 'demo') { await runDemo(); process.exit(0); }
  console.log('用法: node lib/org-evolution.js scan | submit <agent> [label] [id:duty...] | evaluate <agent> | test | demo');
}

/* ── 内置自检：模拟 mc-dev 繁衍全链路 ── */
async function runSelfTest() {
  const assert = (cond, msg) => { console.log((cond ? '  ✅ ' : '  ❌ ') + msg); if (!cond) process.exitCode = 1; };
  console.log('== org-evolution 自检 ==');

  // 场景0：自评触发 —— mc-dev 应建议繁衍（多 mod 项目）
  {
    console.log('\n[场景0] 自评触发：mc-dev 项目健康度');
    const r = evaluate('mc-dev');
    assert(r.suggested, `mc-dev 建议繁衍（score=${r.score}, reasons=${r.reasons.length}）`);
    console.log('    detail:', r.detail.slice(0, 100));
  }

  // 场景1：申请 → 转决策（模拟 mc-dev 提交申请）
  {
    console.log('\n[场景1] 申请 → 转决策请求');
    const cfg = loadCfg();
    const state = { throttle: {}, processed: {}, decisions: {} };
    const reqName = submitRequest('mc-dev', {
      subGroupLabel: 'MC mod 域·虚无圣殿组',
      reason: '多 mod 项目（虚无圣殿/earth_human/fantasy_earth/plantmagic_fixes）文件面与任务堆积超出全盘掌控',
      divisions: [
        { id: 'temple', label: '虚无圣殿开发', duty: '主模组《虚无圣殿》NeoForge 开发' },
        { id: 'earth', label: '地球系列开发', duty: 'earth_human/fantasy_earth 地球系列' },
        { id: 'plantmagic', label: '植物魔法修复', duty: 'plantmagic_fixes_mod 修复' },
      ],
      privateData: false,
    });
    const changed = [];
    scanRequests(state, cfg, changed);
    const reqWritten = changed.some(l => l.includes('[繁衍]') && l.includes('提交繁衍申请'));
    assert(reqWritten, `mc-dev 申请 → 转 inbox/decisions/ 审批（change: ${(changed[0]||'').slice(0,60)}）`);
    const decFiles = fs.readdirSync(DEC_DIR).filter(f => /reproduce-mc-dev\.md$/.test(f) && !f.includes('.decision.'));
    assert(decFiles.length > 0, `决策请求落盘 inbox/decisions/${decFiles[decFiles.length-1] || ''}`);
    // 清理申请文件（避免干扰真实流程）
    try { fs.unlinkSync(path.join(INBOX, 'reproduce-mc-dev.md')); } catch (e) {}
    try { for (const f of decFiles) fs.unlinkSync(path.join(DEC_DIR, f)); } catch (e) {}
  }

  // 场景2：分身批准 → 执行繁衍（org.json 建子分组+子智能体+父升组长）
  {
    console.log('\n[场景2] 分身批准 → 管家执行繁衍');
    const cfg = loadCfg();
    const state = { throttle: {}, processed: {}, decisions: {} };
    // 先写申请文件（分工方案以申请文件为准）
    fs.writeFileSync(path.join(INBOX, 'reproduce-mc-dev.md'), [
      `# 繁衍申请：mc-dev`,
      `## 子分组名`,
      `MC mod 域·虚无圣殿组`,
      `## 理由`,
      `多 mod 项目超出全盘掌控`,
      `## 分工方案（子智能体列表）`,
      `- temple | 虚无圣殿开发 | 主模组 NeoForge 开发`,
      `- earth | 地球系列开发 | earth_human/fantasy_earth`,
      `- plantmagic | 植物魔法修复 | plantmagic_fixes_mod 修复`,
    ].join('\n'), 'utf8');
    // 构造一个"批准"决策文件
    const decisionFile = path.join(DEC_DIR, `${tsStamp()}-reproduce-mc-dev.decision.md`);
    fs.writeFileSync(decisionFile, [
      `# 分身决策：reproduce-mc-dev`,
      `- 源任务: reproduce-mc-dev`,
      `- 决策: 批准（项目确实超出单智能体掌控，分工清晰）`,
      `- 理由: mc-dev 多 mod 项目跨 4 个工程，值得拆子智能体并行`,
      `- 类型: 决策点`,
    ].join('\n'), 'utf8');
    // 备份 org.json 状态
    const orgBefore = JSON.stringify(loadOrg());
    const changed = [];
    processDecisions(state, cfg, changed);
    const executed = changed.some(l => l.includes('已执行繁衍'));
    assert(executed, `批准决策 → 执行繁衍（change: ${(changed[0]||'').slice(0,60)}）`);
    const org = loadOrg();
    const subGroupId = org.nodes['mc-dev'].coordinatorOf;
    assert(!!subGroupId && org.nodes[subGroupId], `父 mc-dev 升格组长，创建子分组 ${subGroupId}`);
    const children = org.nodes[subGroupId]?.children || [];
    assert(children.length === 3, `子分组下创建 3 个子智能体（${children.join(',')}）`);
    for (const c of children) {
      assert(!!org.nodes[c] && !!statOf(path.join(AGENTS_DIR, c, 'identity.json')), `子智能体 ${c} 节点 + identity 创建成功`);
      assert(org.nodes[c].parent === subGroupId, `子智能体 ${c} parent=${subGroupId}（路由继承父域）`);
    }
    assert(org.nodes['mc-dev'].role === 'coordinator', `父 mc-dev role 升级 coordinator`);
    assert(org.nodes['mc-dev'].children.includes(subGroupId), `父 mc-dev children 指向子分组（升格组长协调）`);
    assert(org.nodes[org.nodes[subGroupId].parent]?.children.includes(subGroupId), `子分组挂入父分组 children（路由不破坏）`);
    // 还原 org.json + 清理测试产物
    const orgAfter = loadOrg();
    for (const c of children) { delete orgAfter.nodes[c]; try { fs.rmSync(path.join(AGENTS_DIR, c), { recursive: true, force: true }); } catch (e) {} }
    delete orgAfter.nodes[subGroupId];
    orgAfter.nodes['mc-dev'].role = JSON.parse(orgBefore).nodes['mc-dev'].role;
    orgAfter.nodes['mc-dev'].coordinatorOf = undefined;
    orgAfter.nodes['mc-dev'].children = [];
    orgAfter.nodes['mc-dev'].notes = JSON.parse(orgBefore).nodes['mc-dev'].notes || '';
    const pg = orgAfter.nodes[org.nodes[subGroupId].parent];
    if (pg) pg.children = pg.children.filter(x => x !== subGroupId);
    saveOrg(orgAfter);
    try { for (const f of [decisionFile]) fs.unlinkSync(f); } catch (e) {}
    try { fs.unlinkSync(path.join(INBOX, 'reproduce-mc-dev.md')); } catch (e) {}
    console.log('  （org.json 已还原，测试子智能体已清理）');
  }
}

/* ── 端到端演示（手动批准路径，供验证/学习） ── */
async function runDemo() {
  const cfg = loadCfg();
  const state = loadState();
  const agentId = 'mc-dev';
  console.log('== org-evolution 演示：mc-dev 自我繁衍 ==');
  // 1. 自评
  const ev = evaluate(agentId, cfg);
  console.log(`\n[1] 自评 ${agentId}：suggested=${ev.suggested}  ${ev.detail}`);
  // 2. 写申请
  const reqName = submitRequest(agentId, {
    subGroupLabel: 'MC mod 域·虚无圣殿组',
    reason: '多 mod 项目（虚无圣殿/earth_human/fantasy_earth/plantmagic_fixes）超出全盘掌控，需子智能体分工',
    divisions: [
      { id: 'temple', label: '虚无圣殿开发', duty: '主模组《虚无圣殿》NeoForge 开发' },
      { id: 'earth', label: '地球系列开发', duty: 'earth_human/fantasy_earth 地球系列' },
      { id: 'plantmagic', label: '植物魔法修复', duty: 'plantmagic_fixes_mod 修复' },
    ],
    privateData: false,
  });
  console.log(`\n[2] 已写申请 inbox/${reqName}.md`);
  // 3. scan：转决策
  const changed1 = [];
  scanRequests(state, cfg, changed1);
  console.log(`\n[3] 转决策请求：${changed1[0] || '(无)'}`);
  // 4. 模拟分身批准（真实环境由 twin-daemon scanDecisions + user-twin 大脑审批）
  const decFiles = fs.readdirSync(DEC_DIR).filter(f => /reproduce-mc-dev\.md$/.test(f) && !f.includes('.decision.'));
  const decReq = decFiles[decFiles.length - 1];
  const decBase = decReq.replace(/\.md$/, '');
  fs.writeFileSync(path.join(DEC_DIR, decBase + '.decision.md'), [
    `# 分身决策：reproduce-mc-dev`,
    `- 源任务: reproduce-mc-dev`,
    `- 决策: 批准（项目确实超出单智能体掌控，分工清晰可行）`,
    `- 理由: mc-dev 跨 4 个 mod 工程，拆 3 个子智能体并行更高效`,
    `- 类型: 决策点`,
  ].join('\n'), 'utf8');
  console.log('\n[4] 分身批准（demo 模拟，真实由 user-twin 大脑决策）');
  // 5. 执行繁衍
  const changed2 = [];
  processDecisions(state, cfg, changed2);
  saveState(state);
  console.log(`\n[5] 执行繁衍：${changed2[0] || '(无)'}`);
  const org = loadOrg();
  const sub = org.nodes[agentId].coordinatorOf;
  if (sub) {
    console.log(`\n[6] 结果：子分组 ${sub}（${org.nodes[sub].label}）`);
    console.log(`    子智能体: ${org.nodes[sub].children.join('、')}`);
    console.log(`    父 ${agentId} role=${org.nodes[agentId].role}（升格组长）`);
    console.log(`    子分组 parent=${org.nodes[sub].parent}（仍属原域，路由不破坏）`);
    console.log('\n验证 org 树: node org.js tree');
  }
}

if (require.main === module) main();

module.exports = { scan, evaluate, submitRequest, executeReproduce, scanRequests, processDecisions, loadCfg };
