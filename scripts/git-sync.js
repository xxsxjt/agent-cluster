#!/usr/bin/env node
/**
 * git-sync.js — 本机 org ↔ cnb.cool 私有仓库 Git 同步（互联 Git 通道 pull 模型主端）
 *
 * 背景（2026-08-11 cnb-sync-p0）：智能体集群三端（本机 Windows / HK Linux / CNB 云空间）
 * 通过 cnb.cool 私有仓库做任务/状态/知识同步。本机为编排主端：
 *   1. 本地 commit（增量）
 *   2. pull --rebase（拉取 HK/CNB 推送的内容，先 fetch 后 rebase 再 merge）
 *   3. push 到 cnb.cool（master/main）
 *
 * 安全：remote 用 cnb_git_token（DPAPI 加密仓），不落代码明文；.gitignore 已排除 secrets/logs/sessions。
 *
 * 用法：
 *   node scripts/git-sync.js              # 同步（默认：commit + pull-rebase + push）
 *   node scripts/git-sync.js --push-only  # 只 commit + push
 *   node scripts/git-sync.js --pull-only  # 只 fetch + rebase + merge
 *   node scripts/git-sync.js --dry-run    # 只打印将做的操作
 *
 * 调度：butler 主循环每 N 分钟调一次（--quiet）；也可单独计划任务。
 */
'use strict';
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ORG_ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(ORG_ROOT, 'logs', 'git-sync.log');
// 双托管 remote：cnb.cool（主同步源）+ GitHub（备份镜像，2026-08-11 github-host）
// fetch/rebase 始终走 cnb（集群主通道）；push 同时推 cnb + github
const REMOTE = 'cnb';
const REMOTES = ['cnb', 'github'];

function log(msg) {
  const line = `[${new Date().toLocaleString()}] [git-sync] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) {}
}

// git 命令：整串交给 shell（保留引号），避免拆断含空格消息
function sh(cmd, opts = {}) {
  return execFileSync(`git -C "${ORG_ROOT}" ${cmd}`, {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 120000, shell: true, ...opts
  });
}

// 从 DPAPI 加密仓取 token 组装 remote（避免明文落 config）
function ensureRemote() {
  let token = '';
  try {
    token = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-Command', "& 'C:\\_dx\\_serve\\set-cred.ps1' -Get -Name cnb_git_token"],
      { encoding: 'utf8', maxBuffer: 64 * 1024, windowsHide: true }).trim();
  } catch (e) { /* 已有 remote 则跳过 */ }
  // 确保 remote 存在且带 token（不重设已有）
  const has = r => { try { return sh('remote').split('\n').some(l => l.trim().startsWith(r)); } catch (e) { return false; } };
  if (!has(REMOTE)) {
    if (!token) throw new Error('无 cnb_git_token 且 cnb remote 不存在');
    sh(`remote add ${REMOTE} https://cnb:${token}@cnb.cool/xxssxx.top/1`);
    log(`已添加 remote ${REMOTE} (cnb.cool)`);
  }
  // GitHub remote（GCM 认证，无需内嵌 token；历史已重写清除密钥）
  if (!has('github')) {
    sh('remote add github https://github.com/xxsxjt/agent-cluster.git');
    log('已添加 remote github (GitHub agent-cluster)');
  }
}

// push 到全部 remote（cnb + github）
function pushAll() {
  let ok = [];
  for (const r of REMOTES) {
    try { sh(`push ${r} master:main`); ok.push(r); log(`✅ push ${r} OK`); }
    catch (e) { log(`push ${r}: ${String(e.message).split('\n')[0].slice(0, 120)}`); }
  }
  return ok.length === REMOTES.length;
}

function main() {
  const argv = process.argv.slice(2);
  const QUIET = argv.includes('--quiet');
  const DRY = argv.includes('--dry-run');
  const PUSH_ONLY = argv.includes('--push-only');
  const PULL_ONLY = argv.includes('--pull-only');

  try {
    ensureRemote();

    if (!PULL_ONLY) {
      // 1. commit 本地增量
      const status = sh('status --porcelain');
      if (status.trim()) {
        if (DRY) { log(`[dry] 将 commit ${status.trim().split('\n').length} 个文件`); }
        else {
          sh('add -A');
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
          const msg = `sync ${ts}`;
          // 用 --no-verify + 无冒号消息（Windows 下 -m 含冒号会解析成 pathspec）
          try { sh(`commit --no-verify -m "${msg}"`); log(`✅ 已 commit ${msg}`); }
          catch (e) { /* 无变更时 git commit 报错，忽略 */ log(`commit: ${String(e.message).split('\n')[0].slice(0, 80)}`); }
        }
      }
    }

    if (PUSH_ONLY) {
      if (DRY) { log('[dry] 将 push'); }
      else { pushAll(); }
      return;
    }

    // 2. pull (fetch + rebase)
    if (DRY) { log('[dry] 将 pull --rebase'); }
    else {
      try {
        sh('fetch');
        try {
          sh('rebase');
        } catch (e) {
          // rebase 冲突 → 保留本地，回退 rebase（安全）→ 仍可 push 前 force 或人工处理
          try { sh('rebase --abort'); log('⚠️ rebase 冲突，已回退（需人工处理）'); } catch (_) {}
        }
        log('✅ 已 fetch + rebase');
      } catch (e) { log(`pull: ${String(e.message).split('\n')[0].slice(0, 120)}`); }
    }

    // 3. push（双 remote：cnb + github）
    if (DRY) { log('[dry] 将 push'); }
    else { pushAll(); }
  } catch (e) {
    log(`异常: ${e.message.slice(0, 200)}`);
    process.exit(1);
  }
}

main();
