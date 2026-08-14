#!/usr/bin/env node
/**
 * 官方 DONE 标记写入工具（乱码根治 2026-08-12）
 * --------------------------------------------------
 * 用途：智能体完成任务后写 inbox/<name>.DONE（一行摘要）或 .FAILED。
 * 为什么用 node：fs.writeFileSync 默认 UTF-8，杜绝 Windows python GBK 乱码。
 *
 * 用法：
 *   node org/scripts/write-done.js <task-name> "<一行摘要>"
 *   node org/scripts/write-done.js <task-name> ".FAILED: <原因>"
 *   （摘要含空格/引号时务必用双引号包裹）
 *
 * 校验：写完后验证文件字节为合法 UTF-8，乱码即失败退出码 1。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ORG_ROOT = path.join(__dirname, '..');
const INBOX = path.join(ORG_ROOT, 'inbox');

function main() {
  const name = process.argv[2];
  const summary = process.argv[3];
  if (!name || summary === undefined) {
    console.error('用法: node write-done.js <task-name> "<一行摘要>"');
    process.exit(2);
  }
  // 防路径穿越：name 只允许安全字符
  const safe = name.replace(/[^a-zA-Z0-9_.\-\u4e00-\u9fff]/g, '_');
  const suffix = /^\.FAILED/i.test(summary.trim()) ? '.FAILED' : '.DONE';
  const donePath = path.join(INBOX, `${safe}${suffix}`);

  fs.mkdirSync(INBOX, { recursive: true });
  const content = summary + '\n';
  fs.writeFileSync(donePath, content, 'utf8');

  // 校验：文件字节必须合法 UTF-8 且无替换符
  const raw = fs.readFileSync(donePath);
  const ok = raw.toString('utf8') === content && !raw.includes(Buffer.from('\uFFFD', 'utf8'));
  if (!ok) {
    console.error(`[write-done] 校验失败（疑似非 UTF-8），已删除避免污染: ${donePath}`);
    fs.unlinkSync(donePath);
    process.exit(1);
  }
  console.log(`[write-done] OK ${suffix}: ${donePath}`);
}

try {
  main();
} catch (e) {
  console.error('[write-done] 失败:', e.message);
  process.exit(1);
}
