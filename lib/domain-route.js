/**
 * lib/domain-route.js — 业务域路由（2026-08-10 分工铁律落地 + 2026-08-11 调度约束增强）
 *
 * 把"未显式绑定 agent/group"的任务按关键词路由到正确业务域的智能体，
 * 纠正 night-worker 任务垄断 / server-admin 职责被抢。
 *
 * 优先级（routeDomain 内）：
 *   1. 服务器查询/验证/状态/版本/日志类（增强，2026-08-11）→ server-admin
 *      —— 防 cnb-node-test-resume-verify / hk-hub-e2e 类"查节点状态/版本/日志/可用性"任务
 *         被 night-worker（含"路由/route"词）或 coo 兜底误派。
 *   2. 基础 DOMAIN_ROUTES（顺序：越具体越靠前，先 APP/网关、服务器、渠道，后框架兜底）
 *
 * 服务器查询判定说明：
 *   - 需同时命中【服务器/节点锚词】+【查询验证动作词】，且
 *   - 排除【纯构建/开发类】（归 cnb 侧路由）与【明确业务内容域】（渠道/写作/视频/插画/安全/mc），
 *     避免把 cnb 构建、hk 渠道探活等任务误归 server-admin。
 *
 * 用法：const { routeDomain } = require('./lib/domain-route');
 *       const agentId = routeDomain(task);   // agentId | null
 */
'use strict';

/** 基础域路由表：[正则, 智能体id, 说明] —— 单一来源，butler.js 也复用 */
const DOMAIN_ROUTES = [
  [/xxsx|网关|gateway|中转|用户端|管理端|app更新|APP更新|apk|安卓|手机|发布app|发布APP/, 'xxsx-gateway', 'APP/网关'],
  [/服务器|server|部署|nginx|vps|运维|systemctl|docker|保活|health-check/, 'server-admin', '服务器运维'],
  [/渠道|channel|fallback|冷却|空回复|余额|探活/, 'channel-manager', '渠道管理'],
  [/公众号|文案|营销|作品集|portfolio/, 'copywriting', '公众号内容'],
  [/小说|番茄|勇者之章|写作/, 'novel', '小说创作'],
  [/视频|seedance|成片|预览片/, 'video-prod', '视频制作'],
  [/插画|出图|takina|绘图|image/, 'takina', '插画出图'],
  [/安全|渗透|src|漏洞|防御/, 'security', '安全'],
  [/mc|minecraft|mod|maven|gradle|虚无圣殿/, 'mc-dev', 'MC开发'],
  [/框架|butler|spawn|route|schedule|watchdog|派发|集群|org|智能体集群|分工|路由/, 'night-worker', '框架开发'],
];

/* —— 服务器查询/验证/状态/版本/日志 增强（2026-08-11 分工铁律调度约束）—— */

/** 服务器/远程节点锚词：任务语境确实指向服务器/节点（否则不触发，避免误伤 app 版本/内容任务） */
const SERVER_ANCHOR_RE =
  /服务器|server|远程|remote|云主机|节点|node|主机|cnb|hk|ssh|tailscale|systemctl|nginx|docker|保活|探活|进程|uptime|磁盘|内存|cpu|负载|uname|端口|防火墙|systemd|cloudflared/;

/** 查询/验证/状态/日志 动作词：确认是"查/验"而非"开发/构建" */
const SERVER_ACTION_RE =
  /状态|status|版本|version|日志|log|验证|verify|检查|check|探测|probe|快照|snapshot|e2e|连通|可达|测试|test|健康|health|可用性|availability|存活|在线|环境快照|存活检测/;

/** 纯构建/开发类排除：这些归 cnb 侧路由 / cnb-dev / cnb-build，不归 server-admin */
const SERVER_EXCLUDE_RE =
  /构建|build|编译|打包|gradle|maven|开发|实现|implement|feature|bug|修复|fix|小说|写作|文案/;

/** 明确业务内容域排除：即使含服务器锚+查询词，也归对应业务域（渠道/内容/安全/mc） */
const OTHER_DOMAIN_RE =
  /渠道|channel|余额|fallback|冷却|空回复|文案|营销|作品集|小说|番茄|写作|视频|seedance|成片|插画|takina|绘图|出图|公众号|渗透|漏洞|src|minecraft|mod|安全|防御/;

/** 判断任务是否为"查服务器/节点状态/版本/日志/可用性"类 → 强制归 server-admin */
function isServerQueryTask(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  if (!SERVER_ANCHOR_RE.test(t)) return false;      // 无服务器/节点语境 → 不触发
  if (!SERVER_ACTION_RE.test(t)) return false;      // 无查询/验证动作 → 不触发
  if (SERVER_EXCLUDE_RE.test(t)) return false;      // 纯构建/开发 → 归 cnb
  if (OTHER_DOMAIN_RE.test(t)) return false;        // 明确业务内容域 → 归对应域
  return true;
}

/**
 * 业务域路由主入口。
 * @param {object} task  { name, content, keywords, ... }
 * @returns {string|null} 智能体 id（未匹配返回 null，交调用方兜底 coo）
 */
function routeDomain(task) {
  const text = String(task && (task.content || task.name || '')).toLowerCase();
  // 1. 服务器查询/验证/状态/版本/日志 优先（放在基础循环前，防 night-worker 的"路由"词、coo 兜底误抢）
  if (isServerQueryTask(text)) return 'server-admin';
  // 2. 基础域路由
  for (const [re, agentId] of DOMAIN_ROUTES) {
    if (re.test(text)) return agentId;
  }
  return null;
}

module.exports = { routeDomain, isServerQueryTask, DOMAIN_ROUTES };
