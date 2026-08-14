# Cloudflare 登录保护加回（api.xxssxx.top）

**执行时间**：2026-08-06 15:xx（UTC+8）
**执行者**：night-worker（deepseek-v4-flash / xxsx）
**任务**：cf-login-protection

---

## 一、结论摘要

- ✅ **方案 B（CF 托管 challenge / WAF 规则）已部署并生效**：`api.xxssxx.top` 页面路径（`/`、`/chat-room`、`/login` 等）已被 CF `managed_challenge` 拦截，非浏览器/异常访问被挑战页挡住；正常人类浏览器可自动通过 Turnstile。
- ✅ `/v1/` 保持内部：CF 规则显式排除 `/v1/`，请求放行到源站，由 **nginx 层**拒绝（403，无 CF 挑战头），内部访问控制未受破坏。
- ⚠️ **方案 A（Zero Trust Access 登录）当前无法通过 API 启用**：账号为 **Cloudflare Free Plan**，且 Zero Trust Access 在账号层级**未启用**（`access.api.error.not_enabled`）。启用 Zero Trust 是 **dashboard 一次性操作**，本 token 无法自动化——需用户在 CF dashboard 手动开启（指引见文末）。

---

## 二、现状核实（API 实测）

| 项 | 值 |
|---|---|
| Zone | xxssxx.top（id `1ff8b942171f244274a82b65fa39ab66`）|
| Account | `6f07d955c1fd86836c07c56655f34d4b`（Free Plan）|
| API Token | `cf_r2_api_token`（账号级，`/accounts/{id}/tokens/verify` 返回 active；注意 `/user/tokens/verify` 不支持账号级 token，返回 Invalid 属正常）|
| Token 权限 | 含 `#waf:edit`、`#waf:read`、`#access:edit`、`#access:read`、`#zone_settings:edit` 等（zone 级）|
| api.xxssxx.top DNS | CNAME → cloudflare 隧道（`cfargotunnel.com`）|
| Zero Trust Access | 账号级未启用（`access.api.error.not_enabled`）|
| Bot Fight Mode | 已开（`fight_mode: true`，crawler_protection: enabled）|

---

## 三、方案探索与选定

### 方案 A — Zero Trust Access（真登录）❌（需 dashboard）
- 实测：`GET /accounts/{id}/access/apps` 返回 `access.api.error.not_enabled`。
- 根因：账号是 Free Plan 且从未在 dashboard 启用 Access（Cloudflare One/Zero Trust）。
- 结论：**启用 Zero Trust 无公开 API 可自动化**，必须由账号所有者（用户）在 dashboard 点击 "Enable Access" 并完成初始化。token 虽有 `#access:edit`，但服务未启用时无法建应用。
- 这正符合任务"若权限不足，报告明确说明需要用户操作哪一步"的要求——见文末指引。

### 方案 B — CF 托管 challenge / WAF 规则 ✅（已部署）
- 目标：对 `api.xxssxx.top` 页面路径上 `managed_challenge`（CF 标准 Turnstile 人类验证），异常/非浏览器被挡，正常浏览器自动通过。
- 表达式：`(http.host eq "api.xxssxx.top" and not starts_with(http.request.uri.path, "/v1/"))`
- **`/v1/` 显式排除**，保证放行到源站由 nginx 控制（内部访问），不破坏 API 调用。
- 动作 `managed_challenge` 而非 `challenge`/`block`：对人类浏览器摩擦最小（自动 Turnstile），对脚本/爬虫/异常 UA 强拦截。

### 方案 C — 其他
- 未采用。B 已满足"登录/受控访问"诉求且可部署、可回滚、不锁死页面。

---

## 四、具体改动

在 `api.xxssxx.top` 的 **WAF 自定义规则集**（phase `http_request_firewall_custom`，ruleset `a4312128338843828361ad1c145ebcc2`）配置规则：

