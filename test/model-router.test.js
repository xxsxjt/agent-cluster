#!/usr/bin/env node
/**
 * test/model-router.test.js — lib/model-router.js 单元测试
 * 覆盖：夜间折扣窗（22:00-08:00 → qwen3.8-max·max）、白天（→ deepseek-flash）、
 * 看图/视觉任务（→ qwen3.8-max 多模态，不分昼夜）、显式覆盖优先。
 * 运行：node test/model-router.test.js（退出码 0 = 全通过）
 */
'use strict';
const assert = require('assert');
const {
  defaultRoute, isNightWindow, visionRoute, isVisionTask,
  NIGHT_START, NIGHT_END, ROUTES
} = require('../lib/model-router');

let pass = 0, fail = 0;
function chk(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.error('  ✗ ' + name + ' → ' + e.message); fail++; }
}
// 构造某小时的本机时间（2026-08-05 为周三）
const at = h => new Date(2026, 7, 5, h, 30, 0);

console.log('[model-router] 夜间窗口（22:00 <= t < 08:00）→ aliyun qwen3.8-max · max');
chk('23:00 → 夜间档', () => {
  const r = defaultRoute(at(23));
  assert.strictEqual(r.window, 'night');
  assert.strictEqual(r.provider, 'aliyun-tokenplan');
  assert.strictEqual(r.model, 'qwen3.8-max');
  assert.strictEqual(r.thinking, 'max');
});
chk('00:00（午夜边界）→ 夜间档', () => {
  const r = defaultRoute(at(0));
  assert.strictEqual(r.window, 'night');
  assert.strictEqual(r.model, 'qwen3.8-max');
});
chk('07:59 → 夜间档', () => {
  const r = defaultRoute(new Date(2026, 7, 5, 7, 59));
  assert.strictEqual(r.window, 'night');
});
chk('isNightWindow(22:00) = true（下边界含）', () => assert.strictEqual(isNightWindow(at(NIGHT_START)), true));

console.log('[model-router] 白天窗口（08:00 <= t < 22:00）→ opencode-go deepseek-v4-flash');
chk('08:00（白天边界）→ 白天档', () => {
  const r = defaultRoute(at(NIGHT_END));
  assert.strictEqual(r.window, 'day');
  assert.strictEqual(r.provider, 'opencode-go');
  assert.strictEqual(r.model, 'deepseek-v4-flash');
  assert.strictEqual(r.thinking, 'off');
});
chk('14:00 → 白天档', () => assert.strictEqual(defaultRoute(at(14)).window, 'day'));
chk('21:59 → 白天档（上边界不含 22）', () => {
  const r = defaultRoute(new Date(2026, 7, 5, 21, 59));
  assert.strictEqual(r.window, 'day');
});
chk('isNightWindow(08:00) = false', () => assert.strictEqual(isNightWindow(at(NIGHT_END)), false));

console.log('[model-router] 多模态看图/视觉 → qwen3.8-max（不分昼夜）');
chk('visionRoute 返回 qwen3.8-max · max', () => {
  const r = visionRoute();
  assert.strictEqual(r.provider, 'aliyun-tokenplan');
  assert.strictEqual(r.model, 'qwen3.8-max');
  assert.strictEqual(r.thinking, 'max');
});
chk('isVisionTask：识别图片 / 截图分析 / OCR 命中', () => {
  assert.strictEqual(isVisionTask('请识别这张图片内容'), true);
  assert.strictEqual(isVisionTask('分析截图并总结'), true);
  assert.strictEqual(isVisionTask('对这张图做 OCR'), true);
  assert.strictEqual(isVisionTask('screenshot 内容分析'), true);
});
chk('isVisionTask：普通文本不误命中', () => {
  assert.strictEqual(isVisionTask('请写一篇公众号文章'), false);
  assert.strictEqual(isVisionTask('帮我重构代码'), false);
});

console.log('[model-router] 默认参数 = 当前时间（不注入也能跑）');
chk('defaultRoute() 返回合法结构', () => {
  const r = defaultRoute();
  assert.ok(['night', 'day'].includes(r.window));
  assert.ok(r.provider && r.model && r.thinking);
});

console.log('[model-router] ROUTES 关键条目存在');
chk('day / night / vision 三档齐全', () => {
  assert.ok(ROUTES.day && ROUTES.night && ROUTES.vision);
  assert.strictEqual(ROUTES.night.model, 'qwen3.8-max');
  assert.strictEqual(ROUTES.vision.model, 'qwen3.8-max');
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
