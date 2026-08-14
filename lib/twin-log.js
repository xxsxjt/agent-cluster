#!/usr/bin/env node
/**
 * lib/twin-log.js — 分身活动留痕工具（v5.1）
 *
 * 所有"分身足迹"统一写入 agents/twin/activity.log（控制台可读时间线）。
 * 任何进程（twin-daemon / web server / bootstrap / butler / 主会话入口）都可调用。
 *
 * activity.log 行格式（一行一条，控制台友好）：
 *   [2026-08-05 17:30:00] [巡查] 动作 — 理由
 *
 * 类型 tag 约定：上线 / 巡查 / 决策 / 指示 / 验收 / 安全 / 对话 / 系统
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ORG_ROOT = path.join(__dirname, '..');
const ACTIVITY_LOG = path.join(ORG_ROOT, 'agents', 'twin', 'activity.log');

/** 追加一条分身活动记录（自动建目录） */
function logActivity(action, detail, tag) {
  try {
    fs.mkdirSync(path.dirname(ACTIVITY_LOG), { recursive: true });
    const d = new Date();
    const p = n => (n < 10 ? '0' + n : '' + n);
    const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
               `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    const line = `[${ts}] [${tag || '系统'}] ${action}${detail ? ' — ' + detail : ''}`;
    fs.appendFileSync(ACTIVITY_LOG, line + '\n', 'utf8');
    return line;
  } catch (e) {
    return null;
  }
}

/** 读 activity.log 尾部 N 行（web 面板用） */
function readActivity(lines, maxBytes) {
  const st = statOf(ACTIVITY_LOG);
  if (!st) return { text: '', size: 0, mtime: 0, lines: [] };
  const max = maxBytes || 512 * 1024;
  const start = Math.max(0, st.size - max);
  let fd = null;
  try {
    fd = fs.openSync(ACTIVITY_LOG, 'r');
    const len = st.size - start;
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = fs.readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const text = buf.slice(0, read).toString('utf8');
    let arr = text.split(/\r?\n/).filter(Boolean);
    if (start > 0 && arr.length) arr = arr.slice(1);   // 去掉半行
    return {
      text: arr.slice(-(lines || 200)).join('\n'),
      size: st.size, mtime: st.mtimeMs,
      lines: arr.slice(-(lines || 200)).map(l => {
        const m = l.match(/^\[([^\]]+)\] \[([^\]]+)\] (.*)$/);
        return m ? { ts: m[1], tag: m[2], text: m[3] } : { ts: null, tag: 'raw', text: l };
      })
    };
  } catch (e) {
    return { text: '', size: st.size, mtime: st.mtimeMs, lines: [], error: e.message };
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (e) {}
  }
}

function statOf(p) {
  try { return fs.statSync(p); } catch (e) { return null; }
}

module.exports = { logActivity, readActivity, ACTIVITY_LOG };