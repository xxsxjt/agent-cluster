'use strict';
/**
 * lib/anomaly-fallback.js — 进程异常退出兜底（2026-08-12 失败判定机制体系化加固，night-worker）
 *
 * 背景：在 orphan-cleanup（进程/孤儿/PID 根治）+ soft-timeout（软超时不强杀）基础上，
 * 失败判定仍有两处盲区：
 *   1. 进程异常退出（pid 死）但工作其实已完成（agent_settled 已写日志、进程在收尾时崩）
 *      → 原 failTaskAnomaly 一律标 .FAILED + 自动重跑，浪费一次重验。
 *   2. 源任务失败后已由 -improve 任务补验闭环（源任务结果已确定），但 autoRerunTask /
 *      auto-optimize 仍对源任务重复自动重跑 / 重复补验 / 建议换执行者 → 噪音。
 *
 * 本库补两个兜底（纯函数，便于单元测试）：
 *   A. 补 DONE（supplement-done）：进程异常退出前，若日志有完成证据（agent_settled 等）
 *      → 直接写 .DONE 补标记，跳过自动重跑（工作已完成，只是收尾崩了）。
 *   B. 已闭环跳过（skip-closed）：源任务已被 -improve 覆盖 / 源任务已 .DONE
 *      → 不再自动重跑、不再重复补验。
 *   C. 自动重派（redispatch）：无完成证据、未闭环 → 正常自动重跑（限 MAX_RERUN，由 butler 控制）。
 *
 * 与既有模块分工：
 *   - orphan-cleanup  管进程/孤儿/PID 文件清理
 *   - soft-timeout    管"到期先问再判死"
 *   - 本库             管"进程异常退出时的终态兜底决策"（补DONE / 已闭环跳过 / 自动重派）
 *   - auto-optimize   管"失败后策略"（换渠道/换执行者/拆步）——本库 isClosed 供其识别已闭环、
 *                      cleanClosedFailed 清陈旧 .FAILED（停止重复补验）
 *
 * 接入点：
 *   - butler.failTaskAnomaly   ：异常退出前先 decideFallback（补 DONE / 已闭环跳过）
 *   - butler.autoRerunTask     ：重派前加 isClosed 守卫（防重复补验）
 *   - auto-optimize.check      ：每轮 cleanClosedFailed（清已闭环任务的陈旧 .FAILED）
 */
const fs = require('fs');
const path = require('path');

const ORG_ROOT   = path.join(__dirname, '..');
const INBOX_DEF  = path.join(ORG_ROOT, 'inbox');

const readIf = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };

/** 进程存活检测（Windows/Linux 通用，无权限则以存活处理） */
function pidAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/** 读 inbox 下某任务的 .PID（存在则返回 pid 数字，否则 null） */
function readPid(inboxDir, name) {
  try {
    const p = parseInt(readIf(path.join(inboxDir, `${name}.PID`)) || '', 10);
    return Number.isNaN(p) ? null : p;
  } catch (e) { return null; }
}

/**
 * 调度层兜底：扫描 inbox 中「进程已死但尚未写任何终态标记（无 .DONE 也无 .FAILED）」
 * 的任务——即 DONE 写入前死亡 / 软超时误判重派的对象。若其日志有完成证据（agent_settled），
 * 说明工作实际已完成只是标记未及落盘 → 补写 .DONE，避免被 scanInbox 盲目重派 / 触发无效 -improve 补验。
 *
 * 与 butler.failTaskAnomaly（只管 active 表内任务的异常退出）互补：
 * 本函数覆盖「任务已不在 active 表 / butler 重启后」仍残留死 PID 的完成任务。
 *
 * @param {string} [inboxDir]  覆盖 inbox 目录（测试用）
 * @param {string} [logsDir]   覆盖 logs 目录（测试用）
 * @param {object} [opts]      { logOffsetMap?: {[name]:number} } 可选：各任务本次派发日志偏移（无则整日志检测）
 * @returns {{scanned:number, supplemented:number, names:string[]}}
 */
function settlePending(inboxDir, logsDir, opts) {
  const INBOX = inboxDir || INBOX_DEF;
  const LOGS  = logsDir || path.join(ORG_ROOT, 'logs');
  const offsets = (opts && opts.logOffsetMap) || {};
  let files = [];
  try { files = fs.readdirSync(INBOX); } catch (e) { return { scanned: 0, supplemented: 0, names: [] }; }
  const scanned = [];
  const supplemented = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const name = f.slice(0, -'.md'.length);
    if (fs.existsSync(path.join(INBOX, `${name}.DONE`))) continue;    // 已终态
    if (fs.existsSync(path.join(INBOX, `${name}.FAILED`))) continue;  // 已判定失败（走失败恢复链）
    const pid = readPid(INBOX, name);
    if (!pid || pidAlive(pid)) continue;                              // 无 PID（新任务待派）或进程仍活（正常在跑）→ 不动
    // 进程已死 + 无终态标记 = DONE 写入前死亡候选 → 查完成证据
    const ev = hasCompletionEvidence(path.join(LOGS, `${name}.log`), offsets[name]);
    if (!ev) continue;                                                // 无完成证据 → 留给 scanInbox 正常重派
    scanned.push(name);
    const content = supplementDone(name, INBOX, ev);
    if (content) {
      supplemented.push(name);
      // 补 DONE 后清理残留死 PID 标记，避免 scanInbox / sweepOrphans 再动它
      try { if (fs.existsSync(path.join(INBOX, `${name}.PID`))) fs.unlinkSync(path.join(INBOX, `${name}.PID`)); } catch (e) {}
    }
  }
  return { scanned: scanned.length, supplemented: supplemented.length, names: supplemented };
}

