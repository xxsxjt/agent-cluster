# APP 修复 B 步（对话记录空白 + 切换智能体弹窗重做 + 遗留UI）

**时间**: 2026-08-11 11:2x
**智能体**: xxsx-gateway（task: app-fixes-b-20260811）
**渠道**: aliyun-tokenplan

## STEP 0 — 现状调查（2026-08-11 11:2x）
### 对话记录空白根因（已定位）
- 链路：APP → HK assistant(kind=twin) → 代理读本机 twin history（web/server.js /api/chat/twin/history，本机 8787）
- **断点①（代码回归）**：当前 HK 二进制由 `upstream/new-api-main` 重建（A步 STEP6），该源**不含 twin 代理读取逻辑**（`agents/xxsx-gateway/work/*.go` 的 twin 代理从未同步进 upstream）。实测 HK `GET /api/admin/assistant/conversations/{twin}/messages` 返回 `{"data":[]}`（HK DB 空，不代理本机）。
- **断点②（连通性）**：本机 Tailscale 挂（daemon 卡 NoState），HK ping 100.103.204.86 100% 丢失 → HK 无法经 Tailscale 达本机 8787。
- 本机 web server 8787 正常（PID 55036，HTTP 200，`/api/chat/twin/history` 返回 5961 行历史）。
- HK 配置：`AssistantTwinEndpoint=http://100.103.204.86:8787`、`AssistantTwinToken=626e36c4...`、Enabled=true。
## STEP 1 — 后端修复（进行中）
- 在 `controller/admin_assistant_cluster_chat.go` 加 `fetchClusterTwinHistory()` + `isTwinClusterConversation()`（代理读本机 /api/chat/twin/history）
- 在 `controller/admin_assistant_chat.go::GetAdminAssistantConversationMessages` 对 twin 会话走代理
- 重建 HK 二进制 → 经 US-hop SSH 部署 → 重启服务

### STEP 1 — 后端修复完成 ✅（2026-08-11 13:5x）
- [x] `controller/admin_assistant_cluster_chat.go` 加 `twinHistoryEndpoint()` + `fetchClusterTwinHistory()` + `isTwinClusterConversation()`（代理读本机 /api/chat/twin/history，x-pi-token 鉴权，8s 超时）
- [x] `controller/admin_assistant_chat.go::GetAdminAssistantConversationMessages` 对 twin 会话走代理（读本机为准，不落 HK 复制）
- [x] gofmt + `go build ./controller/` 通过
- [x] 交叉编译 linux 二进制 `pi_workspace/output/new-api-appfixb-20260811`（sha `746540506c...`，140MB，static）
- [x] 经 US-hop SSH 部署 HK：备份 `appfixb-*` → 停服 → 换 bin/new-api → 重启 → HEALTH 200 ✅
- [x] **连通性**：本机 Tailscale 挂（daemon 卡 NoState），但 HK 已有 sshd 反向隧道 `127.0.0.1:28787 → 本机 8787`（AssistantTwinEndpoint 已指向它，实测返回本机历史）→ 无需改配置
- [x] **E2E 验证**：`GET /api/admin/assistant/conversations/18/messages`（agent=twin）→ **500 条本机历史**（437 assistant + 63 user，负 id 确认代理生效）—— A 步时是空 `[]`，现已修复 ✅
- [ ] 遗留：本机 Tailscale 未恢复（THE 基础设施问题，需单独修）；cloudflared 隧道 remote.xxssxx.top 也在跑（备选路径）

## STEP 2-4 — Android UI（2026-08-11 14:0x）
- [x] **切换智能体弹窗 Material 重做**：`MaterialSelectionDialog.kt`（圆角浮动卡片/ripple/brand 色/深浅自适应 DayNight），AssistantFragment `showAgentSelector` 分组展示。dex 含 `MaterialSelectionDialog` + `选择对话智能体` ✅
- [x] **集群文档按钮位置**：从顶部 header 行移入「智能体集群」卡片底部（全宽按钮，逻辑归组）。dex 含 `clusterDocs` + `集群文档` ✅
- [x] **对话显示修正**：`displayAgentSource` → twin 显示「虚无圣灵 · 实时活动」（真实对接本机 twin-daemon 实时巡查/对话/决策流，不误导）。dex 含 `实时活动` ✅

## STEP 5 — 构建发布 ✅（2026-08-11 14:0x）
- 管理端 **v1.7.16（versionCode 50）**：`output/xxsx-admin-1.7.16.apk` sha `6a24798482920cfc9639c91b557120a4bc769f5b5405162cc99b10679d63e065`（6554899B）
- 用户端 **v0.6.6（versionCode 12）**：`output/xxsx-user-0.6.6.apk` sha `b13a28fdf00fa82b062cd8e7d89f6b2148504a987d1bc8731db6293e8ef66a7c`（8258732B）
- 发布 HK（经 US-hop SSH，gzip 压缩传输避免截断）：
  - 管理端 `/opt/xxsx-api/releases/xxsx-admin.apk` + `.json`（50/1.7.16）→ `GET /api/mobile/admin/app-release` **200 `{available:true, version_code:50, version_name:"1.7.16", sha256:6a247984…}`** ✅；`/download` sha 一致 ✅
  - 用户端 `/opt/xxsx-api/releases/xxsx-user.apk` + `.json`（12/0.6.6）→ nginx `https://api.xxssxx.top/downloads/xxsx-api-android.json` **12/0.6.6** ✅；下载 sha 一致 ✅
- 临时验证 token（bstep-verify）已吊销；仅保留用户「我的手机」id=108。
- 用户已装 1.7.15(49)/0.6.5(11) → 管理端 50>49、用户端 12>11 均触发更新。

## 遗留 / 备注
- **本机 Tailscale 未恢复**（daemon 卡 NeedsLogin/WantRunning=false，`tailscale up --reset` 无效）——基础设施问题，需单独修复。当前 twin 历史走两条既有连通路径正常：HK sshd 反向隧道 `127.0.0.1:28787→本机 8787`（AssistantTwinEndpoint 已指向）+ cloudflared `remote.xxssxx.top`。
- 后端二进制 `<AssistantTwinEndpoint>` 原为 `http://127.0.0.1:28787`（A步后已改，非 8/9 记录的 100.103.204.86），无需改。
