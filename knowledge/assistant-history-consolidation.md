# HK Assistant 旧对话记录整合沉淀（2026-08-09）

> 来源：HK new-api `admin_assistant_conversations` + `admin_assistant_messages` 全量导出审查。
> 数据源：`/data/xxsx-api/new-api-data/xxsx-new-api.db`（备份 `backups/assistant-records-20260809-1315.db`）。
> 本机分身记录（twin-chat-records）为新的对话事实源；本文件为 HK 旧 Hermes 记录中**有保留价值的业务信息**提炼。

## 一、导出规模

- 会话总数：38；消息总数：897。
- 按 kind：automatic 23 / manual 9 / primary 5 / 无 kind 1。
- 时间跨度：2026-07-14 ~ 2026-08-09。
- 全部为 agent=hermes（twin/coo/pm/server-admin 的 primary 会话为 2026-08-08 身份测试或空会话）。

## 二、审查分类

| 类别 | 会话 id | 数量 | 处置 |
|---|---|---|---|
| 自动巡检历史（automatic，无用户消息） | 2,6,7,9,10,15,16,18,19,20,21,22,24,25,26,27,28,29,30,31,32,33,38 | 23 | 归档清理（已被 daily-meeting 新机制取代） |
| primary 身份/自我介绍测试 | 23（Hermes管理主会话）,34（虚无圣灵分身测试） | 2 | 清理 |
| primary 空会话（agent 初始化） | 35（coo）,36（server-admin）,37（pm） | 3 | 清理 |
| 空会话 / "1" 无意义测试 | 11（0消息）,17（"1""1"） | 2 | 清理 |
| **真实用户对话（保留）** | **1,3,4,5,8,12,13,14** | **8** | **保留** |

## 三、沉淀：用户关注点 / 常用操作（来自真实对话）

### 1. 用户核心关注点
- **服务稳定性与用户补偿**：用户主动处理用户报错（钱包界面报错、无法领取免费订阅），会**给受影响用户送余额补偿 + 发邮件致歉**（邮箱：1538074323@…、2875358975@…），补偿订阅升一级。
- **调用异常排查**：关注具体用户（如 hjgzs）某时段的调用异常；关注 524 报错、`Selected model is at capacity` 等上游错误。
- **新用户增长**：关注每日新增用户数、注册邮箱、token 消耗。
- **服务公告管理**：调整上游公告文案（"5.6-sol 和 image 暂时不可用" → "偶尔可用"）。
- **服务器资源**：磁盘空间、缓存清理。

### 2. 常用操作
- **移动服务器管理**：查用户调用、查磁盘、改公告、查模型。
- **构建安卓 APK 应用**：让 Hermes 构建安卓编码软件、uno 卡牌游戏，挂载到 `https://api.xxssxx.top/downloads/` 提供下载链接；或做适配手机 UI 的网页版。
- **模型测试**：测试 grok-4.5、gpt-5.5、OpenAI 兼容配置（model_provider/model_reasoning_effort 等）。
- **能力检索**：在 GitHub 找提升 gpt 前端能力的 skill。

### 3. 已识别但未沉淀的技术细节
- 上游服务：OmniRoute（本地地址 `http://*.1:20128`、出站代理 `http://*.1:7890`、数据目录 `/opt/xxsx-api/upstream/new-api-main/data/omniroute`）——早期运行状态，具体现状以新体系为准。
- 邮件发送：new-api 配置的 gmail 邮箱用于用户致歉/补偿通知。

## 四、与新旧体系关系

- **旧**：HK Hermes（hermes agent）管理旧对话记录；自动巡检为每日自动化任务。
- **新**：本机分身（虚无圣灵 twin-chat-records）为对话事实源；daily-meeting 取代每日自动巡检；HK Hermes 保留的真实对话继续在 Hermes 模式显示。
- 清理后 APP 打开（Hermes 模式）仅显示 8 个有保留价值的真实会话，其余测试/巡检/空会话已归档可回滚。

## 五、归档与清理记录

- 数据库级备份（可回滚）：HK `/data/xxsx-api/backups/assistant-records-20260809-1315.db`
- 全量 CSV 导出（本地）：`org/artifacts/hk-old-records/{conversations,messages}.csv`
- 审查报告：`org/artifacts/hk-old-records/audit-report.txt`
- 清理：删除上述 30 个会话（自动巡检 23 + primary 5 + 空/无意义 2）及其 messages 行；保留 8 个真实会话。
