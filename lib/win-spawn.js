#!/usr/bin/env node
/**
 * lib/win-spawn.js — Windows 下隐藏子进程窗口的公共兜底包装
 *
 * 背景：Windows 下 spawn/execFile 调用 ssh/scp/rsync/cloudflared 等外部程序时，
 * 若未设 `windowsHide: true`，会每次弹出一个 cmd/终端窗口闪现（用户反馈"很多 scp.exe
 * 弹窗闪了一下"）。
 *
 * 约定：**所有可能弹窗的外部进程调用（ssh/scp/rsync/cloudflared/powershell 等）
 * 一律通过本模块的包装函数**，它们默认注入 `windowsHide: true`（仅 win32），
 * 新代码默认隐藏，无需每次手动写。签名与 Node child_process 完全一致，可无缝替换：
 *
 *   // 旧：const { execFile } = require('child_process');
 *   // 新：
 *   const { execFile } = require('../lib/win-spawn');
 *
 * 说明：
 *  - 仅在调用方未显式传入 windowsHide 时补默认值（显式 false 仍生效，不改业务逻辑）
 *  - 非 Windows 平台不注入任何选项（无副作用）
 */
'use strict';
const cp = require('child_process');

/** 若调用方未显式指定 windowsHide 且运行在 Windows，则注入 windowsHide:true */
function defaultHide(opts) {
  if (opts === undefined) opts = {};
  if (process.platform !== 'win32') return opts;
  if (opts.windowsHide === undefined) opts.windowsHide = true;
  return opts;
}

/**
 * execFile(file, args[, options][, callback]) — 默认隐藏窗口
 */
function execFile(file, args, options, callback) {
  if (typeof options === 'function') { callback = options; options = undefined; }
  return cp.execFile(file, args, defaultHide(options), callback);
}

/**
 * execFileSync(file, args[, options]) — 默认隐藏窗口
 */
function execFileSync(file, args, options) {
  return cp.execFileSync(file, args, defaultHide(options));
}

/**
 * spawn(command[, args][, options]) — 默认隐藏窗口
 */
function spawn(command, args, options) {
  if (options === undefined && args && !Array.isArray(args)) { options = args; args = []; }
  return cp.spawn(command, args, defaultHide(options));
}

/**
 * spawnSync(command[, args][, options]) — 默认隐藏窗口
 */
function spawnSync(command, args, options) {
  if (options === undefined && args && !Array.isArray(args)) { options = args; args = []; }
  return cp.spawnSync(command, args, defaultHide(options));
}

module.exports = { execFile, execFileSync, spawn, spawnSync };
