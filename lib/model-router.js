'use strict';
/**
 * lib/model-router.js — 模型定时/分级路由（默认参考值）
 *
 * 规则（用户定，2026-08-11 恢复夜间折扣窗）：
 *   ⚠️ 夜间折扣（22:00-8:00 本机时间）恢复：用户 2026-08-11 确认
 *      "22点~8点算晚上，qwen3.8 有折扣，这个时间段一些复杂任务可以派给它，
 *       而且它是多模态模型"。夜间复杂任务默认 → aliyun-tokenplan/qwen3.8-max·max。
 *   qwen3.8-max 定位 = 【夜间复杂任务默认 + 多模态看图默认 + 细活/精细任务】。
 *   看图/视觉任务（识别图片/截图分析）→ 默认 qwen3.8-max（多模态，不限于夜间；
 *      白天看图也用 qwen3.8——用户两次纠正：不用 mimo/opencode-go 免费池）。
 *
 *   默认路由：
 *     白天 普通任务 → opencode-go / deepseek-v4-flash · off（默认主力，go 订阅池）
 *     夜间 复杂任务 → aliyun-tokenplan / qwen3.8-max · max（夜间折扣价）
 *     看图/视觉     → aliyun-tokenplan / qwen3.8-max · max（多模态，不分昼夜）
 *     默认备选      → deepseek 官方（opencode-go 故障时，用户 2026-08-06 定）
 *     小任务        → omniroute-free / deepseek-v4-flash-free（免费池，不花钱）
 *   按需路由（任务头显式指定）：
 *     细活/精细 → aliyun-tokenplan / qwen3.8-max · max（贵，仅精细任务用）
 *     细活备选   → sub2-luna / gpt-5.6-luna · max（自建 sub IP 直连，tailscale 内网）
 *     阿里备用   → aliyun-tokenplan / deepseek-v4-flash-0731 · max（opencode 故障时切换）
 *
 * ⚠️ 注意：这里给出的只是【默认参考值】，不是强制规则。
 *    1. 智能体保留自主选模型能力——重大/特殊任务按智能判断选模型（claude、luna、free 池等）；
 *       任务文件可在头部用 provider: / model: / thinking: 显式覆盖（显式优先，机制保持）。
 *    2. opencode-go 默认只用 deepseek-v4-flash（go 订阅额度极少：5h $12/周 $30/月 $60）；
 *       glm-5.2/grok-4.5/kimi-k3 等大额模型非用户明确指定不得使用（详见 model-routing SKILL）。
 *    3. 阿里 token-plan 配额有限（曾 429 且 5 小时配额会耗尽）——夜间折扣价可用，
 *       但仍是付费通道，仅夜间复杂任务/看图默认启用。
 */

/** 夜间窗口（本机时间）：22:00 <= t < 08:00 */
const NIGHT_START = 22; // 22 点整含
const NIGHT_END   = 8;  // 8 点整不含

const ROUTES = {
  // 白天默认主力：opencode-go 订阅池 deepseek-flash
  day:   { provider: 'opencode-go',     model: 'deepseek-v4-flash',       thinking: 'off' },
  // 夜间默认（22-8，qwen3.8 折扣价 + 多模态）：阿里 qwen3.8-max
  night: { provider: 'aliyun-tokenplan', model: 'qwen3.8-max',            thinking: 'max' },
  // 多模态看图默认（不分昼夜，qwen3.8 多模态，不用免费池/mimo）
  vision:{ provider: 'aliyun-tokenplan', model: 'qwen3.8-max',            thinking: 'max' },
  // 小任务免费池
  small: { provider: 'omniroute-free',  model: 'deepseek-v4-flash-free',  thinking: 'off' },
  // 细活/精细任务专用（贵，任务头显式指定才用）：阿里 qwen3.8-max
  fine:  { provider: 'aliyun-tokenplan', model: 'qwen3.8-max',            thinking: 'max' },
  // 阿里备用（opencode 故障时切换）
  dayAli: { provider: 'aliyun-tokenplan', model: 'deepseek-v4-flash-0731', thinking: 'max' },
  // 细活备选：自建 sub IP 直连 gpt-luna（tailscale 内网）
  fineLuna: { provider: 'sub2-luna',    model: 'gpt-5.6-luna',            thinking: 'max' },
  // 小任务备选：xxsxapi 商汤渠道 deepseek（免费池不可用时）
  smallSense: { provider: 'xxsx',    model: 'deepseek-v4-flash',      thinking: 'off' }
};

/**
 * 是否处于夜间窗口（22:00 <= t < 08:00，本机时间）。
 * @param {Date} [now] 注入时间（单测用，默认当前时间）
 * @returns {boolean}
 */
function isNightWindow(now) {
  const d = now || new Date();
  const h = d.getHours();
  return h >= NIGHT_START || h < NIGHT_END; // 22-24 或 0-7
}

/**
 * 按本机时间返回默认路由：夜间 → qwen3.8-max（折扣价），白天 → deepseek-flash。
 * @param {Date} [now] 注入时间（单测用，默认当前时间）
 * @returns {{provider:string, model:string, thinking:string, window:'night'|'day'}}
 */
function defaultRoute(now) {
  if (isNightWindow(now)) return { ...ROUTES.night, window: 'night' };
  return { ...ROUTES.day, window: 'day' };
}

/** 多模态看图/视觉任务默认路由（不分昼夜 → qwen3.8-max） */
function visionRoute() {
  return { ...ROUTES.vision };
}

/** 是否视觉/看图类任务（识别图片/截图/图像分析） */
function isVisionTask(text) {
  if (!text) return false;
  return /看图|看图片|图片识别|识别图片|截图分析|识别截图|截图|图像分析|图像识别|图片分析|图分析|图片内容|这张图|screen[ _]?shot|image analysis|analy[sz]e (image|picture|photo|screenshot)|ocr/i.test(String(text));
}

/**
 * 按任务大小返回分级路由（免费小活 / 默认大活）。
 * @param {'small'|'large'} size
 * @returns {{provider:string, model:string, thinking:string}}
 */
function opencodeRoute(size) {
  if (size === 'small') return { ...ROUTES.small };
  return { ...ROUTES.day };
}

/** 细活/精细任务路由（qwen3.8-max，显式调用才用） */
function fineRoute() {
  return { ...ROUTES.fine };
}

/** 细活备选：自建 sub IP 直连 gpt-luna（max 思考） */
function fineLunaRoute() {
  return { ...ROUTES.fineLuna };
}

/** 小任务备选：xxsxapi 商汤渠道 deepseek */
function smallSenseRoute() {
  return { ...ROUTES.smallSense };
}

/** 阿里白天备用（opencode 故障时切换） */
function dayAliRoute() {
  return { ...ROUTES.dayAli };
}

module.exports = {
  defaultRoute, isNightWindow, visionRoute, isVisionTask,
  opencodeRoute, fineRoute, fineLunaRoute, smallSenseRoute, dayAliRoute,
  NIGHT_START, NIGHT_END, ROUTES
};
