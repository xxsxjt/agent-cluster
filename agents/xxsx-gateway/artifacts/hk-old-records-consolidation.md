# HK 旧对话记录处理 — 审查/沉淀/归档/清理/并入确认

> 任务：hk-old-records（xxsx-gateway）
> 执行时间：2026-08-09 13:15-13:20（HK 时区近似）
> 处理对象：HK new-api `admin_assistant_conversations` + `admin_assistant_messages` 残留旧记录
> 数据源：`/data/xxsx-api/new-api-data/xxsx-new-api.db`

## 一、审查分类（全量 38 会话 / 897 消息）

按 kind/agent/内容分类结果：

| 类别 | 会话 id | 数量 | 处置 |
|---|---|---|---|
| 自动巡检历史（automatic/hermes，无用户消息，已被 daily-meeting 取代） | 2,6,7,9,10,15,16,18,19,20,21,22,24,25,26,27,28,29,30,31,32,33,38 | 23 | **清理** |
| primary 身份/自我介绍测试 | 23（Hermes 管理主会话）、34（虚无圣灵分身测试） | 2 | **清理** |
| primary 空会话（agent 初始化占位） | 35（coo）、36（server-admin）、37（pm） | 3 | **清理** |
| 空会话 / 无意义测试 | 11（0 消息）、17（"1""1"） | 2 | **清理** |
| **真实用户对话（保留）** | 1、3、4、5、8、12、13、14 | **8** | **保留** |

**判定依据**：
- 23 个自动巡检会话全部只有 `system`+`assistant` 角色消息、无用户消息，为 Hermes 每日自动巡检产物；新体系已由 daily-meeting 取代 → 无保留价值，归档清理。
- primary 会话为 2026-08-08 的 agent 身份测试（"你是谁/一句话介绍自己"）或初始化空会话 → 测试，清理。
- 8 个 manual/无 kind 会话为**真实用户对话**（含补偿用户、查调用异常、构建安卓应用/uno、改公告等真实业务操作）→ 保留。

## 二、沉淀摘要（详见 org/knowledge/assistant-history-consolidation.md）

从旧记录提炼的用户关注点/常用操作：
- **用户补偿机制**：用户报错 → 送余额 + 邮件致歉 + 订阅升一级（邮箱 1538074323@…、2875358975@…）。
- **调用异常排查**：关注具体用户（hjgzs）调用异常、524 报错、`Selected model is at capacity`。
- **新用户增长**：每日新增用户/注册邮箱/token 消耗。
- **服务公告管理**：上游公告文案调整（"暂时不可用" → "偶尔可用"）。
- **常用操作**：移动服务器管理、构建安卓 APK 挂载下载链接（`https://api.xxssxx.top/downloads/`）、uno 网页/安卓版、模型测试（grok-4.5/gpt-5.5/OpenAI 兼容配置）。
- **已识别技术细节**：OmniRoute 上游（`http://*.1:20128`、出站代理 `http://*.1:7890`）、gmail 邮件发送。

## 三、归档路径（全部可回滚）

1. **HK 数据库级备份**：`/data/xxsx-api/backups/assistant-records-20260809-1315.db`（162MB，清理前全量）
2. **HK CSV 全量导出**：`/data/xxsx-api/backups/assistant-records-20260809-1315/{conversations,messages}.csv`
3. **本地 CSV 导出**：`org/artifacts/hk-old-records/{conversations,messages}.csv`
4. **本地审查报告**：`org/artifacts/hk-old-records/audit-report.txt`
5. **本地压缩归档**：`C:\Users\du_ji\pi_workspace\output\hk-old-assistant-records-20260809-1315.zip`（含报告+CSV）
6. HK 备份目录同时间戳，可用于审计/恢复。

## 四、清理清单（已执行）

**删除** 30 个会话及其 messages：
- id 2,6,7,9,10,11,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38
- 对应 messages 行同步删除（事务 `BEGIN IMMEDIATE ... COMMIT`）
- 清理前：38 conv / 897 msgs → 清理后：**8 conv / 89 msgs**

**保留** 8 个真实对话（id 1,3,4,5,8,12,13,14），其 messages 完整无损（1:26 / 3:6 / 4:2 / 5:11 / 8:10 / 12:10 / 13:14 / 14:10）。

**可回滚**：若需恢复，从 `assistant-records-20260809-1315.db` 备份库将对应行 INSERT 回生产库即可。

## 五、并入新体系确认

- **本机分身（虚无圣灵）**：`twin-chat-records` 任务（代理读取本机记录）为**新的对话事实源**。
- **HK Hermes**：清理后 Hermes 模式 APP 打开仅显示 8 个有保留价值的真实对话，干净无测试/巡检残留。
- 新旧体系并存明确：APP 默认分身显示本机记录；Hermes 显示 HK 保留记录。
- 沉淀文档已并入 `org/knowledge/assistant-history-consolidation.md`，供未来会话参考。

## 六、遗留/备注

- 自动巡检历史已随 daily-meeting 机制更新而退役；如后续需要历史巡检参考，从备份库查询。
- 导出文件含对话内容，仅本地/HK 存储，未外传。
- 涉及隐私的邮箱地址在沉淀文档中已做 `***` 部分脱敏处理。
