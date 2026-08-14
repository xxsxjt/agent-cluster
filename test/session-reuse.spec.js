#!/usr/bin/env node
/**
 * test/session-reuse.spec.js — 会话复用模块单测（2026-08-12）
 * 覆盖：主题族提取 / 复用候选选择 / 安全阀（空闲、体积、活跃排除）/ 显式策略 / 旧格式不误配
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { computeSessionId, findReuseCandidate, familyOf, IDLE_MS, MAX_BYTES } = require('../lib/session-reuse');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

// ── 测试夹具：临时 agent 目录 + 会话文件 ──
function makeAgentDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-reuse-'));
  const sessions = path.join(dir, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  for (const [name, opts] of Object.entries(files || {})) {
    const { id, mtimeAgo = 0, size = 1000 } = opts;
    const fp = path.join(sessions, name);
    fs.writeFileSync(fp, JSON.stringify({ type: 'session', id }) + '\n' + 'x'.repeat(size));
    if (mtimeAgo > 0) {
      const past = new Date(Date.now() - mtimeAgo);
      fs.utimesSync(fp, past, past);
    }
  }
  return dir;
}

console.log('== familyOf 主题族提取 ==');
t('普通任务名 → 前两段', () => assert.strictEqual(familyOf('session-reuse-quality'), 'session-reuse'));
t('nextday 夜间任务 → 滤日期时间戳', () => assert.strictEqual(familyOf('nextday-2026-08-12-xxx-152618'), 'nextday-xxx'));
t('cnb 系列 → cnb-node', () => assert.strictEqual(familyOf('cnb-node-test-resume-verify'), 'cnb-node'));
t('单段名 → 单段', () => assert.strictEqual(familyOf('patrol'), 'patrol'));
t('纯数字名 → default', () => assert.strictEqual(familyOf('1234567890'), 'default'));

console.log('== findReuseCandidate 候选选择 ==');
t('同族最近空闲会话被选中', () => {
  const dir = makeAgentDir({
    'a_task-night-worker-foo-1.jsonl': { id: 'task-night-worker-foo-1', mtimeAgo: 2 * IDLE_MS },
    'b_task-night-worker-foo-2.jsonl': { id: 'task-night-worker-foo-2', mtimeAgo: IDLE_MS + 1000 },
  });
  const got = findReuseCandidate({ agentDir: dir, agentId: 'night-worker', family: 'foo' });
  assert.strictEqual(got, 'task-night-worker-foo-2'); // 最近者优先
});
t('异族会话不匹配（防污染）', () => {
  const dir = makeAgentDir({
    'a_task-night-worker-bar-1.jsonl': { id: 'task-night-worker-bar-1', mtimeAgo: 2 * IDLE_MS },
  });
  assert.strictEqual(findReuseCandidate({ agentDir: dir, agentId: 'night-worker', family: 'foo' }), null);
});
t('旧格式（无 family）不误配', () => {
  const dir = makeAgentDir({
    'a_task-night-worker-123456.jsonl': { id: 'task-night-worker-123456', mtimeAgo: 2 * IDLE_MS },
  });
  assert.strictEqual(findReuseCandidate({ agentDir: dir, agentId: 'night-worker', family: 'foo' }), null);
});
t('活跃中（mtime 新）不复用', () => {
  const dir = makeAgentDir({
    'a_task-night-worker-foo-1.jsonl': { id: 'task-night-worker-foo-1', mtimeAgo: 60 * 1000 },
  });
  assert.strictEqual(findReuseCandidate({ agentDir: dir, agentId: 'night-worker', family: 'foo' }), null);
});
t('体积超限不复用（防上下文爆炸）', () => {
  const dir = makeAgentDir({
    'a_task-night-worker-foo-1.jsonl': { id: 'task-night-worker-foo-1', mtimeAgo: 2 * IDLE_MS, size: MAX_BYTES + 1 },
  });
  assert.strictEqual(findReuseCandidate({ agentDir: dir, agentId: 'night-worker', family: 'foo' }), null);
});
t('excludeIds 排除占用会话', () => {
  const dir = makeAgentDir({
    'a_task-night-worker-foo-1.jsonl': { id: 'task-night-worker-foo-1', mtimeAgo: 2 * IDLE_MS },
    'b_task-night-worker-foo-2.jsonl': { id: 'task-night-worker-foo-2', mtimeAgo: 2 * IDLE_MS },
  });
  const got = findReuseCandidate({ agentDir: dir, agentId: 'night-worker', family: 'foo', excludeIds: ['task-night-worker-foo-2'] });
  assert.strictEqual(got, 'task-night-worker-foo-1');
});
t('异 agent 会话不匹配', () => {
  const dir = makeAgentDir({
    'a_task-coo-foo-1.jsonl': { id: 'task-coo-foo-1', mtimeAgo: 2 * IDLE_MS },
  });
  assert.strictEqual(findReuseCandidate({ agentDir: dir, agentId: 'night-worker', family: 'foo' }), null);
});

console.log('== computeSessionId 策略 ==');
t('auto 有候选 → 复用', () => {
  const dir = makeAgentDir({
    'a_task-night-worker-foo-task-1.jsonl': { id: 'task-night-worker-foo-task-1', mtimeAgo: 2 * IDLE_MS },
  });
  const r = computeSessionId({ agentId: 'night-worker', taskName: 'foo-task-verify', agentDir: dir });
  assert.strictEqual(r.sessionId, 'task-night-worker-foo-task-1');
  assert.strictEqual(r.reused, true);
});
t('auto 无候选 → 新开（id 含 family，供下次复用）', () => {
  const dir = makeAgentDir({});
  const r = computeSessionId({ agentId: 'night-worker', taskName: 'foo-task-verify', agentDir: dir, now: 1786000000000 });
  assert.strictEqual(r.sessionId, 'task-night-worker-foo-task-1786000000000');
  assert.strictEqual(r.reused, false);
});
t('policy new → 强制新开', () => {
  const dir = makeAgentDir({
    'a_task-night-worker-foo-task-1.jsonl': { id: 'task-night-worker-foo-task-1', mtimeAgo: 2 * IDLE_MS },
  });
  const r = computeSessionId({ agentId: 'night-worker', taskName: 'foo-task-verify', agentDir: dir, policy: 'new', now: 1786000000000 });
  assert.strictEqual(r.reused, false);
  assert.ok(!r.sessionId.endsWith('foo-task-1'));
});
t('显式 id → 直接复用', () => {
  const dir = makeAgentDir({});
  const r = computeSessionId({ agentId: 'night-worker', taskName: 'foo-verify', agentDir: dir, policy: 'my-session-abc' });
  assert.strictEqual(r.sessionId, 'my-session-abc');
  assert.strictEqual(r.reused, true);
});
t('policy reuse 无候选 → 新开', () => {
  const dir = makeAgentDir({});
  const r = computeSessionId({ agentId: 'night-worker', taskName: 'foo-verify', agentDir: dir, policy: 'reuse', now: 1786000000000 });
  assert.strictEqual(r.reused, false);
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
