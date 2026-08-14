# 集群文档改为「对话内附件」报告（2026-08-08 · 任务 chat-attachments）

> 用户 2026-08-08 21:2x 批评：集群文档功能位置不对——不应是"服务器页一个按钮"，而应**由智能体发在对话界面**（助手对话中心里回复附带文件卡片，点击下载），像微信/钉钉里 AI 发文件卡片。本任务完成端到端改造并发布 v1.7.11。

## 一、现状勘查（大部分代码已由 cluster-assistant-hub 铺垫，本任务补齐断点）

- **org 侧 `/api/cluster/chat` 已实现附件**：`clusterChatAttachments()` 从 agents/*/artifacts + knowledge 取最近文档，回复时把 `attachments:[{name,path,size,sizeText,kind,url}]` 带上；url 走既有 `/api/cluster/docs/content` 下载接口。✅（实测返回 3 篇附件）
- **APP AssistantFragment 已实现文件卡片**：`buildAttachmentCard()`（文件名/大小/类型图标）、`downloadAttachment()`（下载到 cacheDir/cluster-docs）、`openAttachmentFile()`（FileProvider + 系统查看器 / TextDetailsSheet 兜底）；`renderMessages` 与 stream `assistant_message` 事件都渲染 `attachments`。✅
- **HK 后端 cluster chat 已实现**：`callClusterTwinChat()` 解析 org 返回的 attachments，complete/stream 处理器把附件存入 `metadata.attachments`。

## 二、关键断点修复（本任务核心）

1. **HK 部署 binary 缺少 Model.MarshalJSON（附件没暴露到顶层）**
   - 断点：APP 读取**顶层** `message.attachments`，但旧部署 binary 把附件存在 `metadata.attachments`（无顶层输出）→ APP 不显示卡片。
   - 修复：`model/admin_assistant_chat.go` 新增 `AdminAssistantMessage.MarshalJSON()`，序列化时把 metadata 里的 attachments 提升为顶层 `attachments` 字段（列表接口 + 流式事件自动带）。重新交叉编译 Linux binary（GOOS=linux CGO_ENABLED=0 go build）→ scp 到 HK `/opt/xxsx-api/bin/new-api.new` → 执行既有 `deploy-hk.sh`（备份 + fuser 检查 + 重建 inode）→ 服务 active。

2. **HK 集群文档代理指向错误 endpoint（下载 404）**
   - 断点：`MobileAlertClusterEndpoint=http://100.97.18.59:8788`（HK 自身错误端口，000 不可达），导致 `/api/mobile/admin/cluster/docs/content` 代理 404。
   - 修复：改为 `http://100.103.204.86:8787/api/cluster/health`（本机 org，与 AssistantTwinEndpoint 一致，HK 可经 Tailscale 直达）→ 重启服务 → 下载 200。

3. **测试设备 user_id 用错（RoleRootUser=100 不是 1）**
   - 排查中发现移动令牌验证要求 `users.role=100`（RoleRootUser），真实手机设备挂 user_id=1("x",role=100)。调试过程先用了 user_id=2(role=1) 被拒，改用 user_id=1 后令牌生效。测试令牌随后已吊销。

## 三、端到端验证（全过）

- **org `/api/cluster/chat`**：返回 `attachments` 数组（3 篇，kind=md，url 走 /api/cluster/docs/content）✅
- **HK twin 对话 stream**（会话 34）：`assistant_message` 事件同时含 `metadata.attachments` **和顶层 `attachments`**（MarshalJSON 生效）✅
- **智能体引导**：回复自动引用任务报告文档（"把 console-interject 任务的报告文档附上来" → 回复带 console-interject.md 等 3 篇）✅
- **下载代理**：`/api/mobile/admin/cluster/docs/content?path=...` 经 HK 代理到 org 返回 200 ✅
- **APP 构建**：`compileDebugKotlin` + `assembleDebug` 通过；dex 含附件代码（20 处匹配 renderAttachments/buildAttachmentCard/cluster-docs）✅

## 四、发布（45/1.7.11，验证全过）

- 版本 44→**45 / 1.7.11**（含附件 + 对话中心 + UI 重构）
- 构建 debug 自签名 APK（sha `221e136039cd9290a2a87141247f6cfb4004eeca3d7cd8fd1e9acb8ad0b56ee1`），旧版备份 `/opt/xxsx-api/backups/android-release-v4-20260808-215105/`
- 更新检查返回 45/1.7.11，下载 sha 与本机一致 ✅
- **SMTP 邮件已发** 640373758@qq.com（`MAIL_SENT_OK`），更新说明首条即"集群文档改为对话内附件"

## 五、清理

- 测试移动令牌（chat-att-test1/2/3/4、release-verify）全部吊销；用户真实设备"我的手机"(id 4) 不受影响
- 临时脚本/binary 已清理

## 六、边界/说明

- 附件仅来自 org agents/*/artifacts 与 knowledge 下的 .md（非敏感，隐私铁律）；其他类型（pdf/docx/apk）kind 已预留但下载白名单当前仅 .md（`/api/cluster/docs/content` 校验）
- 服务器页无独立"集群文档"按钮（v1.7.9 的入口已由对话内附件取代，符合用户"不应该是按钮"的要求）
- 仍为 debug 自签名 APK（无 release keystore，沿用历史发布方式）