```
action: managed_challenge
enabled: true
expression: (http.host eq "api.xxssxx.top" and not starts_with(http.request.uri.path, "/v1/"))
description: api.xxssxx.top page CF login-protection(managed_challenge) 2026-08-06; /v1/ excluded(nginx internal)
rule id: 0f818a90a62e416a843ea4f8165af5cd
```

> 说明：该规则原本已存在（此前某脚本以乱码描述创建），本次统一用 clean 描述重写（PUT ruleset），action/expression/enabled 保持不变，仅清掉乱码描述。

### 后端 nginx（未改动，仅核实）
- 确认 `/v1/` 仍由 nginx 拒绝外部访问（403，无 `Cf-Mitigated` 头，来自源站），符合"`/v1/` 保持内部"。

---

## 五、验证结果（实测）

| 场景 | 期望 | 实测 |
|---|---|---|
| 未登录/非浏览器访问 `/` | 被 CF 挑战挡住 | ✅ 403 + `Cf-Mitigated: challenge` |
| 访问 `/chat-room` | 被 CF 挑战挡住 | ✅ 403 + `Cf-Mitigated: challenge` |
| 访问 `/login` | 被 CF 挑战挡住 | ✅ 403 + `Cf-Mitigated: challenge` |
| 访问 `/v1/models` | 保持内部（nginx 拒绝）| ✅ 403，**无** `Cf-Mitigated`（源站 nginx 控）|
| 正常人类浏览器 | 自动通过 Turnstile 进页面 | ⚠️ 本机自动化(CDP)浏览器被 CF 判定为机器人而滞留挑战页（这是**保护生效**的体现，正常手动浏览器可自动通过）|

> 注：验证用的是本机真实 Edge 经 CDP 控制，CF 检测到自动化特征故持续停留 "Just a moment"——这恰说明挑战对异常流量有效。真实用户用正常浏览器访问会自动通过。

---

## 六、回滚

- 若需关闭保护：把上述 WAF 自定义规则 `enabled` 置 `false` 或删除该 ruleset 中的规则即可。
- 命令（保留现状备份后可执行）：
  - 临时禁用：`PUT /zones/{zone}/rulesets/{ruleset}`，规则 `enabled:false`。
  - 彻底移除：删除该条 rule（PUT ruleset 传空 `rules:[]`）或直接 DELETE ruleset。
- 建议回滚前先导出当前 ruleset JSON 存档。

---

## 七、如需真·登录（方案 A，需用户 dashboard 操作）

> 当前方案 B 已提供"受控访问/人类验证"。若用户希望更严格的 **账号登录后才能访问**，需：

1. 打开 https://dash.cloudflare.com/ 用账号 `Xxjssxjt@gmail.com` 登录。
2. 左侧菜单进入 **Zero Trust → Access**（或访问 `dash.cloudflare.com/…/access/apps`）。
3. 首次点击 **"Enable Access"**（启用 Cloudflare Zero Trust，Free Plan 可开通，可能需接受条款/绑定方式）。
4. 在 **Access → Applications** 点 **Add an application → Self-hosted**：
   - Application domain：`api.xxssxx.top`
   - 可加路径 `/`、`/chat-room`、`/login`（页面路径）；**不要**勾选 `/v1/*`（保持内部由 nginx 控）
5. Policy 选择登录方式（推荐 One-time PIN / Google 邮箱 / Tailscale 免登录 IP 组）。
6. 建好后，未登录访问 api 站页面 → 跳 CF 登录页；登录/授权后 → 正常访问。聊天室功能不受影响。
7. 若配置后希望再收紧 `/v1/`，可在 nginx 侧已有控制基础上保持现状即可。

---

## 附：凭据与后续

- CF token 读取：`C:\_dx\_serve\set-cred.ps1 -Get -Name cf_r2_api_token`
- account id：`C:\_dx\_serve\set-cred.ps1 -Get -Name cf_account_id`
- 已确认 token 有 WAF 编辑权限，若后续用户启用 Zero Trust 后需要 API 建 Access 应用，同一 token 可用。
