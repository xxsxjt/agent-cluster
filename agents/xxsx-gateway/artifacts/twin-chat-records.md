# 任务：APP 对话记录对接本机分身（twin-chat-records）

> 日期：2026-08-09 · 执行：xxsx-gateway · 状态：完成（E2E 全链路验证通过）

## 背景
用户（2026-08-09 13:3x）：管理端打开助手显示的是「服务器上的智能体测试对话记录」，APP **应显示本机分身（虚无圣灵）的对话记录**（与电脑控制台一致）。

根因：HK new-api admin assistant 的「助手」tab 默认 `kind=manual`（读 HK `admin_assistant_conversations` 表 = Hermes 测试记录）；twin 会话记录没有从本机拉取。

## 改动总览（全部在 HK `/opt/xxsx-api`，生产服务 `xxsx-api-mi`）
| 文件 | 改动 |
|---|---|
| `upstream/new-api-main/controller/admin_assistant_chat.go` | twin 代理读取（列表/消息）+ 发送路由 sentinel + 去掉 HK 侧复制 |
| `upstream/new-api-main/service/adminassistant/service.go` | 修 BuildTwinReply 读取截断 bug（1200→4MB） |
| `web/default/src/features/admin-assistant/api.ts` | `AssistantConversation.kind` 增加 `twin`；`listAssistantConversations` 支持 twin |
| `web/default/src/features/admin-assistant/conversation-panel.tsx` | 增加 twin 面板（标题「虚无圣灵（分身）」、隐藏新建/删除/应用动作开关） |
| `web/default/src/features/admin-assistant/index.tsx` | 「助手」tab 默认=twin（分身）；新增「管理对话」(Hermes/manual) tab 保留原功能 |

## 核心设计：代理读取（APP→HK→本机实时读）
- **不复制不同步**：分身对话是"活的"，HK 不落 twin 会话副本；列表/消息**实时代理读本机** org web。
- 虚拟会话哨兵：`twinVirtualConversationID = -1000`（不入 HK DB，不对应任何真实记录）。
- 后端 `fetchTwinHistory()`：`GET <AssistantTwinEndpoint>/api/chat/twin/history`（`x-pi-token=AssistantTwinToken`），与发送链路 `/api/cluster/chat` 共用同一 Endpoint/Token 配置。
- 发送：`POST .../conversations/-1000/messages` → 命中 sentinel → `handleTwinAssistantMessage` → `BuildTwinReply` → 本机 `/api/cluster/chat` → twin-daemon（脱敏人格）→ 回复 + **写本机 `agents/twin/chat/history.jsonl`**。HK 侧不再 `AppendAdminAssistantMessage`（避免复制）。

## 前后端行为
- **本机无记录时**：仍返回分身虚拟会话（空消息），面板显示"这是本机分身（虚无圣灵）的对话记录…"可发首条消息；**绝不回退到 HK 测试记录**。
- **Hermes 模式**：`kind=manual` 保持原样读 HK 表；前端新增「管理对话」tab 可切换查看（原"助手"内容搬至此）。

## 部署
- 前端：`web/default` 用 rsbuild 重建 dist（HK 无 bun，走 `pnpm run build`）。
- 后端：`CGO_ENABLED=1 go build -ldflags "-s -w" -o /opt/xxsx-api/bin/new-api.new .`（go:embed 新 dist）。
- `deploy-hk.sh`（自动备份当前 bin/new-api → server-backups + 停启服务）。本次备份：`new-api.bak.cluster-chat-20260809-133032` / `-133636` / `-133911` + `new-api.new.bak.pretwin-20260809`。

## 验证（HK 本地 curl，Bearer 管理 token + `New-Api-User:1`）
1. `GET /api/admin/assistant/conversations?kind=twin` → `{"data":[{"id":-1000,"title":"虚无圣灵（分身）","kind":"twin",...}]}` ✅
2. `GET /api/admin/assistant/conversations/-1000/messages` → 返回本机 twin history（含今日对话）✅
3. `GET ...?kind=manual` → 8 条 Hermes（manual）会话保留 ✅
4. `POST /api/admin/assistant/conversations/-1000/messages {"message":"..."}` → 分身回复"这条就是从管理端助手发过来的，我（分身）完整接到了" + 本机 history.jsonl 新增 user/assistant ✅

## 踩坑
- `BuildTwinReply` 原 `io.LimitReader(resp.Body, 1200)`：本机 `/api/cluster/chat` 回复带 attachments 元数据 >1200 字节 → JSON 截断 → 解析失败 → 错误回显为"分身回复解析失败"。修复：读取上限提升到 4MB。
- `.bin/rsbuild` 是 shell 包装，`node node_modules/.bin/rsbuild` 会报 SyntaxError；改用 `pnpm run build`。
- 该 fork 鉴权：`Authorization: Bearer <access_token>` **且** `New-Api-User: <user_id>` 必须同时提供（两者要匹配）。
- write 工具写 `/tmp/x` 落在 `C:\tmp` 而非 git-bash 的 `/tmp`；脚本统一用 bash heredoc 写入真实路径再 scp。

## 隐私
- 代理读取的是本机 twin history（**脱敏人格 user-twin**，不含微信原始数据），HK 侧不落 twin 对话副本。符合隐私铁律。

## 遗留 / 备注
- 本机 twin-daemon 当前为手动拉起（PID 26028）；正常由 bootstrap 自启。若停止需按 bootstrap 方式拉起。
- 前端「助手（分身）」为默认 tab；「管理对话」=Hermes 原记录。
