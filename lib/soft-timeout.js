/**
 * 软超时机制（2026-08-11 soft-timeout，night-worker）
 *
 * 背景：用户 8/10 已要求"不要强制超时，要智能看护"。原 HK/CNB 桥脚本（scripts/hk-task.js、
 * scripts/cnb-task.js）在任务 timeout 字段（默认 7200s）到期时**直接写 .FAILED 强杀**——
 * 与 task-watchdog 的"静默询问优先"冲突，用户 8/11 质问"你是不是加了什么奇怪的强制超时限制"。
 *
 * 本库：把"到期即杀"改为"软超时"——到期不杀，先投 checkpoint 询问（复用 task-watchdog 的
 * dispatchCheckpoint 询问机制："超时但进程可能活着，请汇报进度/是否继续"）→ 智能体回应/远端
 * 日志仍活跃 → 桥脚本续期继续跑（重新计时）；无回应且远端日志停滞 → 才判定真卡死结束。
 *
 * 硬保护保留：进程死（无 DONE）→ 正常失败处理（那是真死不是超时）。
 */
'use strict';
const path = require('path');

const ORG_ROOT = path.resolve(__dirname, '..');
const INBOX   = path.join(ORG_ROOT, 'inbox');

// 加载 task-watchdog 配置（询问渠道/隐私路由等），失败给默认兜底
function loadWatchdogCfg() {
  try {
    const cfg = require(path.join(ORG_ROOT, 'config', 'task-watchdog.json'));
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch (e) { return {}; }
}

/**
 * 投递一次软超时询问（复用 watchdog dispatchCheckpoint，幂等：已在队列则返回 null）。
 * @param {string} taskName 被看护的原任务名（不含 .md）
 * @param {string} agentId  执行该任务的本地智能体（HK→server-admin / CNB→cnb-dev）
 * @param {string} reason   询问原因（记录用）
 * @returns {string|null}   checkpoint 任务文件名（null=已在队列）
 */
function askSoftTimeout(taskName, agentId, reason) {
  const cfg = loadWatchdogCfg();
  const watchdog = require('./task-watchdog');
  const file = watchdog.dispatchCheckpoint(taskName, agentId, reason, cfg, null, 'softtimeout');
  return file || null; // 已在队列（幂等）返回 null
}

/**
 * 判定远端日志是否仍在活动（活跃窗口：最近 lookbackMs 内有新输出）。
 * 由调用方（桥脚本）提供远端日志 mtime（epoch 秒，缺失为 0）。
 * 用「活跃窗口」而非「晚于超时点」判定，避免秒级 mtime 与 ms 级超时点边界脆弱误判。
 * @param {number} remoteLogMtime 远端 logs/<name>.log 的 mtime（epoch 秒）
 * @param {number} [lookbackMs]   活跃窗口（默认 3min）
 * @returns {boolean} 仍在活动（续期）
 */
const SOFT_ACTIVE_LOOKBACK_MS = 3 * 60 * 1000; // 默认：3min 内日志有输出视为活跃
function isRemoteActive(remoteLogMtime, lookbackMs) {
  if (!remoteLogMtime) return false;                       // 无日志 → 无法证明活跃
  const window = lookbackMs || SOFT_ACTIVE_LOOKBACK_MS;
  return remoteLogMtime * 1000 > Date.now() - window;      // 最近 window 内有输出 → 活跃
}

module.exports = { askSoftTimeout, isRemoteActive, loadWatchdogCfg };
module.exports.SOFT_ACTIVE_LOOKBACK_MS = SOFT_ACTIVE_LOOKBACK_MS;
