#!/usr/bin/env node
/**
 * agents/learning-officer/patrol.js — 学习进化官定期巡检（v1，2026-08-05）
 *
 * 巡检内容：
 *   1. 实体审核：扫描各智能体 memory/entities.json 中 pending 超 24h 的实体
 *      - 自动 approve 条件：count > 3 且实体名出现在 knowledge/assets.md（高频+有据可查）
 *      - 其余留 pending，列入报告待分身/人工处理
 *   2. diary 纪律抽查：diary.md 是否存在、是否有自动写入条目（- ** 格式）
 *
 * 产出：
 *   - agents/learning-officer/memory/entity-review-log.md （追加本次审核日志）
 *   - stdout JSON 摘要
 *
 * 用法：node agents/learning-officer/patrol.js [--dry-run]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const memory = require(path.join(__dirname, '..', '..', 'lib', 'memory.js'));

const ORG_ROOT = path.join(__dirname, '..', '..');
const AGENTS_DIR = path.join(ORG_ROOT, 'agents');
const MY_MEMORY = path.join(__dirname, 'memory');
const REVIEW_LOG = path.join(MY_MEMORY, 'entity-review-log.md');
const DRY_RUN = process.argv.includes('--dry-run');
const PENDING_MS = 24 * 3600 * 1000;   // pending 超 24h 才进入审核队列

const now = Date.now();
const nowIso = new Date().toISOString().slice(0, 16).replace('T', ' ');

/** 实体 pending 起始时间（新字段 pendingSince 优先，旧数据用 firstSeen 当天 0 点兜底） */
function pendingAgeMs(e) {
  if (e.pendingSince) {
    const t = Date.parse(e.pendingSince);
    if (!Number.isNaN(t)) return now - t;
  }
  if (e.firstSeen) {
    const t = Date.parse(e.firstSeen + 'T00:00:00Z');
    if (!Number.isNaN(t)) return now - t;
  }
  return 0;   // 无时间信息 → 视为新实体，不进本轮审核
}

/** knowledge/assets.md 全文（实体"有据可查"判定依据） */
function loadAssetsText() {
  try { return fs.readFileSync(path.join(ORG_ROOT, 'knowledge', 'assets.md'), 'utf8'); }
  catch (e) { return ''; }
}

function patrol() {
  const assetsText = loadAssetsText();
  const report = {
    ts: nowIso, dryRun: DRY_RUN,
    agentsScanned: 0, pendingOver24h: 0,
    autoApproved: [], keptPending: [], diaryIssues: []
  };

  const agentIds = fs.readdirSync(AGENTS_DIR).filter(id => {
    try { return fs.statSync(path.join(AGENTS_DIR, id)).isDirectory(); } catch (e) { return false; }
  });

  for (const id of agentIds) {
    report.agentsScanned++;
    /* ── 1. 实体审核 ── */
    const entities = memory.listEntities(id);
    for (const e of entities) {
      if (e.status !== 'pending') continue;
      if (pendingAgeMs(e) < PENDING_MS) continue;   // 未满 24h，下轮再看
      report.pendingOver24h++;
      const inAssets = assetsText.includes(e.name);
      if ((e.count || 0) > 3 && inAssets) {
        report.autoApproved.push({ agent: id, name: e.name, count: e.count });
        if (!DRY_RUN) memory.reviewEntity(id, e.name, 'approve');
      } else {
        report.keptPending.push({
          agent: id, name: e.name, count: e.count || 0, inAssets,
          reason: (e.count || 0) <= 3 ? '频次不足(≤3)' : '未出现在 knowledge/assets.md'
        });
      }
    }

    /* ── 2. diary 纪律抽查 ── */
    const diaryPath = path.join(AGENTS_DIR, id, 'memory', 'diary.md');
    try {
      const diary = fs.readFileSync(diaryPath, 'utf8');
      const autoEntries = (diary.match(/^- \*\*/gm) || []).length;
      const hasManual = /^## 20\d\d-/m.test(diary.replace(/^## 20\d\d-\d\d-\d\d — 首次初始化/m, ''));
      if (autoEntries === 0 && !hasManual) {
        report.diaryIssues.push({ agent: id, issue: 'diary 仍为初始模板，无任何实质记录' });
      }
      // index.json 是否随 diary 更新（有自动条目就应有索引）
      if (autoEntries > 0) {
        const idxPath = path.join(AGENTS_DIR, id, 'memory', 'index.json');
        if (!fs.existsSync(idxPath)) {
          report.diaryIssues.push({ agent: id, issue: 'diary 有自动条目但 index.json 缺失' });
        }
      }
    } catch (e) {
      report.diaryIssues.push({ agent: id, issue: 'diary.md 不存在' });
    }
  }

  /* ── 写审核日志 ── */
  if (!DRY_RUN) {
    fs.mkdirSync(MY_MEMORY, { recursive: true });
    const lines = [
      `\n## ${nowIso} 巡检`,
      `- 扫描智能体: ${report.agentsScanned} 个；pending>24h 实体: ${report.pendingOver24h} 个`,
      report.autoApproved.length
        ? `- ✅ 自动 approve（高频>3 且见 assets.md）: ${report.autoApproved.map(x => `${x.agent}/${x.name}(x${x.count})`).join(', ')}`
        : '- ✅ 自动 approve: 0（无符合条件实体）',
      report.keptPending.length
        ? `- ⏳ 留 pending 待分身处理: ${report.keptPending.map(x => `${x.agent}/${x.name}(x${x.count}, ${x.reason}${x.inAssets ? '' : '+不在assets'})`).join('; ')}`
        : '- ⏳ 留 pending: 0',
      report.diaryIssues.length
        ? `- ⚠️ diary 纪律问题: ${report.diaryIssues.map(x => `${x.agent}: ${x.issue}`).join('; ')}`
        : '- diary 纪律: 无问题'
    ].join('\n');
    const header = fs.existsSync(REVIEW_LOG) ? '' :
      '# 实体审核日志（learning-officer 巡检产出）\n\n> patrol.js 每次巡检追加一节；approve 规则：count>3 且实体名出现在 knowledge/assets.md\n';
    fs.appendFileSync(REVIEW_LOG, header + lines + '\n', 'utf8');
    // 自身 diary 记一笔（记忆规范）
    memory.appendDiary('learning-officer', {
      task: '定期巡检（实体审核+diary抽查）',
      result: `扫描${report.agentsScanned}个智能体，approve ${report.autoApproved.length}，留pending ${report.keptPending.length}，diary问题 ${report.diaryIssues.length}`,
      lessons: report.diaryIssues.length ? report.diaryIssues.map(x => x.agent + ':' + x.issue) : []
    });
  }

  console.log(JSON.stringify(report, null, 2));
  return report;
}

patrol();
