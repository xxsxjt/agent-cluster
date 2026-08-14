#!/usr/bin/env node
/**
 * agents/learning-officer/tools/entity-review-batch.js — 实体积压批量审批（v1，2026-08-12）
 *
 * 背景：patrol.js 自动 approve 条件过苛（count>3 且 实体名出现在 knowledge/assets.md），
 * 导致 pending 实体持续积压（2026-08-11 的 183 → 2026-08-12 的 303），474 实体中
 * approved 仅 1、rejected 0。积压主体是零 LLM 抽取的噪声 token（纯大写缩写、英文碎片词、
 * 中文残缺/一次性状态短语），非知识实体，注入上下文纯属噪音。
 *
 * 批量审批策略（3 类）：
 *   [REJECT] 无知识价值噪声，注入上下文有害：
 *     R1 纯大写缩写  /^[A-Z0-9]{2,6}$/  （DONE/FAILED/PID/CNB/HTTP…）
 *     R2 英文碎片 token（不在专名白名单 且 count<=2，单次出现的通用词/截断）
 *     R3 中文残缺/一次性状态短语（以截断词或完成态动词结尾）
 *   [APPROVE] 稳定知识概念/专名，值得沉淀进上下文：
 *     A1 英文专名白名单（品牌/项目/框架/工具）
 *     A2 英文高频非碎片（count>=4 且非通用词）
 *     A3 中文完整语义实体（非 R3 残缺）
 *   [PENDING] 其余少量（规则未覆盖）保留待人工
 *
 * 用法：node tools/entity-review-batch.js [--dry-run]
 * 产出：memory/entity-review-batch.md（本次审批日志）；dry-run 仅输出统计不落盘。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const memory = require(path.join(__dirname, '..', '..', '..', 'lib', 'memory.js'));
const DRY_RUN = process.argv.includes('--dry-run');

const AGENTS_DIR = path.join(__dirname, '..', '..', '..', 'agents');
const MY_MEMORY = path.join(__dirname, '..', 'memory');

/* ── 白名单：英文专名（品牌/项目/框架/工具，approve） ── */
const EN_WHITELIST = new Set([
  'UUMit','Tailscale','Tailscaled','Gradle','TShock','TShockAPI','HKWorld','Terraria',
  'ComfyUI','WorkBuddy','LobsterAI','Marvis','Agnes','Takina','Hermes','CurseForge',
  'Chinamaxxing','Cloudflare','Debian','Python','GitHub','Android','Kotlin','XuWu',
  'Java','Temple','Nihility','Git','NeedsLogin','Backlog','LICENSE','PRODUCT','VERSION',
  'Profile','ConnectTimeout','SIGTERM','ECONNREFUSED'
]);
/* 英文通用碎片词（即便 count 高也 reject，非知识实体） */
const EN_COMMON = new Set([
  'Users','Material','Check','Report','Plan','Create','First','Let','Main','Class',
  'Command','Running','BackendState','AuthURL','NoState','HaveNodeKey','Machine','Config',
  'Run','Skill','Token','Model','Tab','Bot','Health','CHANNELS','USERS','TOKENS','URL',
  'Received','Disconnected','WARNING','See','Part','Access','Trust','Zero','Fre'
]);
/* 中文残缺/一次性状态后缀（截断或完成态，reject） */
const CN_REJECT_SUFFIX = /(由|从|任|并|为|变|已|已完成|完成|已恢复|恢复|恢复正常|巡检完成|就绪|已加载|挂载|仍活跃|此前已被停|被停|fallb|fallback|admi|致大量|无故障)$/;

function classify(e) {
  const name = e.name;
  /* 纯大写缩写 */
  if (/^[A-Z0-9]{2,6}$/.test(name)) return 'reject';           // R1
  /* 纯 ASCII 英文 */
  if (/^[\x00-\x7F]+$/.test(name)) {
    if (EN_WHITELIST.has(name)) return 'approve';              // A1
    if (EN_COMMON.has(name)) return 'reject';                  // 通用词
    if ((e.count || 0) >= 4) return 'approve';                 // A2 高频
    return (e.count || 0) >= 2 ? 'approve' : 'reject';         // 单次英文碎片 → R2
  }
  /* 中文 */
  if (CN_REJECT_SUFFIX.test(name)) return 'reject';            // R3
  return 'approve';                                            // A3 完整语义
}

function main() {
  const stat = { scanned: 0, approve: [], reject: [], pending: 0 };
  for (const id of fs.readdirSync(AGENTS_DIR)) {
    const f = path.join(AGENTS_DIR, id, 'memory', 'entities.json');
    if (!fs.existsSync(f)) continue;
    let db; try { db = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
    for (const e of (db.entities || [])) {
      if (e.status !== 'pending') continue;
      stat.scanned++;
      const act = classify(e);
      if (act === 'approve') { stat.approve.push({ agent: id, name: e.name, count: e.count }); }
      else if (act === 'reject') { stat.reject.push({ agent: id, name: e.name, count: e.count }); }
      else stat.pending++;
    }
  }
  console.log('扫描 pending 实体:', stat.scanned);
  console.log('→ 拟 approve:', stat.approve.length, '(专名/高频/中文语义)');
  console.log('→ 拟 reject :', stat.reject.length, '(噪声:缩写/英文碎片/中文残缺)');
  console.log('→ 留 pending:', stat.pending);
  console.log('\n[approve 预览]', stat.approve.slice(0, 120).map(x => `${x.agent}/${x.name}(${x.count})`).join(', '));
  console.log('\n[reject 预览]', stat.reject.slice(0, 60).map(x => `${x.agent}/${x.name}(${x.count})`).join(', '));
  if (DRY_RUN) { console.log('\n[dry-run] 未落盘。'); return; }

  /* 执行 */
  const log = [`\n## ${new Date().toISOString().slice(0, 16).replace('T', ' ')} 批量审批`];
  log.push(`- 扫描 pending: ${stat.scanned}；approve ${stat.approve.length}；reject ${stat.reject.length}；留 pending ${stat.pending}`);
  log.push(`- approve: ${stat.approve.map(x => `${x.agent}/${x.name}(${x.count})`).join(', ')}`);
  log.push(`- reject: ${stat.reject.map(x => `${x.agent}/${x.name}(${x.count})`).join(', ')}`);
  for (const x of stat.approve) memory.reviewEntity(x.agent, x.name, 'approve');
  for (const x of stat.reject) memory.reviewEntity(x.agent, x.name, 'reject');
  const LOG_FILE = path.join(MY_MEMORY, 'entity-review-batch.md');
  const header = fs.existsSync(LOG_FILE) ? '' : '# 实体批量审批日志\n\n> entity-review-batch.js 批量审批产出；策略见脚本头注释\n';
  fs.appendFileSync(LOG_FILE, header + log.join('\n') + '\n', 'utf8');
  console.log('\n✅ 已执行并写入', LOG_FILE);
}

main();
