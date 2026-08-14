#!/usr/bin/env node
/**
 * dual-sync.js — 双集群（本机 Windows ↔ HK Linux）双向同步引擎
 *
 * 目标（用户 2026-08-08）：本机 org（C:\...\org，Tailscale 100.103.204.86）
 *   ↔ HK org（/data/agent-cluster，100.97.18.59:43891）数据双向一致：
 *   分身记录 / 任务状态 / 组织树 / knowledge。
 *
 * 设计要点：
 *   1. 本机为"编排主端"，脚本在本机运行，单向可达 HK（ssh/scp），双向文件统一由本机收敛。
 *   2. 冲突策略（config/dual-sync.json）：
 *      - org.json        → 结构合并（本机=主，吸收 HK 独有节点 + children 并集；暂态字段以本机为准）→ 防两侧 butler 写状态导致抖动
 *      - activity.log    → 行级合并（去重保留顺序，幂等收敛）
 *      - 其余同步项       → latest（按 mtime 取较新一方，diffEps 阈值防抖动）
 *      - .PID / 源任务 .md / 运行中状态 → 不同步（防覆盖本地运行态 + 防 watcher 重派循环）
 *   3. 防循环：只同步 .DONE/.FAILED 终态标记（butler 只 scan .md，不会因 .DONE 重派）；
 *      不同步 .md 源任务文件 → 不会跨端重复派发。
 *   4. 幂等：同一状态连续跑无变化。
 *
 * 用法：
 *   node scripts/dual-sync.js            # 双向同步（默认，写日志）
 *   node scripts/dual-sync.js --dry-run  # 只打印将执行的动作，不实际写
 *   node scripts/dual-sync.js --quiet    # 仅错误时输出（供定时调度）
 *
 * SSH 凭据与 hk-task.js 一致（key 路径来自 config，不落代码明文之外）。
 */
'use strict';
// Windows 下 ssh/scp 弹窗闪现修复：改走 win-spawn 兜底（默认 windowsHide:true），见 lib/win-spawn.js
const { execFile } = require('../lib/win-spawn');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ORG_ROOT = path.resolve(__dirname, '..');
const SPEC = require(path.join(ORG_ROOT, 'config', 'dual-sync.json'));
const LOG_FILE = path.join(ORG_ROOT, 'logs', 'dual-sync.log');
const EPS = SPEC.diffEps || 60;

const HK = SPEC.hk || {};
const HK_HOST = HK.host || '100.97.18.59';
const HK_PORT = HK.port || '43891';
const HK_USER = HK.user || 'root';
const HK_KEY  = (HK.key || '~/.ssh/id_ed25519_xxsx_hk').replace(/^~/, os.homedir());
const HK_ORG  = HK.org || '/data/agent-cluster';
const SSH_DEST = `${HK_USER}@${HK_HOST}`;
const SSH_BASE = ['-p', HK_PORT, '-i', HK_KEY, '-o', 'BatchMode=yes',
                  '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
                  '-o', 'StrictHostKeyChecking=accept-new'];

const DRY = process.argv.includes('--dry-run');
const QUIET = process.argv.includes('--quiet');