/**
 * 闭环感知：任务是否已由 -improve 闭环 / 自身完成。
 * 与 auto-optimize.isClosed 同逻辑（本处为单一来源，auto-optimize 复用本库）：
 *   - 自身已有【成功】.DONE（inbox/<name>.DONE 内容非 .FAILED；2026-08-12 修复：失败标记不算闭环，
 *     否则 autoRerunTask 的 isClosed 守卫把“自身失败标记”误判为已完成 → 自动重跑永远被拦截）
 *   - 去掉 -improve 后缀的源任务已有【成功】.DONE（如 <name>-improve 的源 <name>）
 *   - 已被 -improve 版本覆盖（inbox/<name>-improve.DONE 成功）
 * @param {string} name 任务名
 * @param {string} [inboxDir] 覆盖 inbox 目录（测试用）
 * @returns {boolean} 是否已闭环
 */
function isClosed(name, inboxDir) {
  const INBOX = inboxDir || INBOX_DEF;
  const hasSuccess = n => { try { const c = fs.readFileSync(path.join(INBOX, `${n}.DONE`), 'utf8'); return !!c && !c.includes('.FAILED'); } catch (e) { return false; } };
  if (!name) return false;
  if (hasSuccess(name)) return true;                     // 自身已完成（成功）
  const src = name.replace(/-improve$/i, '');
  if (src !== name && hasSuccess(src)) return true;      // 源任务已闭环（成功）
  if (hasSuccess(name + '-improve')) return true;        // 已由 -improve 版本覆盖（成功）
  return false;
}

/**
 * 完成证据：日志中是否存在 agent_settled（agent 声明会话完成，butler 既有的完成标志）。
 * 只读【本次派发后新增】的日志段（logOffset→末尾），避免旧日志残留误判；单次最多读 512KB 防撑爆。
 * @param {string} logPath  任务日志路径（logs/<name>.log / .hk.log / .cnb.log）
 * @param {number} [logOffset] 本次派发时日志已有长度（本次新增段起点）
 * @returns {string|null} 完成证据描述（无证据返回 null）
 */
function hasCompletionEvidence(logPath, logOffset) {
  if (!logPath) return null;
  try {
    const st = fs.statSync(logPath);
    const start = Math.min(logOffset || 0, st.size);
    const len = st.size - start;
    if (len <= 0) return null;
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(Math.min(len, 512 * 1024)); // 最多读 512KB
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    // 只匹配 JSON 事件格式的 agent_settled（防任务描述/正文里出现该词误判——2026-08-09 实测教训）
    if (/\"type\"\s*:\s*\"agent_settled\"/.test(text)) return 'agent_settled';
    if (/agent_settled 后进程退出/.test(text)) return 'settled-exit-marker';
  } catch (e) {}
  return null;
}

/**
 * 终态兜底决策（进程异常退出时调用）：
 *   - supplement-done ：有完成证据 → 补写 .DONE，跳过自动重跑
 *   - skip-closed     ：已闭环（源由 -improve 覆盖/源 .DONE）→ 跳过重复补验
 *   - redispatch      ：无证据且未闭环 → 正常自动重派
 * @param {string} name 任务名
 * @param {object} entry 任务 active 项（含 logPath/logOffset）
 * @param {object} [opts] { inboxDir }
 * @returns {object} { action, evidence? }
 */
function decideFallback(name, entry, opts) {
  const inboxDir = (opts && opts.inboxDir) || INBOX_DEF;
  const ev = hasCompletionEvidence(entry && entry.logPath, entry && entry.logOffset);
  if (ev) return { action: 'supplement-done', evidence: ev };
  if (isClosed(name, inboxDir)) return { action: 'skip-closed' };
  return { action: 'redispatch' };
}

/** 补写 .DONE（完成证据兜底） */
function supplementDone(name, inboxDir, evidence) {
  const INBOX = inboxDir || INBOX_DEF;
  const content = `agent_settled 后进程异常退出但工作已完成 → 补 DONE（${evidence || '完成证据'}）`;
  try { fs.writeFileSync(path.join(INBOX, `${name}.DONE`), content, 'utf8'); return content; }
  catch (e) { return null; }
}

/** 已闭环跳过 → 写终态标记（注明由 -improve 闭环，供 auto-optimize.cleanClosedFailed 识别清理） */
function markClosedSkipped(name, inboxDir, reason) {
  const INBOX = inboxDir || INBOX_DEF;
  const content = `.FAILED: ${(reason || '').trim()}（源任务已由 -improve 闭环，跳过重复补验）`;
  try { fs.writeFileSync(path.join(INBOX, `${name}.FAILED`), content, 'utf8'); return content; }
  catch (e) { return null; }
}

/**
 * 清理已闭环任务的陈旧 .FAILED 标记（停止重复补验）。
 * 源任务已由 -improve 覆盖/源已 .DONE 的任务，其 .FAILED 是陈旧噪音——auto-optimize 每轮 check 调用，
 * 移除后不再对已完成闭环的任务重复补验/建议换执行者。
 * @param {string} [inboxDir]
 * @returns {number} 清理条数
 */
function cleanClosedFailed(inboxDir) {
  const INBOX = inboxDir || INBOX_DEF;
  let cleaned = 0, files = [];
  try { files = fs.readdirSync(INBOX); } catch (e) { return 0; }
  for (const f of files) {
    if (!f.endsWith('.FAILED')) continue;
    const name = f.slice(0, -'.FAILED'.length);
    if (isClosed(name, INBOX)) {
      try { fs.unlinkSync(path.join(INBOX, f)); cleaned++; } catch (e) {}
    }
  }
  return cleaned;
}

module.exports = {
  isClosed, hasCompletionEvidence, decideFallback, pidAlive, readPid,
  supplementDone, markClosedSkipped, cleanClosedFailed, settlePending
};
