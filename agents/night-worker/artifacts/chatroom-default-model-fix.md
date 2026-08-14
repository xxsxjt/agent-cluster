# 聊天室默认模型修复报告（chatroom-default-model-fix）

- 执行：night-worker（重建部署部分）+ 分身补验证
- 时间：2026-08-06 01:41–01:55
- 结论：**✅ 修复成功**

## 改动
`setting/chatroom/setting.go:38`：
```go
DefaultTopicAgentModel = "deepseek-v4-flash" // 原为 OpenCodeMiMoModel（opencode 免费池被 HK IP 限流）
```

## 部署
- 新二进制 v0.0.0-xxsx.chatroom-default-model.1-20260806 01:45 部署 `/opt/xxsx-api/bin/new-api`（部署前已备份）
- `systemctl restart xxsx-api-mi.service` → active

## 验证（分身补做）
| 项 | 结果 |
|---|---|
| 9 频道 model_name | ✅ 全部 `deepseek-v4-flash`（reconcile 已生效，不再被重置回 mimo）|
| 频道状态 | ✅ weibo/bilibili/zhihu/baidu/tieba/github OK；douyin/x 切换前遗留 429 已冷却退避，自动恢复 |
| 路由 | deepseek-v4-flash → default 组 → 商汤渠道（priority 88）实测通、无 429 |

## 说明
- 根因：`chat_room_topic_agents` 表由 reconcile 从配置回写，直接改表无效；`options.ChatRoomTopicAgents` 该部署 binary 加载有怪癖不生效；最终改硬编码默认值+重建才稳定生效
- 任务 agent（qwen3.8-max/阿里 token-plan）中途 5 小时配额耗尽退出（03:27 UTC 重置），不影响部署结果

## 回滚
恢复 `/opt/xxsx-api/bin/new-api` 的部署前备份（/data/xxsx-api/server-backups/ 惯例）+ `systemctl restart xxsx-api-mi.service`
