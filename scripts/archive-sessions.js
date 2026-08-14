#!/usr/bin/env node
/**
 * scripts/archive-sessions.js — 子代理会话归档（2026-08-12 长期积累策略）
 *
 * 会话复用后会产生长会话；但每个智能体目录的 sessions/ 会随任务增长堆积。
 * 本脚本把超过 N 天未活动的会话 jsonl 移到 archived-sessions/（历史可查、目录不失控）。
 *
 * 用法：
 *   node scripts/archive-sessions.js                     # 归档全部 org/agents/*（默认 7 天）
 *   node scripts/archive-sessions.js --days 3            # 自定义保留天数
 *   node scripts/archive-sessions.js --agent night-worker # 只归档指定智能体
 *   node scripts/archive-sessions.js --dry-run           # 只统计不动文件
 *
 * 安全阀：仅移 mtime 超过保留期的文件；正在写入的会话 mtime 新，天然不受影响。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AGENTS = path.join(ROOT, 'agents');
const DEFAULT_DAYS = 7;

function parseArgs(argv) {
  const out = { days: DEFAULT_DAYS, agents: [], dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--days') out.days = parseInt(argv[++i], 10) || DEFAULT_DAYS;
    else if (argv[i] === '--agent') out.agents.push(argv[++i]);
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

function archiveDirFor(agentDir) {
  return path.join(agentDir, 'archived-sessions');
}

function archiveAgent(agentDir, days, dryRun, stats) {
  const sessionsDir = path.join(agentDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) return;
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let files;
  try { files = fs.readdirSync(sessionsDir); } catch (e) { return; }
  const dest = archiveDirFor(agentDir);
  let moved = 0, bytes = 0;
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const fp = path.join(sessionsDir, f);
    let st;
    try { st = fs.statSync(fp); } catch (e) { continue; }
    if (st.mtimeMs >= cutoff) continue; // 近期活动：保留
    if (!dryRun) {
      try {
        fs.mkdirSync(dest, { recursive: true });
        fs.renameSync(fp, path.join(dest, f));
      } catch (e) { console.error(`  跳过 ${f}: ${e.message}`); continue; }
    }
    moved++; bytes += st.size;
  }
  if (moved > 0) {
    console.log(`${path.basename(agentDir)}: 归档 ${moved} 个会话 (${(bytes / 1024 / 1024).toFixed(1)} MB)${dryRun ? ' [dry-run]' : ''}`);
    stats.agents++; stats.files += moved; stats.bytes += bytes;
  }
}

function main() {
  const opts = parseArgs(process.argv);
  const stats = { agents: 0, files: 0, bytes: 0 };
  if (opts.agents.length > 0) {
    for (const a of opts.agents) {
      archiveAgent(path.join(AGENTS, a), opts.days, opts.dryRun, stats);
    }
  } else {
    const dirs = fs.readdirSync(AGENTS).filter(d => fs.statSync(path.join(AGENTS, d)).isDirectory());
    for (const d of dirs) archiveAgent(path.join(AGENTS, d), opts.days, opts.dryRun, stats);
  }
  console.log(`\n合计: ${stats.agents} 个智能体 / ${stats.files} 个会话 / ${(stats.bytes / 1024 / 1024).toFixed(1)} MB` +
    (opts.dryRun ? '（dry-run，未移动）' : ''));
}

main();
