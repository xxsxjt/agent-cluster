#!/usr/bin/env node
/**
 * lib/resource-lock.js — 共享资源锁表机制（2026-08-10 落地，兑现口嗨审计 P0 #1）
 *
 * 背景：8/6 聊天室模型被互踩教训 → conventions「智能体任务冲突与资源锁」承诺
 * knowledge/resource-registry.json，但一直只有规则没有落地物。本模块补上
 * 读取/加锁/释放 + 派发前冲突校验机制，配合登记表，避免多智能体并发操作共享资源冲突。
 *
 * 两类能力（同一登记表，互补）：
 *  A. 派发期校验（butler 调度依赖，learning-officer 提供）：
 *     - parseDeclarations(content)    从任务内容解析 writes:/reads: 声明
 *     - validate(task,content,agent)  校验声明的资源是否登记、owner 是否越权（warn-only）
 *     - claim/release(task,writes)    进程内活跃写集跟踪（资源→占用任务）
 *     - preDispatch(task,content,agent) 派发前一键：校验+冲突检测+登记写集
 *     - check()                       巡检活跃写集是否有冲突占用
 *  B. 显式锁（night-worker 补充，供智能体写共享资源前主动占锁）：
 *     - read(resource)                读某资源 owner + 锁状态（写前必查）
 *     - lock(resource,holder,opts)    加锁（空闲/续期/过期抢占，防他人锁误抢）
 *     - unlock(resource,holder)       释放（仅持有者可释放）
 *     - list() / audit(staleMin)      全表速览 / 巡检过期锁
 *
 * 原子性：显式锁的写走「临时文件 + rename」，避免多进程并发写坏 resource-registry.json。
 *
 * 用法：
 *   node lib/resource-lock.js read <resource>
 *   node lib/resource-lock.js list
 *   node lib/resource-lock.js lock <res> <holder> [purpose] [ttlMin]
 *   node lib/resource-lock.js unlock <res> <holder>
 *   node lib/resource-lock.js audit [staleMin]
 *   node lib/resource-lock.js self-test
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ORG_ROOT = path.join(__dirname, '..');
const REGISTRY_PATH = path.join(ORG_ROOT, 'knowledge', 'resource-registry.json');
const LOGS = path.join(ORG_ROOT, 'logs');

/* ════════ 通用 ════════ */
const readJsonSafe = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
function ensureLogDir() { try { fs.mkdirSync(LOGS, { recursive: true }); } catch (e) {} }
function log(...a) {
  const line = `[${new Date().toLocaleTimeString()}] [resource-lock] ${a.join(' ')}`;
  console.log(line);
  try { ensureLogDir(); fs.appendFileSync(path.join(LOGS, 'resource-lock.log'), line + '\n', 'utf8'); } catch (e) {}
}
function atomicWrite(p, data) {
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/** 读登记表（惰性兜底） */
function loadRegistry() {
  const reg = readJsonSafe(REGISTRY_PATH) || { version: 1, updatedAt: '', resources: {} };
  if (!reg.resources) reg.resources = {};
  return reg;
}
const load = loadRegistry;

/* ════════ A. 派发期校验（learning-officer 实现） ════════ */

/** 内存活跃写集：resource → [taskName,...]（进程内跟踪，配合 butler active map） */
const activeWrites = new Map();

/** 从任务内容解析 writes:/reads: 声明（兼容 "writes: a, b" / "writes: a b"） */
function parseDeclarations(content) {
  const writes = [];
  const reads = [];
  const re = /^\s*(writes|reads)\s*:\s*(.+)$/gim;
  let m;
  while ((m = re.exec(content || '')) !== null) {
    const kind = m[1].toLowerCase();
    const items = m[2].split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
    for (const it of items) {
      const matchedKey = it.toLowerCase();
      if (kind === 'write' || kind === 'writes') writes.push(matchedKey);
      else reads.push(matchedKey);
    }
  }
  return { writes, reads };
}

/** 校验一个任务：声明的 writes/reads 是否在登记表、owner 是否越权（warn-only） */
function validate(taskName, content, agentId) {
  const reg = loadRegistry();
  const res = reg.resources || {};
  const decl = parseDeclarations(content);
  const warnings = [];
  const check = (list, kindLabel) => {
    for (const key of list) {
      const known = Object.keys(res).some(k => k.toLowerCase() === key);
      if (!known) {
        warnings.push(`[${taskName}] 声明 ${kindLabel}「${key}」未登记在 resource-registry.json，需补登记`);
        continue;
      }
      const owner = res[Object.keys(res).find(k => k.toLowerCase() === key)].owner;
      if (kindLabel === '写' && owner && owner !== agentId && agentId !== 'twin' && agentId !== 'butler') {
        warnings.push(`[${taskName}] 写「${key}」owner=${owner}，当前执行者=${agentId}（非 owner），请确认是否越权`);
      }
    }
  };
  check(decl.writes, '写');
  check(decl.reads, '读');
  return { ok: warnings.length === 0, warnings, decl };
}

/** 检查写冲突：声明的 writes 是否被其它活跃任务占用 */
function checkConflict(taskName, writes) {
  const conflicts = [];
  for (const w of writes) {
    const holders = (activeWrites.get(w) || []).filter(n => n !== taskName);
    if (holders.length) conflicts.push({ resource: w, by: holders });
  }
  return { ok: conflicts.length === 0, conflicts };
}

/** 任务开始时登记其写的资源 */
function claim(taskName, writes) {
  for (const w of writes) {
    if (!activeWrites.has(w)) activeWrites.set(w, []);
    if (!activeWrites.get(w).includes(taskName)) activeWrites.get(w).push(taskName);
  }
}

/** 任务结束时释放其写的资源 */
function release(taskName) {
  for (const [w, holders] of activeWrites) {
    const i = holders.indexOf(taskName);
    if (i >= 0) holders.splice(i, 1);
    if (!holders.length) activeWrites.delete(w);
  }
}

/** 完整派发前检查（校验 + 冲突），并登记写集。返回 issues 供但管家日志。 */
function preDispatch(taskName, content, agentId) {
  const { ok, warnings, decl } = validate(taskName, content, agentId);
  const { ok: cOk, conflicts } = checkConflict(taskName, decl.writes);
  const issues = [];
  if (warnings.length) issues.push(`校验: ${warnings.join(' | ')}`);
  if (conflicts.length) issues.push(`冲突: ${conflicts.map(c => `${c.resource}←被 ${c.by.join(',')} 占用`).join(' | ')}`);
  if (decl.writes.length) claim(taskName, decl.writes);
  return { ok: ok && cOk, decl, warnings, conflicts, issues };
}

/** 巡检活跃写集冲突（供 butler 主循环调用） */
function check() {
  const conflicts = [];
  for (const [w, holders] of activeWrites) {
    if (holders.length > 1) conflicts.push({ resource: w, by: holders.slice() });
  }
  return conflicts;
}

/* ════════ B. 显式锁（night-worker 补充） ════════ */

/** 单资源读：owner + 锁状态 */
function read(resource) {
  const reg = loadRegistry();
  const r = reg.resources[resource];
  if (!r) return null;
  return {
    resource,
    owner: r.owner || null,
    ownerRole: r.ownerRole || null,
    type: r.type || null,
    path: r.path || null,
    desc: r.desc || '',
    locked: !!r.lock && !!r.lock.holder,
    holder: r.lock ? r.lock.holder : null,
    at: r.lock ? r.lock.at : null,
    until: r.lock ? r.lock.until : null,
    purpose: r.lock ? r.lock.purpose : null
  };
}

/** 加锁。资源须已登记（owner 明确）。opts: {purpose, ttlMin, force} */
function lock(resource, holder, opts = {}) {
  const reg = loadRegistry();
  const r = reg.resources[resource];
  if (!r) return { ok: false, reason: `资源 '${resource}' 未在 resource-registry.json 登记，需先登记 owner 再加锁` };
  if (!holder) return { ok: false, reason: 'holder 不能为空' };

  const now = Date.now();
  const ttlMin = opts.ttlMin != null ? opts.ttlMin : 60;
  const ttlMs = ttlMin * 60 * 1000;
  const cur = r.lock;

  let overridden = false;
  if (cur && cur.holder) {
    const expired = cur.until ? Date.parse(cur.until) < now : false;
    if (cur.holder === holder) {
      r.lock = { holder, at: new Date(cur.at || now).toISOString(), until: new Date(now + ttlMs).toISOString(), purpose: opts.purpose || cur.purpose };
      atomicWrite(REGISTRY_PATH, reg);
      return { ok: true, renewed: true, overridden: false, lock: r.lock };
    }
    if (!expired && !opts.force) {
      return { ok: false, reason: `资源 '${resource}' 已被 ${cur.holder} 持有至 ${cur.until}（purpose: ${cur.purpose || '—'}），串行等待或协调` };
    }
    overridden = true;
    log(`⚠️ 锁覆盖：'${resource}' 原持有 ${cur.holder}（过期=${expired}），现由 ${holder} 接管`);
  }

  r.lock = { holder, at: new Date(now).toISOString(), until: new Date(now + ttlMs).toISOString(), purpose: opts.purpose || null };
  if (!reg.updatedAt) reg.updatedAt = new Date().toISOString();
  atomicWrite(REGISTRY_PATH, reg);
  log(`🔒 加锁：'${resource}' ← ${holder}${overridden ? '（覆盖）' : ''}${opts.purpose ? ' [' + opts.purpose + ']' : ''}`);
  return { ok: true, overridden, lock: r.lock };
}

/** 释放锁。仅 holder 匹配才释放（防误释放他人锁） */
function unlock(resource, holder) {
  const reg = loadRegistry();
  const r = reg.resources[resource];
  if (!r) return { ok: false, reason: `资源 '${resource}' 未登记` };
  const cur = r.lock;
  if (!cur || !cur.holder) return { ok: false, reason: `资源 '${resource}' 当前未被锁定，无需释放` };
  if (cur.holder !== holder) {
    return { ok: false, reason: `释放失败：'${resource}' 锁持有者是 ${cur.holder}，不是 ${holder}（防误释放他人锁）` };
  }
  r.lock = { holder: null, at: null, until: null, purpose: null };
  if (!reg.updatedAt) reg.updatedAt = new Date().toISOString();
  atomicWrite(REGISTRY_PATH, reg);
  log(`🔓 释放：'${resource}' 由 ${holder} 释放`);
  return { ok: true };
}

/** 全表速览 */
function list() {
  const reg = loadRegistry();
  const rows = [];
  for (const [k, v] of Object.entries(reg.resources || {})) {
    const locked = v.lock && v.lock.holder;
    rows.push({
      resource: k, owner: v.owner || null, ownerRole: v.ownerRole || null, type: v.type || null,
      locked, holder: locked ? v.lock.holder : null,
      until: locked ? v.lock.until : null, purpose: locked ? v.lock.purpose : null
    });
  }
  return rows;
}

/** 巡检过期锁：返回 {expired, held}，不自动改（释放是持有者职责） */
function audit(staleMin = 60) {
  const now = Date.now();
  const rows = list();
  const expired = [];
  const held = [];
  for (const r of rows) {
    if (!r.locked) continue;
    const until = r.until ? Date.parse(r.until) : NaN;
    if (!isNaN(until) && until < now) {
      expired.push({ ...r, expiredSince: new Date(until).toISOString() });
    } else {
      held.push(r);
    }
  }
  return { expired, held };
}

/* ════════ 内置自检 ════════ */
function selfTest() {
  const assert = (cond, msg) => { if (!cond) { console.error('❌ FAIL:', msg); process.exit(1); } console.log('✅', msg); };
  // 派发期校验（纯函数，无副作用）
  const decl = parseDeclarations('writes: chatroom.model, org.json\nreads: conventions.md');
  assert(decl.writes.length === 2 && decl.reads.length === 1, `parseDeclarations 解析 writes/reads：writes=${decl.writes}`);
  const v1 = validate('t1', 'writes: __unknown__', 'x');
  assert(v1.warnings.length === 1 && /未登记/.test(v1.warnings[0]), `validate 未登记资源警告：${v1.warnings[0]}`);
  const v2 = validate('t2', 'writes: chatroom.model', 'twin');
  assert(v2.ok === true && v2.warnings.length === 0, 'validate owner=twin 写 chatroom.model 无警告');
  // 活跃写集冲突
  claim('taskA', ['chatroom.model']);
  const c1 = checkConflict('taskB', ['chatroom.model']);
  assert(c1.ok === false && c1.conflicts[0].by.includes('taskA'), `checkConflict 检测 taskA 占用：${JSON.stringify(c1.conflicts)}`);
  release('taskA');
  const c2 = checkConflict('taskB', ['chatroom.model']);
  assert(c2.ok === true, 'release 后冲突解除');

  // 显式锁（用真实表 chatroom.model，自检后释放）
  const R = 'chatroom.model';
  const l = lock(R, 'self-test', { purpose: 'resource-lock 自检', ttlMin: 1 });
  assert(l.ok === true, `lock ${R} 成功`);
  const l2 = lock(R, 'other-agent', { purpose: '抢占', ttlMin: 1 });
  assert(l2.ok === false && /已被/.test(l2.reason), `他人抢占被拒：${l2.reason}`);
  const l3 = lock(R, 'self-test', { purpose: '续期', ttlMin: 2 });
  assert(l3.ok === true && l3.renewed === true, '同 holder 续期成功');
  const u1 = unlock(R, 'other-agent');
  assert(u1.ok === false, `错误 holder 释放被拒：${u1.reason}`);
  const u2 = unlock(R, 'self-test');
  assert(u2.ok === true, '正确 holder 释放成功');
  const l4 = lock('__nope__', 'x');
  assert(l4.ok === false, `未登记资源拒绝：${l4.reason}`);
  console.log('\nresource-lock 自检全部通过（派发校验 + 显式锁）');
}

/* ════════ CLI ════════ */
function cli() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === 'read') { const r = read(argv[1]); console.log(r ? JSON.stringify(r, null, 2) : '未登记'); return; }
  if (cmd === 'list') { console.log(JSON.stringify(list(), null, 2)); return; }
  if (cmd === 'lock') {
    const res = argv[1], holder = argv[2];
    const purpose = argv[3] || null;
    const ttlMin = argv[4] ? parseInt(argv[4], 10) : 60;
    console.log(JSON.stringify(lock(res, holder, { purpose, ttlMin }), null, 2));
    return;
  }
  if (cmd === 'unlock') { console.log(JSON.stringify(unlock(argv[1], argv[2]), null, 2)); return; }
  if (cmd === 'audit') {
    const a = audit(argv[1] ? parseInt(argv[1], 10) : 60);
    console.log(JSON.stringify({ expiredCount: a.expired.length, expired: a.expired, heldCount: a.held.length, held: a.held }, null, 2));
    return;
  }
  if (cmd === 'validate') { const v = validate('cli', argv[1] || '', argv[2] || 'x'); console.log(JSON.stringify(v, null, 2)); return; }
  if (cmd === 'self-test') { selfTest(); return; }
  console.log(`用法:
  node lib/resource-lock.js read <resource>          # 查某资源
  node lib/resource-lock.js list                     # 全表
  node lib/resource-lock.js lock <res> <holder> [purpose] [ttlMin]
  node lib/resource-lock.js unlock <res> <holder>
  node lib/resource-lock.js audit [staleMin]         # 巡检过期锁
  node lib/resource-lock.js validate <content> <agent>  # 校验声明
  node lib/resource-lock.js self-test`);
}

module.exports = { loadRegistry, load, parseDeclarations, validate, checkConflict, claim, release, preDispatch, check,
                   read, lock, unlock, list, audit, REGISTRY_PATH };

if (require.main === module) cli();
