/**
 * test/domain-route.spec.js — 业务域路由单测（含 2026-08-11 调度约束：查服务器/状态/版本/日志强制 server-admin）
 * 黑盒 require lib/domain-route，不启动 butler，不影响运行中的管家。
 * 用法: node test/domain-route.spec.js
 */
'use strict';
const { routeDomain } = require('../lib/domain-route');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✅ ' + msg); } else { fail++; console.log('  ❌ ' + msg); } };
const route = t => routeDomain({ name: t, content: t });

console.log('=== A. 违规案例：查服务器/节点状态/版本/日志/验证 → 必须 server-admin ===');
const mustServer = [
  'cnb-node-test-resume-verify',      // CNB 节点环境快照/版本/验证
  'hk-hub-e2e',                       // HK hub 端到端验证
  'verify-cnb-routing-live',          // 验证 CNB 路由（含"路由"曾误归 night-worker）
  'cnb-route-live-verify',            // 同上
  'cnb-route-restart-verify',         // 验证 CNB 路由重启
  'uumit-cnb1-e2e-verify',            // uumit CNB 节点 e2e 验证
  'checkpoint-uumit-cnb1-e2e-verify', // checkpoint 变体
  'cnb-保活加固-持久存储评估',           // CNB 保活（服务器运维）
  'hk-节点可用性检查',
  '查询CNB服务器版本与日志',
];
for (const t of mustServer) ok(route(t) === 'server-admin', `[server-admin] ${t}`);

console.log('\n=== B. 不应误伤：构建/开发/渠道/app/内容任务 → 不得归 server-admin ===');
const mustNotServer = [
  'cnb-build-test',                     // 构建 → 归 cnb（被 build 排除）
  'checkpoint-cnb-build-test',          // 构建 checkpoint
  'cnb-构建任务带环境自愈标记重派验证',   // 构建+自愈
  'hk-渠道余额探活',                    // 渠道探活 → channel-manager（OTHER_DOMAIN 排除）
  'HK-侧渠道-key-配置核验',             // 渠道配置核验
  'ask-app-version',                    // app 版本 → xxsx-gateway（无服务器锚）
  'HK-恢复后补-HK-侧渠道留痕',           // 渠道留痕（无服务器查询 action）
  '写小说-勇者之章-第5章',               // 小说
  '公众号爆款文案生成',                 // 文案
  'MC mod 开发新物品',                 // mc 开发
];
for (const t of mustNotServer) {
  const r = route(t);
  ok(r !== 'server-admin', `[not server-admin, got=${r}] ${t}`);
}

console.log('\n=== C. 既有业务域路由不回归 ===');
const expect = [
  ['xxsx 网关 app 更新发布', 'xxsx-gateway'],
  ['服务器 nginx 部署配置', 'server-admin'],
  ['渠道 fallback 冷却空回复', 'channel-manager'],
  ['公众号营销文案作品集', 'copywriting'],
  ['seedance 视频成片', 'video-prod'],
  ['安全渗透 src 漏洞', 'security'],
  ['gradle maven 构建 MC mod', 'mc-dev'],
  ['butler 派发 集群 分工 路由优化', 'night-worker'],
];
for (const [t, e] of expect) {
  const r = route(t);
  ok(r === e, `[${e}] ${t} (got=${r})`);
}

console.log(`\n==== 结果: ${pass} 通过 / ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