/* ── 小工具 ─────────────────────────────────────────────── */
function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] [dual-sync] ${msg}`;
  if (!QUIET) console.log(line);
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) {}
}
function warn(msg) { const line = `[${new Date().toLocaleTimeString()}] [dual-sync] ⚠️ ${msg}`; console.log(line); try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) {} }

function ssh(cmd, timeoutMs) {
  return new Promise(resolve => {
    execFile('ssh', [...SSH_BASE, SSH_DEST, cmd], { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs || 60000 },
      (err, stdout, stderr) => {
        const cleanErr = String(stderr || '').split('\n').filter(l => !l.includes('post-quantum') && !l.includes('store now') && !l.includes('upgraded')).join('\n').trim();
        resolve({ ok: !err || !!cleanErr, code: err ? err.code : 0, out: (stdout || '').trim(), err: cleanErr });
      });
  });
}
function scp(from, to) {
  return new Promise(resolve => {
    const scpBase = ['-P', HK_PORT, '-i', HK_KEY, '-o', 'BatchMode=yes', '-p',
                     '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new'];
    execFile('scp', [...scpBase, from, to], { maxBuffer: 32 * 1024 * 1024, timeout: 120000 },
      (err) => resolve({ ok: !err, code: err ? err.code : 0, err: err ? String(err.message || err) : '' }));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── glob 匹配 ──────────────────────────────────────────── */
function globToRe(glob) {
  const parts = glob.split('/').map(seg => seg
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '@@DEEP@@')
    .replace(/\*/g, '[^/]*')
    .replace(/@@DEEP@@/g, '.*'));
  return new RegExp('^' + parts.join('/') + '$');
}
const _reCache = {};
function globMatch(glob, rel) { if (!_reCache[glob]) _reCache[glob] = globToRe(glob); return _reCache[glob].test(rel); }

/* ── 清单收集 ───────────────────────────────────────────── */
// 递归遍历本地，返回 Map<relPath, {mtime, size}>
function walkLocal(dir, base, map) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of ents) {
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (ent.isDirectory()) { walkLocal(full, base, map); continue; }
    if (ent.isFile()) {
      try { const st = fs.statSync(full); map.set(rel, { mtime: st.mtimeMs / 1000, size: st.size }); }
      catch (e) {}
    }
  }
}
function localManifest() {
  const map = new Map();
  walkLocal(ORG_ROOT, ORG_ROOT, map);
  return map;
}
async function hkManifest() {
  const map = new Map();
  const r = await ssh(`find ${HK_ORG} -type f -printf '%P|%s|%T@\\n'`, 120000);
  for (const line of r.out.split('\n')) {
    if (!line) continue;
    const i1 = line.lastIndexOf('|'), i2 = line.lastIndexOf('|', i1 - 1);
    if (i1 < 0 || i2 < 0) continue;
    const rel = line.slice(0, i2), size = parseInt(line.slice(i2 + 1, i1), 10), mt = parseFloat(line.slice(i1 + 1));
    if (rel && !rel.startsWith('.git/') && !rel.startsWith('node_modules/')) map.set(rel, { mtime: mt, size });
  }
  return map;
}

/* ── 分类 ───────────────────────────────────────────────── */
function classify(rel) {
  const p = rel;
  for (const d of (SPEC.skipDirs || [])) if (p === d || p.startsWith(d + '/')) return null;
  for (const g of (SPEC.skipGlobs || [])) if (globMatch(g, p)) return null;
  for (const g of (SPEC.mergeGlobs || [])) if (globMatch(g, p)) return 'merge';
  if (SPEC.inboxDone && /^inbox\/[^/]+\.(DONE|FAILED)$/.test(p)) return 'latest';
  for (const f of (SPEC.latestFiles || [])) if (p === f) return 'latest';
  for (const d of (SPEC.latestDirs || [])) if (p.startsWith(d + '/')) return 'latest';
  for (const g of (SPEC.latestGlobs || [])) if (globMatch(g, p)) return 'latest';
  return null;
}

/* ── 传输 ───────────────────────────────────────────────── */
async function ensureHkDir(relDir) { if (!relDir) return; await ssh(`mkdir -p ${HK_ORG}/${relDir}`, 20000); }
async function push(rel, localPath) {
  await ensureHkDir(path.posix.dirname(rel));
  const r = await scp(localPath, `${SSH_DEST}:${HK_ORG}/${rel}`);
  return r.ok;
}
async function pull(rel, localPath) {
  try { fs.mkdirSync(path.dirname(localPath), { recursive: true }); } catch (e) {}
  const r = await scp(`${SSH_DEST}:${HK_ORG}/${rel}`, localPath);
  return r.ok;
}

/* ── org.json 结构合并（本机=主，吸收 HK 独有节点） ────────── */
function mergeOrgJson(localStr, hkStr) {
  const local = JSON.parse(localStr), hk = JSON.parse(hkStr);
  const out = JSON.parse(localStr);           // 深拷贝本地
  const unionChild = (a = [], b = []) => Array.from(new Set([...a, ...b]));
  let structural = false;                     // 是否真正发生结构变化（才更新 updatedAt）

  // 1. HK 独有节点 → 吸收（其父需存在；若父也独有会一起吸收）
  for (const id of Object.keys(hk.nodes || {})) {
    if (!out.nodes[id]) {
      const node = JSON.parse(JSON.stringify(hk.nodes[id]));
      // 保证父节点链存在
      let pid = node.parent;
      while (pid && pid !== 'root' && !out.nodes[pid] && hk.nodes[pid]) {
        out.nodes[pid] = JSON.parse(JSON.stringify(hk.nodes[pid]));
        pid = out.nodes[pid].parent;
      }
      out.nodes[id] = node;
      structural = true;
    }
  }
  // 2. 公共节点：children 取并集，其余字段以本机（out=local）为准
  for (const id of Object.keys(out.nodes)) {
    const localN = out.nodes[id], hkN = hk.nodes && hk.nodes[id];
    if (localN && hkN) {
      const before = (localN.children || []).join(',');
      localN.children = unionChild(localN.children, hkN.children);
      if (before !== (localN.children || []).join(',')) structural = true;
    }
  }
  // 3. 根/组 children 并集
  if (out.root && hk.root) {
    const b = (out.root.children || []).join(',');
    out.root.children = unionChild(out.root.children, hk.root.children);
    if (b !== (out.root.children || []).join(',')) structural = true;
  }
  for (const id of Object.keys(out.nodes)) {
    const n = out.nodes[id], hn = hk.nodes && hk.nodes[id];
    if (n && n.type === 'group' && hn) {
      const b = (n.children || []).join(',');
      n.children = unionChild(n.children, hn.children);
      if (b !== (n.children || []).join(',')) structural = true;
    }
  }
  if (structural) out.updatedAt = new Date().toISOString();
  return out;
}

/* ── 单文件 latest 同步 ─────────────────────────────────── */
async function syncLatest(rel, localMeta, hkMeta) {
  const localPath = path.join(ORG_ROOT, rel.split('/').join(path.sep));
  const localHas = !!localMeta, hkHas = !!hkMeta;
  const lm = localMeta ? localMeta.mtime : 0, hm = hkMeta ? hkMeta.mtime : 0;
  if (Math.abs(lm - hm) < EPS && localHas && hkHas) return { action: 'noop', rel, reason: 'mtime 接近' };
  if (localHas && !hkHas) { if (!DRY) await push(rel, localPath); return { action: 'push(new)', rel, side: 'hk' }; }
  if (!localHas && hkHas) { if (!DRY) await pull(rel, localPath); return { action: 'pull(new)', rel, side: 'local' }; }
  if (lm > hm) { if (!DRY) await push(rel, localPath); return { action: 'push', rel, side: 'hk', by: (lm - hm).toFixed(0) + 's' }; }
  if (hm > lm) { if (!DRY) await pull(rel, localPath); return { action: 'pull', rel, side: 'local', by: (hm - lm).toFixed(0) + 's' }; }
  return { action: 'noop', rel, reason: '相等' };
}

/* ── activity.log 行级合并（幂等收敛） ───────────────────── */
async function syncMerge(rel, localMeta, hkMeta) {
  const localPath = path.join(ORG_ROOT, rel.split('/').join(path.sep));
  const readLines = p => { try { return fs.readFileSync(p, 'utf8').split('\n').map(s => s.replace(/\r$/, '')); } catch (e) { return []; } };
  const localLines = readLines(localPath);
  // 拉 HK 当前内容
  const r = await ssh(`cat ${HK_ORG}/${rel} 2>/dev/null`, 30000);
  const hkLines = (r.out ? r.out : '').split('\n');
  // 去重保序合并（空行保留一条）
  const seen = new Set(), merged = [];
  for (const l of [...localLines, ...hkLines]) {
    if (!seen.has(l)) { seen.add(l); merged.push(l); }
  }
  const joined = merged.join('\n');
  const localCur = localLines.join('\n');
  const hkCur = hkLines.join('\n');
  const changedLocal = joined !== localCur, changedHk = joined !== hkCur;
  if (changedLocal && !DRY) { fs.mkdirSync(path.dirname(localPath), { recursive: true }); fs.writeFileSync(localPath, joined, 'utf8'); }
  if (changedHk && !DRY) { const tmp = path.join(ORG_ROOT, 'logs', `.merge-tmp-${path.basename(rel)}`); fs.mkdirSync(path.dirname(tmp), { recursive: true }); fs.writeFileSync(tmp, joined, 'utf8'); await push(rel, tmp); try { fs.unlinkSync(tmp); } catch (e) {} }
  return { action: changedLocal || changedHk ? 'merge' : 'noop', rel, l: localLines.length, h: hkLines.length };
}

/* ── org.json 同步（结构合并） ───────────────────────────── */
async function syncOrgJson() {
  const rel = 'org.json';
  const localPath = path.join(ORG_ROOT, rel);
  const localStr = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8') : null;
  const hr = await ssh(`cat ${HK_ORG}/${rel} 2>/dev/null`, 30000);
  const hkStr = hr.ok && hr.out ? hr.out : null;
  if (!localStr || !hkStr) { warn(`org.json 缺失（local=${!!localStr} hk=${!!hkStr}），跳过结构合并`); return { action: 'skip', rel }; }
  let merged;
  try { merged = mergeOrgJson(localStr, hkStr); }
  catch (e) { warn(`org.json 合并失败: ${e.message}，保留本地为主`); merged = JSON.parse(localStr); }
  const mergedStr = JSON.stringify(merged, null, 2);
  let act = 'noop';
  if (mergedStr !== localStr) {
    if (!DRY) {
      const bak = path.join(ORG_ROOT, `org.json.bak-dualsync-${Date.now()}`);
      try { fs.copyFileSync(localPath, bak); } catch (e) {}
      fs.writeFileSync(localPath, mergedStr, 'utf8');
    }
    act = 'merge-local+push';
  } else if (mergedStr !== hkStr) {
    act = 'push-only';
  }
  if (mergedStr !== hkStr && !DRY) {
    const tmp = path.join(ORG_ROOT, 'logs', '.org.json.tmp');
    fs.mkdirSync(path.dirname(tmp), { recursive: true }); fs.writeFileSync(tmp, mergedStr, 'utf8');
    const ok = await push(rel, tmp);
    try { fs.unlinkSync(tmp); } catch (e) {}
    if (!ok) warn('org.json 推送 HK 失败');
  }
  return { action: act, rel };
}

/* ── 主流程 ─────────────────────────────────────────────── */
async function main() {
  log(`== 双集群同步 ${DRY ? '(dry-run)' : ''} 本地=${ORG_ROOT}  HK=${HK_ORG} ==`);
  const reach = await ssh(`echo __HK_OK__`, 20000);
  if (!reach.out.includes('__HK_OK__')) { warn(`HK 不可达，跳过同步: ${reach.err || 'ssh fail'}`); process.exit(1); }

  const local = localManifest();
  const hk = await hkManifest();
  const rels = new Set([...local.keys(), ...hk.keys()]);
  const results = [];

  // org.json 走结构合并（先处理，保证其余阶段基于收敛后的 org.json）
  if (SPEC.latestFiles && SPEC.latestFiles.includes('org.json')) {
    const orgRes = await syncOrgJson();
    results.push(orgRes);
    if (orgRes.action !== 'noop') log(`  ${orgRes.action.padEnd(14)} ${orgRes.rel}`);
    rels.delete('org.json');
  }

  let n = 0;
  for (const rel of rels) {
    const kind = classify(rel);
    if (!kind) continue;
    n++;
    let res;
    if (kind === 'merge') res = await syncMerge(rel, local.get(rel), hk.get(rel));
    else res = await syncLatest(rel, local.get(rel), hk.get(rel));
    if (res.action !== 'noop') results.push(res);
    if (res.action !== 'noop' || process.argv.includes('--verbose')) log(`  ${res.action.padEnd(14)} ${rel}${res.by ? ' (' + res.by + ')' : ''}${res.side ? ' →' + res.side : ''}`);
  }
  log(`完成：扫描 ${rels.size} 文件，同步项 ${n}，变更 ${results.length} 处。`);
  return 0;
}

main().then(code => process.exit(code)).catch(e => { warn('dual-sync 异常: ' + e.stack); process.exit(1); });
