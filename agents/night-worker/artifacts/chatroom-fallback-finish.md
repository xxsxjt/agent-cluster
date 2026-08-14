# 聊天室 fallback 收尾验证报告（chatroom-fallback-finish）

- **执行时间**：2026-08-06 17:34 ~ 20:36（HK 服务器时区）
- **执行者**：night-worker
- **目标服务器**：xxsx-main-hk（100.97.18.59，xxsx-api 3461）

## 结论摘要

**全部验证通过**：渠道 #36（opencode-go）可用、商汤 #28（5 key）全有效、fallback 链路真实生效、10 频道当前全部健康（last_error 全清、持续轮询成功）。无 404 事故复发。

---

## 1. 渠道 #36（opencode-go）验证 ✅

| 项目 | 值 |
|---|---|
| 渠道 ID / 名称 | #36 opencode-go |
| type / status / priority | 1（OpenAI 兼容）/ 1（启用）/ 50 |
| base_url | `https://opencode.ai/zen/go`（**已修复，无 /v1 重复**） |
| models | `deepseek-v4-flash`（裸模型名直透，无 model_mapping） |
| 创建时间 | 2026-08-06 17:25:16 |

**验证结果**：
- **直连 upstream**：`POST https://opencode.ai/zen/go/v1/chat/completions`（用 #36 渠道 key）→ **HTTP 200**，耗时 2.7s，正常返回 deepseek-v4-flash 推理结果
- **经 new-api 内部链路**：用 default 组 token 强制指定渠道（`Bearer sk-<token>-36`）调 `127.0.0.1:3461/v1/chat/completions` → **HTTP 200**，content 正常返回"收到"
- 17:30 事故中 #36 的 404（opencode 站 "Not Found" HTML 页）已确认根因为 base_url `/v1` 重复（`/zen/go/v1/v1/...`），修复后不再复现

## 2. 商汤渠道 #28 状态 ✅

| 项目 | 值 |
|---|---|
| 渠道 ID / 名称 | #28 商汤日日新 |
| status / priority | 1（启用）/ **88**（> #36 的 50，路由优先） |
| models | sensenova-6.7-flash-lite, deepseek-v4-flash, glm-5.2, sensenova-u1-fast |
| key | **5 个**（\n 分隔，is_multi_key 轮换），创建于 07-09，test_time 07-30——**本次任务未改动** |

**key 有效性逐个直连测试**（`token.sensenova.cn/v1/chat/completions`）：
- key1~key5 → **全部 HTTP 200**（2~7 秒），无失效 key
- 备注：记忆记录"6 个有效 key"为 07-30 时状态，当前 5 个（非本任务改动，渠道 created/test_time 无变化）；5 个 key 全部有效，渠道工作正常

**路由优先级确认**：消费日志证实正常请求走 `use_channel:["28"]`（channel_id=28），priority 88 > 36 的 50，**商汤为主渠道**。

## 3. fallback 链路验证 ✅（真实生产案例，未冒险禁主渠道）

**采用零风险验证**：不用禁用商汤的方式（任务教训明确警告不可长时间下线主渠道），改用两条证据链：

1. **强制指定渠道测试**：admin token 后缀 `-36` 强制走 #36 → 200；`-28` 强制走 #28 → 200（两者均通过 new-api 完整内部链路）
2. **真实 fallback 案例**（商汤瞬时 429 时自动切换 #36，均成功）：
   - 17:36:11：`use_channel:["28","36"]` → 最终 channel_id=36，200（playground 请求）
   - 17:37:22：商汤某 key 429（quota exceeded）→ fallback 到 #36 → **200 成功**（weibo 频道）
   - 17:37:28 起商汤 key 轮换恢复（multi_key_index 1~4 轮换正常）

结论：**fallback 链路已配置且实际生效**，无需再主动禁用商汤做破坏性测试。

## 4. 10 频道最终状态 ✅

`SELECT source,model_name,last_error FROM chat_room_topic_agents`（20:36 快照）：

| id | source | model | last_error | 最近轮询成功 |
|---|---|---|---|---|
| 1 | weibo | deepseek-v4-flash | None ✅ | 20:30:43 |
| 2 | douyin | deepseek-v4-flash | None ✅ | 20:31:24 |
| 3 | bilibili | deepseek-v4-flash | None ✅ | 20:32:15 |
| 4 | toutiao | deepseek-v4-flash | None ✅ | 20:33:41 |
| 5 | zhihu | deepseek-v4-flash | None ✅ | 20:33:14 |
| 6 | baidu | deepseek-v4-flash | None ✅ | 20:34:05 |
| 7 | tieba | deepseek-v4-flash | None ✅（"串门发言"为业务逻辑消息非渠道故障） | 20:35:03 |
| 8 | github | deepseek-v4-flash | None ✅ | 20:35:30 |
| 9 | x | deepseek-v4-flash | None ✅ | 20:35:44 |
| 10 | coordinator | deepseek-v4-flash | None ✅ | 20:30:22 |

**观察窗口（17:55~18:06 + 全程 17:34~20:36 日志回溯）**：
- 无 404（修复后 0 次）
- 429 仅商汤瞬时 TPM/quota 限流（18:00-18:06 区间 0 次；19:08 一次 5M TPM 瞬时 429 单请求失败，19 秒后同 token 即成功；均被 key 轮换/fallback 吸收）
- 消费分布（18:00-18:06）：#28 ×179、#25 ×11、#36 ×1，全部成功
- 频道轮询节奏正常（每频道约 3-5 分钟一轮，updated_time 持续刷新）

**代码确认**（本地源码 chat_room_topic_agent.go）：`CompleteChatRoomTopicAgentVisitSlot/TopicSlot` 成功路径会 `last_error=""` 清空；`Defer*Slot` 失败路径写入错误。故 last_error=None = 最近一次轮询成功。

## 5. 附注

- **root 组 503**（17:36:20/29 日志）：`No available channel for model deepseek-v4-flash under group root` —— deepseek-v4-flash 渠道（#28/#25/#36）组均为 `default`，root 组 token 无渠道可用。**不影响聊天室**（聊天室走 default 组），但若未来有 root 组服务要调 deepseek-v4-flash 需将渠道组扩展或建 root 组渠道。本次未改动（避免影响现有路由）。
- 未修改任何 DB 数据（只读查询 + 测试调用），无备份需求。
- 临时文件已清理：/tmp/check_*.py、/tmp/test_*.sh、/tmp/keys.env（含脱敏 key 的掩码）、/tmp/watch-*.log 保留至报告完成后清理。

## 教训（防重蹈覆辙）

1. **主渠道绝不可长时间下线**：上次事故 = 测试时禁用商汤 + #36 base_url 带 /v1 重复 → 8 频道 404。本次全程未触碰商汤 status。
2. **验证 fallback 不必破坏性测试**：new-api 支持 admin token 加 `-<渠道id>` 后缀强制指定渠道（middleware/auth.go parseSpecificChannelIDPart），零风险验证任意渠道内部链路；配合消费日志 `use_channel` 数组即可确认 fallback 实际行为。
3. **last_error 字段语义**：成功轮询会清空（值为 None = 健康），残留旧错误不代表当前故障；判断健康看 updated_time 是否持续刷新。
4. **商汤渠道有瞬时 TPM 限流（5M~120M 波动）**：单次 429 属正常，靠 multi-key 轮换 + #36 fallback 吸收，无需人工干预。
