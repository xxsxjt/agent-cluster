# 聊天室调用失败 bug 修复：频道回复不能直接嵌入系统 Bot 提及

## 背景
用户 2026-08-11 13:52 截图确认：聊天室频道回复报错 **"调用失败：频道回复不能直接嵌入系统 Bot 提及"**。
@toutiao-ai 等观察员（topic agent）回复时，模型在 content 正文里写了 @系统Bot 提及，被硬校验拒绝，导致整条回复失败。

## 源码定位
- 文件：`upstream/new-api-main/controller/chat_room_topic_agent.go`
- 校验函数：`validateChatRoomAgentText`（约 634 行）
- 调用链：`callChatRoomTopicAgentReply` / `decideChatRoomHourlyTopic` / `decideChatRoomVisit` 三处都走 `validateChatRoomAgentText`。

## 根因分析
**设计如此，但过于刚性 = bug**。
- 设计意图：观察员回复应通过 JSON 的 `target_bot` 字段指定目标 bot，由代码在末尾追加 `\n@target`，正文里不该写 @。
- 原逻辑：`validateChatRoomAgentText` 扫描正文，若命中已知系统 Bot 的 @提及（`chatRoomModelMentions` + `chatRoomTopicAgentByHandle`），**直接返回错误** `%s不能直接嵌入系统 Bot 提及`。
- 实际问题：模型偶尔会在正文里 @（例如复述触发消息里的 @toutiao-ai，或自发 @ 其他观察员），于是整条回复被打挂——用户看到的"调用失败"。

## 修复方案
**把"拒绝"改为"剥离"**：正文里命中系统 Bot 的 @提及被自动移除，其余文本原样保留；系统 Bot 提及功能仍由 `target_bot` 字段 + 末尾追加 `\n@target` 表达，**原机制不受影响**。

改动的两个函数（`chat_room_topic_agent.go`）：
1. `validateChatRoomAgentText`：先 `stripChatRoomSystemBotMentions(value, agents)` 再校验空/长度，不再拒绝。
2. 新增 `stripChatRoomSystemBotMentions`：按 `chatRoomModelMentions` 相同的扫描规则（@ 前需为边界字符），仅剥离命中 `chatRoomTopicAgentByHandle` 的提及；普通 @文本、email（a@b.com）等原样保留。

**原逻辑备份**（改动前）：
```go
func validateChatRoomAgentText(value string, field string, maximum int, agents []model.ChatRoomTopicAgent) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("%s不能为空", field)
	}
	if utf8.RuneCountInString(value) > maximum {
		return "", fmt.Errorf("%s超过长度限制", field)
	}
	known := chatRoomTopicAgentByHandle(agents)
	for _, mention := range chatRoomModelMentions(value) {
		if _, exists := known[strings.ToLower(mention)]; exists {
			return "", fmt.Errorf("%s不能直接嵌入系统 Bot 提及", field)
		}
	}
	return value, nil
}
```

## 验证
新增单元测试 `TestValidateChatRoomAgentTextStripsSystemBotMentions`（`chat_room_topic_agent_test.go`），8 个子场景全过：
- 正文带 @系统Bot → 剥离，保留正文
- 仅 @系统Bot → 剥离后为空 → 报"不能为空"（防御，避免发空消息）
- @系统Bot 加实质内容 → 剥离 @，保留正文
- @系统Bot 在句首 → 剥离
- 多个 @系统Bot → 全剥离
- @普通词 / email / 无提及 → 原样保留

结果：
- `go build ./controller/` ✅ 编译通过
- `go test ./controller/` ✅ 全量通过（在原未提交的 coordinator 开发改动之上，无回归）

## 部署（待用户确认时机）
部署需重启 HK 上的 `xxsx-api-mi` 服务约几十秒，会**短暂中断用户正在使用的聊天室**，故按用户要求"先说明再动"未擅自执行。

1. 二进制已构建（本机交叉编译 linux/amd64，CGO_ENABLED=0）：
   `C:\Users\du_ji\pi_workspace\output\new-api-mentionfix-20260811`
   （版本 `v0.0.0-xxsx.mentionfix.1-20260811`，sha256 待算）
2. 参照既有部署脚本 `engagements/release-20260811-appfixb/deploy-appfixb.py` 流程：
   - 经 US hop（103.119.14.102:45384）隧道到 HK（100.97.18.59:43891）
   - 上传 `new-api-mentionfix-20260811` → `/opt/xxsx-api/bin/new-api.next`
   - `systemctl stop xxsx-api-mi` → 备份旧二进制 → 替换 → `systemctl start xxsx-api-mi`
   - 健康检查 `curl http://127.0.0.1:3461/api/status` 等 200
   - 失败自动回滚旧二进制

用户确认时机后即可执行部署并在聊天室实测 @观察员回复不再报错。