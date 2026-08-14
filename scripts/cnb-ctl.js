#!/usr/bin/env node
/**
 * cnb-ctl.js — CNB 云开发空间控制工具（list / start / ssh / detail）
 *
 * 背景（2026-08-11 P0 cnb-sync-p0）：CNB 三云空间（8核16G 国内 Debian 13）接入集群，
 * 空间实例可能休眠/被回收/重启（重启后 SSH 地址变化）——一切从 API 拿最新状态，不硬编码地址。
 *
 * 用法：
 *   node scripts/cnb-ctl.js list                    # 三空间状态（按 slug 分组，API list）
 *   node scripts/cnb-ctl.js start <1|2|3> [--sn xxx] # 启动空间（默认启动该 slug 最新实例；可选指定 sn）
 *   node scripts/cnb-ctl.js ssh <1|2|3>             # 输出最新实例的 SSH 主机（detail 解析）
 *   node scripts/cnb-ctl.js detail <1|2|3>          # 最新实例完整 detail
 *   node scripts/cnb-ctl.js wait <1|2|3> [--timeout s] # 轮询空间 running（默认 180s）
 *
 * 配置：CNB_SPACES 定义 slug 与空间编号映射；token 从 DPAPI 加密仓读取（不落代码明文）。
 * SSH key：~/.ssh/id_rsa_cnb（与 cnb-task.js 一致）。
 */
'use strict';
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

// ── 配置 ───────────────────────────────────────────────
const API = 'https://api.cnb.cool';
const KEY = path.join(os.homedir(), '.ssh', 'id_rsa_cnb');

// 空间编号 → slug / 用途映射（slug 是仓库路径，实例可以多个，取最新）
// 2026-08-12 repo-plan-twin-sync：登记 4/5 规划用途（仓库墙显示 4/5 已存在（8/9 建）——空仓库 0 ref——从未推代码/启实例；2026-08-12 21:2x 修正此前'未创建'误判，
// 需用户在 cnb.cool 建仓后 start 空间；detail/ssh 对无实例空间会报错属正常）
const CNB_SPACES = {
  '1': { slug: 'xxssxx.top/1', note: '开发主力（org 框架/日常任务）' },
  '2': { slug: 'xxssxx.top/2', note: '构建机（Android/Java/Gradle 构建）' },
  '3': { slug: 'xxssxx.top/3', note: '测试沙箱' },
  '4': { slug: 'xxssxx.top/4', note: '大数据/存储（仓库已建——空——待启用）' },
  '5': { slug: 'xxssxx.top/5', note: '新项目孵化（仓库已建——空——待启用）' },
};

function getToken() {
  // 多来源读取 cnb 仓库 token：
  //   1. 环境变量 CNB_GIT_TOKEN（HK/容器友好）
  //   2. secrets/cnb-token 文件（HK Linux 部署，hk-cnb-pull.sh 写入，600）
  //   3. Windows DPAPI 加密仓（本机 set-cred.ps1）
  if (process.env.CNB_GIT_TOKEN) return process.env.CNB_GIT_TOKEN.trim();
  const secretFile = path.join(path.resolve(__dirname, '..'), 'secrets', 'cnb-token');
  try {
    if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
  } catch (e) {}
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-Command', "& 'C:\\_dx\\_serve\\set-cred.ps1' -Get -Name cnb_git_token",
    ], { encoding: 'utf8', maxBuffer: 64 * 1024, windowsHide: true });
    if (out && out.trim()) return out.trim();
  } catch (e) {}
  throw new Error('无法读取 cnb_git_token（需设置 CNB_GIT_TOKEN 环境变量、secrets/cnb-token 文件，或 DPAPI）');
}

