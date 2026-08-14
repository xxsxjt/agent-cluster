#!/usr/bin/env node
/**
 * agents/channel-manager/patrol.js — 渠道管理智能体巡检（v1，2026-08-08）
 *
 * 职责：巡查渠道健康 + 恢复探测决策 + 决策留痕。
 *   1. 读 logs/channel-health.json，识别冷却/失败渠道
 *   2. 对到期（≥30 分钟，--force 忽略间隔）的做轻量探测（GET /v1/models）
 *   3. 成功 → markRecovered（路由自动切回高优先级）；失败 → 延长冷却
 *   4. 决策写 agents/twin/activity.log（[渠道] tag）+ 自身 memory/diary.md
 *
 * 用法：
 *   node agents/channel-manager/patrol.js            # 按 30 分钟间隔节流
 *   node agents/channel-manager/patrol.js --force    # 忽略间隔立即探测全部冷却渠道
 *   node agents/channel-manager/patrol.js --report   # 只出报告不探测
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cf = require(path.join(__dirname, '..', '..', 'lib', 'channel-fallback'));
const memory = require(path.join(__dirname, '..', '..', 'lib', 'memory.js'));

const MY_MEMORY = path.join(__dirname, 'memory');
const FORCE = process.argv.includes('--force');
const REPORT_ONLY = process.argv.includes('--report');

async function patrol() {
  // 一致性修复：启动即复核整张健康表（老代码曾写 fails>0 但 status 残留 recovered/probeOk=true）
  const reconcile = cf.reconcileHealth();
  let health = cf.readHealth();
  const now = Date.now();

  // 盘点：哪些渠道在冷却/失败
  const cooling = [];
  const failed = [];
  for (const p of Object.keys(health)) {
    const rec = health[p];
    if (!rec) continue;
    if (rec.fails >= cf.RETRY_THRESHOLD) cooling.push({ provider: p, rec });
    else if (rec.fails > 0) failed.push({ provider: p, rec });
  }

  const summary = {
    ts: new Date().toISOString(),
    force: FORCE,
    reconcile,
    probeIntervalMs: cf.PROBE_INTERVAL_MS,
    coolingChannels: cooling.length,
    failedChannels: failed.length,
    healthyChannels: Object.keys(health).length - cooling.length - failed.length,
    probes: []
  };

  // 恢复探测
  if (!REPORT_ONLY) {
    const interval = FORCE ? 0 : cf.PROBE_INTERVAL_MS;
    summary.probes = await cf.probeCoolingChannels(interval);
    health = cf.readHealth();   // 探测可能更新了健康表，重读
    summary.after = health;
  }

  // 决策留痕：memory/diary.md
  const nowLocal = new Date().toLocaleString();
  const probeLine = summary.probes.length
    ? summary.probes.map(x => x.recovered ? `✅ ${x.provider} 恢复` : `⏳ ${x.provider} 未恢复(code=${x.code})`).join('; ')
    : '无到期探测';
  memory.appendDiary('channel-manager', {
    task: `渠道健康巡检（${FORCE ? '强制' : '常规'}）`,
    result: `冷却${cooling.length}个/失败${failed.length}个/健康${summary.healthyChannels}个；${probeLine}`,
    lessons: summary.probes.filter(p => p.recovered).map(p => `${p.provider} 已恢复切回高优先级`) 
      .concat(summary.probes.filter(p => !p.recovered).map(p => `${p.provider} 仍冷却`))
  });

  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

patrol().catch(e => { console.error('巡检失败:', e.message); process.exit(1); });
