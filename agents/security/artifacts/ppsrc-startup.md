# PPSRC 启动任务产出 — ppssrc-startup

**agent**: security | **时间**: 2026-08-08 | **状态**: 完成（启动+侦察+假设+低噪音验证，无 C0）

## 一、任务完成情况
- ✅ Engagement 初始化：`2026-08-08_paypal.cn`（skill engagements 目录），RoE 约束全量写入 meta.json + actions.log
- ✅ RECON 资产建模：16 资产全 in-scope（paypal.cn 6 + gopay.com.cn 10），证书/DNS 被动测绘
- ✅ 假设队列：5 条（P0-P2），blocked/inconclusive 处置明确
- ✅ 最小验证：匿名只读确认业务接口面；无 confirmed(C0)，0 提交候选
- ✅ 报告：report.md 生成（草稿，待用户验收，含限制与下一步）

## 二、核心发现（侦察层面）
- 业务架构：PayPal 中国 = **国付宝 GoPay**（已被 PayPal 收购）
  - `auth.gopay.com.cn` = CAS SSO 认证（虚拟键盘+证书+短信+动态口令）
  - `portal.gopay.com.cn/cust/*` = 客户系统（注册/找回密码/登录），Java `.shtml`，**curl 可匿名访问**
  - `cashier/wapcashier/bis/notify.gopay.com.cn` = 收银台/回调
  - `gateway.gopay.com.cn` = 支付网关（WAF JS 挑战）
  - `www.paypal.cn` = C3 营销门户（Next.js），无业务 API
- 匿名可访问业务接口（只读确认）：
  - `checkEmailExisted.shtml`（用户枚举，受 WAF 频控，低价值）
  - `register.shtml`（返回 Java 详细错误）
  - `toRegister.shtml` / `findloginpwdemail.shtml`（注册/找回密码页）
  - `authCodeCreator` / `checkRegisterAuthCode.shtml`（验证码）
  - 注册流程端点：`reSendSMS.shtml`、`mobileActivate.shtml`、`nextRegister.shtml`

## 三、无 C0 原因（诚实透明）
1. **无测试账号** → 无法验证认证后对象越权/会话/业务逻辑
2. **RoE readonly** → 注册/发短信/爆破/支付全 blocked
3. **核心支付面 WAF 保护** → curl 无法获得真实业务数据
4. 唯一匿名面（用户枚举）受 WAF 频控不可复现且属业务必要功能

## 四、下一步（需要用户决策）
- 提供测试账号 → 认证后深入
- 授权放宽（注册/找回密码验证）
- 浏览器会话过 WAF 观察支付链

## 五、产出路径
- Engagement：`C:\Users\du_ji\.agents\skills\authorized-pentest-autonomous\engagements\2026-08-08_paypal.cn\`
  - meta.json / state/assets.jsonl / state/hypotheses.jsonl / state/findings.jsonl / report.md / actions.log
- 临时数据：`C:\Users\du_ji\pi_workspace\scratch\ppsrc\`