function httpGet(url, token) {
  const r = execFileSync('curl', ['-s', '--noproxy', '*', '-H', `Authorization: Bearer ${token}`, url], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return JSON.parse(r);
}
function httpPost(url, token, body) {
  const args = ['-s', '--noproxy', '*', '-X', 'POST', '-H', `Authorization: Bearer ${token}`];
  if (body) { args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body)); }
  args.push(url);
  const r = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return JSON.parse(r);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(...a) {
  const line = `[${new Date().toLocaleTimeString()}] [cnb-ctl] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(path.join(path.resolve(__dirname, '..'), 'logs', 'cnb-ctl.log'), line + '\n', 'utf8'); } catch (e) {}
}

// 拿到某空间所有实例（按 create_time 倒序，最新的在前）
function listWorkspaces(token, slug) {
  const d = httpGet(`${API}/workspace/list`, token);
  const list = (d.list || []).filter(w => w.slug === slug);
  list.sort((a, b) => (b.create_time || '').localeCompare(a.create_time || ''));
  return list;
}
function latestWs(token, slug) {
  const list = listWorkspaces(token, slug);
  if (!list.length) return null;
  return list[0]; // create_time 倒序 → 最新
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'list';
  const space = argv[1] || '1';
  const sp = CNB_SPACES[space];
  if (!sp) { console.error(`未知空间: ${space}（可选 1|2|3）`); process.exit(2); }
  const token = getToken();

  if (cmd === 'list') {
    const d = httpGet(`${API}/workspace/list`, token);
    const rows = (d.list || []).filter(w => Object.values(CNB_SPACES).some(s => s.slug === w.slug));
    console.log('slug              sn                     status     duration(s)  sshHost');
    for (const w of rows) {
      const ip = w.sshHost || '';
      console.log(`${w.slug.padEnd(15)} ${w.sn.padEnd(22)} ${(w.status||'').padEnd(10)} ${String(w.duration||'').padEnd(11)} ${ip}`);
    }
    console.log(`\n总实例 ${rows.length} 个（三空间 slug 聚合）`);
    for (const [n, s] of Object.entries(CNB_SPACES)) {
      const l = listWorkspaces(token, s.slug);
      const on = l.filter(w => w.status === 'running');
      const latest = l[0];
      console.log(`  空间${n} (${s.note}): ${on.length} running / ${l.length} 实例; 最新=${latest ? latest.sn : '-'} (${latest ? latest.status : '-'})`);
    }
    return;
  }

  if (cmd === 'detail') {
    const w = latestWs(token, sp.slug);
    if (!w) { console.error(`空间${space} 无实例`); process.exit(1); }
    console.log(JSON.stringify(w, null, 2));
    return;
  }

  if (cmd === 'ssh') {
    const w = latestWs(token, sp.slug);
    if (!w) { console.error(`空间${space} 无实例`); process.exit(1); }
    // 从 detail 拿最新 ssh 地址（实例重启后地址变）；detail.sshHost 可能带 'ssh ' 前缀，剥离
    const detail = httpGet(`${API}/${sp.slug}/-/workspace/detail/${w.sn}`, token);
    let sshHost = detail && (detail.sshHost || detail.ssh || detail.host) || w.sshHost || '';
    sshHost = String(sshHost).replace(/^\s*ssh\s+/, '').trim();
    if (!sshHost && w.pipeline_id) sshHost = `${w.pipeline_id}@cnb.space`;
    console.log(sshHost);
    return;
  }

  if (cmd === 'start') {
    const snArg = argv.includes('--sn') ? argv[argv.indexOf('--sn') + 1] : null;
    const body = { branch: 'main' };
    if (snArg) body.sn = snArg;
    const resp = httpPost(`${API}/${sp.slug}/-/workspace/start`, token, body);
    console.log(JSON.stringify(resp));
    if (resp && resp.errmsg) { log(`空间${space} 启动失败: ${resp.errmsg}`); process.exit(1); }
    log(`空间${space} (${sp.slug}) 已提交启动 → ${resp.sn || ''}`);
    return;
  }

  if (cmd === 'wait') {
    const tmo = argv.includes('--timeout') ? parseInt(argv[argv.indexOf('--timeout') + 1], 10) : 180;
    const deadline = Date.now() + tmo * 1000;
    while (Date.now() < deadline) {
      const l = listWorkspaces(token, sp.slug);
      const running = l.filter(w => w.status === 'running');
      if (running.length) {
        const w = running[0];
        const detail = httpGet(`${API}/${sp.slug}/-/workspace/detail/${w.sn}`, token);
        let sshHost = detail && (detail.sshHost || detail.ssh || detail.host) || w.pipeline_id || '';
        sshHost = String(sshHost).replace(/^\s*ssh\s+/, '').trim();
        console.log(`空间${space} RUNNING: ${w.sn} ssh=${sshHost}`);
        return;
      }
      await sleep(10000);
    }
    console.error(`空间${space} 等待超时（${tmo}s 未 running）`);
    process.exit(1);
  }

  console.error(`未知命令: ${cmd}（可选 list/start/ssh/detail/wait）`);
  process.exit(2);
}

main().catch(e => { console.error(e.message); process.exit(1); });
