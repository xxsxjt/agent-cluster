# PPSRC 第二轮 — 自主推进（分身决策）报告

**agent**: security | **时间**: 2026-08-08 | **状态**: 完成（自主推进，无 C0 / 0 提交候选）
**授权链**: 用户（委托分身决策）→ 分身（允许注册测试账号）→ 本任务执行

---

## 一、本轮任务执行情况

| 任务项 | 结果 |
|--------|------|
| 1. 注册测试账号 | ❌ **不可行**（技术性阻断，非决策问题，见下） |
| 2. 认证后高价值测试（对象越权/会话重置/业务状态） | ⛔ 依赖测试账号，无法执行 |
| 3. 衍生入口（JS/旧版API/动态路由） | ✅ 已做（CAS SSO 面逆向测绘） |
| 4. 持续假设→验证循环 | ✅ 3 条新假设+处置 |
| 5. WAF 应对（触发即降频/暂停） | ✅ 全程遵守 |
| 6. report.md | ✅ 本轮报告（含限制说明） |

**结论：无 confirmed(C0) 漏洞，0 提交候选。** 诚实原因 = 测试账号注册被技术控制阻断，认证后 P0 面无法触及。

---

## 二、为什么"允许注册"却注册不了（关键事实，非借口）

分身已授权注册，但实际操作中注册被 **四重技术控制** 联合阻断：

1. **aliyun WAF 拦截自动化提交**：`register.shtml` / `checkEmailExisted.shtml` / `authCodeCreator` / `checkRegisterAuthCode` 对 curl 自动化一律返回 **405「阻断页面」或 JS 挑战页**（alicfw v1.200309.1）；真实浏览器内 `fetch` 提交 `register.shtml`（带完整字段）**挂起 PENDING 不返回** —— WAF 识别并拦截了自动化提交。
2. **图形验证码不可可靠 OCR**：注册/登录均需 5 位图形验证码；round1 捕获的 captcha OCR 置信度仅 0.554，且验证码本身设计对抗 OCR。
3. **个人注册被 CAS SSO 门控**：`portal.gopay.com.cn/cust/gist/toRgist.shtml`（个人注册页）在真实浏览器中 **302 重定向到 `auth.gopay.com.cn/login?service=portal/auth`** —— 个人注册需已有会话，形成"先有账号才能注册"的死循环。
4. **企业注册需完整企业资料**：`corpname/phone/地址/省市` + RSA 加密密码 + 验证码 + 邮件激活，不适合快速测试账号。

**结论**：注册测试账号当前在技术层面不可行，认证后测试因此无法执行。这是如实的技术限制，非决策卡点。

---

## 三、本轮实际产出（匿名只读面）

### 3.1 CAS SSO 登录面逆向测绘（login.js / loginCheckAndSubmit.js）
- **用户类型**：10（个人）/20（企业）/21、22（操作员）/60（短信登录）/70、71（token 登录）
- **认证端点**：
  - `checkAuthCode?timestamp=X`（5 位图形验证码校验，POST authCode）
  - `getPwdUUID`（密码控件 uuid）
  - `loginSMS`（短信登录，**客户端已注释移除**）
  - `accessUseSmsVerifyCode`（判断账号是否需要短信验证，**客户端已注释移除**）
- **登录表单内部字段**：`lt`（loginTicket）、`sessionId`（CAS 会话）、`_eventId=submit`、`clientIp`、`password`（RSA/ppcn.getOldEncrypt 密文）

### 3.2 遗留服务端端点（research-note）
- **`accessUseSmsVerifyCode` 服务端仍活跃**：客户端 JS 已注释移除，但服务端仍响应匿名 POST，返回 `{"access":false,"status":"0"}` → 账号短信验证需求枚举预言机（同 checkEmailExisted 类，低价值）。
- **`loginSMS` 未触发**（避免向真实手机号发短信——属 RoE 外副作用，未测试）。

### 3.3 CAS 开放重定向向量（research-note）
- `auth.gopay.com.cn/login?service=<攻击者URL>` 将 service 反射到表单 `action`。
- **但**：重定向发生在登录成功后，非 RoE 允许的「单击立即重定向」例外；未演示跨用户 token 窃取/敏感数据泄露 → research-note，不提交。

### 3.4 匿名 API/支付面确认
- `api.paypal.cn` / `open.paypal.cn` / `services.paypal.cn`：全部 **405 严格方法门控**，无匿名数据面。
- `t.paypal.cn`（短链）：405 门控。
- `cashier.gopay.com.cn/static/js/cashier.js`：404。
- paypal.cn `/portal`：Next.js 静态营销站，无业务 API。

---

## 四、过审影响门禁评估（round2）

| 门禁项 | 评估 |
|--------|------|
| 对象危害 | ❌ 无跨用户/跨租户/未授权管理面数据回显 |
| 服务端成立 | ⚠️ 有活跃服务端端点，但无危害行为（枚举=低价值） |
| 可复现差分 | ❌ 枚举类受 WAF/无有效账号对照，不可用于提交 |
| 非自嗨面 | ⚠️ 无账号，未到自嗨面 |
| 链路闭合 | ❌ 无完整危害链 |

**结论**：全部不满足 → 无提交候选。无 CVSS 评分项。

---

## 五、下一步（需要主会话/人工提供的前提）

1. **提供测试账号**（个人或企业国付宝/贝宝账号）→ 立即解锁认证后 P0 测试（对象越权 A→B、会话/重置、业务状态），这是本 SRC 最高价值面。
2. **或**：人工在真实浏览器手动注册一个账号（验证码由人解决），把会话交给 security 继续。
3. **或**：明确放宽图形验证码约束（提供绕过思路/测试环境），否则注册自动化被 WAF+验证码+CAS 三重复合阻断。
4. CAS `loginSMS`/`accessUseSmsVerifyCode` 遗留端点是低风险枚举面，可作一次性报告或建议收敛。

---

## 六、产出路径
- Engagement：`C:\Users\du_ji\.agents\skills\authorized-pentest-autonomous\engagements\2026-08-08_paypal.cn\`（actions.log / state/findings.jsonl / state/hypotheses.jsonl 已更新）
- 本轮报告：`org\agents\security\artifacts\ppsrc-round2.md`
- 中间数据：`pi_workspace\scratch\ppsrc\`（CAS JS、注册页、验证码）
