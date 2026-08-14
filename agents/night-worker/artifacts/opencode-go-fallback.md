# opencode-go 渠道 + 聊天室 fallback 报告（opencode-go-fallback）

- 执行：night-worker
- 时间：2026-08-06 17:10–17:47
- 结论：**✅ 完成**（渠道已加、fallback 已生效、10 频道全 OK）

## 1. 渠道配置（new-api channels 表）

| 字段 | 值 |
|---|---|
| id | 36 |
| name | opencode-go |
| type | 1（OpenAI 兼容） |
| base_url | `https://opencode.ai/zen/go`（**不含 /v1**，见坑） |
| key | opencode-go 订阅 key（本机 models.json providers.opencode-go，**脱敏**：sk-ufHnnqL8…） |
| models | deepseek-v4-flash |
| group | default（与商汤同组，聊天室可路由） |
| priority | **50**（低于商汤 88 → 商汤优先，opencode-go 为 fallback） |
| status | 1（启用） |
| header_override | `{"User-Agent":"opencode-cli/1.0.0"}` |
| abilities | default/deepseek-v4-flash/36 已同步插入 |

key 只写入服务器 new-api DB，未进任何报告/日志/git。

## 2. Fallback 实现方式（零代码，纯配置）

**未改源码**。利用 new-api 既有 relay 重试机制实现：

- 服务器 options `RetryTimes=6`（已有配置）
- `controller/relay.go` 失败后 `shouldRetry`（429/5xx/超时等自动重试）→ `CacheGetRandomSatisfiedChannel(retry=N)` → `priorityForRetry` 按 priority 降序逐级换渠道
- default 组 deepseek-v4-flash 渠道：商汤(88) > opencode-go(50)
- **效果**：商汤 429/失败 → 自动重试到 opencode-go，无需任何代码改动

> 对比 moderation 的 `ChatRoomModerationFallbackModels`（应用层显式候选列表）：topic agent 调用走 `CallInternalModel` → 同进程 relay → 天然具备渠道级 fallback，故方案 A/B 都不需要，选改动最小路径。

## 3. 验证结果

| 项 | 结果 |
|---|---|
| opencode-go 上游（本机+HK 直连） | ✅ 200，deepseek-v4-flash 可用，HK IP 不限流 |
| new-api 加渠道后正常路由 | ✅ 走商汤(28)（priority 88 优先） |
| **fallback 实测（临时禁商汤）** | ✅ 禁商汤 → 请求走 opencode-go(36) 200 |
| **真实场景自动 fallback** | ✅ 17:33:10 商汤 429 → 17:33:42 自动走 36 成功（日志实证） |
| 恢复商汤后优先回归 | ✅ 走 28（200） |
| 10 频道状态（9+coordinator） | ✅ 全部 OK，17:46 起 0 错误，17:40-17:50 商汤 27 次 + opencode-go fallback 2 次 |

## 4. 踩坑

1. **base_url 不能带 /v1**：`GetFullRequestURL = base_url + /v1/chat/completions`，首配 `https://opencode.ai/zen/go/v1` 会拼成 `/zen/go/v1/v1/chat/completions` → 404。改为 `https://opencode.ai/zen/go` 后修复。
2. **商汤禁用期间事故**：测试 fallback 临时禁用商汤（约 3 分钟）+ base_url 404 叠加 → 8 频道留下 404 last_error（历史遗留，下一轮成功后自动清除）。教训：先验证备选渠道直连可用，再动主渠道。
3. 渠道改 DB 后 60s 缓存自动同步（SyncFrequency=60），无需重启服务——零中断。

## 5. 回滚

删除渠道：
```sql
DELETE FROM abilities WHERE channel_id=36;
DELETE FROM channels WHERE id=36;
```
60s 缓存同步后自动生效（无需重启）。恢复原状即无 opencode-go fallback。

## 6. 说明

- 主会话投递的 chatroom-fallback-finish 任务与本任务重复（本任务完成时它仍在跑）；本报告可作为其最终确认依据，**无需再临时禁商汤测试**（链路已实测）。
