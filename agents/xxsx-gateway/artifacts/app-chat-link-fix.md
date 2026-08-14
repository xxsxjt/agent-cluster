# APP 对话记录仍空白——端到端复查与修复（app-chat-link-fix）

**时间**: 2026-08-12 13:45-14:00
**智能体**: xxsx-gateway（task: app-chat-link-fix）
**渠道**: aliyun-tokenplan / deepseek-v4-flash

## 背景
用户 2026-08-11 21:2x 报告：app-fixes-b 已部署 twin history 代理（实测 500 条）+ 发布 v1.7.16/0.6.6，但用户 APP 对话记录仍空白。可能：①未更新版本 ②链路仍有断点。

## 端到端排查结论

### ✅ 版本确认（排除①）
- 管理端线上：**v1.7.18（versionCode 52）**（比 B 步的 1.7.16 更新，app-notify-detail-fix 后又发过版）——`/opt/xxsx-api/releases/xxsx-admin.apk.json`
- 用户端线上：**v0.6.6（versionCode 12）**——`https://api.xxssxx.top/downloads/xxsx-api-android.json` 一致
- 用户设备 id=108（「我的手机」）未吊销、未过期 → 版本链路无问题，**不是版本问题**

### 🔴 根因（断点定位）
HK new-api 的 `AssistantTwinEndpoint` **仍指向 sshd 反向隧道 `http://127.0.0.1:28787`**——该隧道已死（HK 侧 curl HTTP:000 FAIL）。
- HK 配置（options 表）：`AssistantTwinEndpoint=http://127.0.0.1:28787`（app-fixes-b 时隧道活着，后来 sshd 隧道进程消失/未重建）
- 实测 HK→本机三条通道：
  - ❌ `127.0.0.1:28787`（sshd 反向隧道）→ **HTTP:000 死**
  - ✅ `100.103.204.86:8787`（Tailscale 直连，**Tailscale 已恢复**，pong 18ms）→ HTTP 200
  - ✅ `https://remote.xxssxx.top`（cloudflared）→ HTTP 200
- 断点表现：`GET /api/admin/assistant/conversations/18/messages` → `{"data":[]}`（代理读死隧道拿不到本机历史）

### ✅ 本机侧（无问题）
- web server 8787 活着（PID 60232，0.0.0.0:8787 LISTENING）
- `/api/chat/twin/history` → HTTP 200，11636 行（209KB），持续在写（13:48 更新）

## 修复
1. **改 HK options 表**：`AssistantTwinEndpoint` → `http://100.103.204.86:8787`（Tailscale 直连，本机 Tailscale 已恢复；DB 改前已备份到 HK `/tmp/xxsx-new-api.db.bak-twinfix`）
2. **重启 xxsx-api-mi**（new-api 有 options 内存缓存，必须重启才生效；systemd Restart=always 自动恢复，中断约 30s）
3. 重启后：服务 active、new-api 新 PID 2624739、/api/status 200、/v1/chat/completions 401（鉴权正常）

## 验证（修复后 E2E）
- `GET /api/admin/assistant/conversations?kind=twin` → twin 会话 id=18「虚无圣灵（分身）」存在 ✅
- `GET /api/admin/assistant/conversations/18/messages` → **500 条本机历史（217994B）**，含最新对话（修复前为 `data:[]`）✅
- 本机 history.jsonl 持续更新（11636 行）✅

**链路现在完整**：APP → HK mobile（设备 token）→ `/api/admin/assistant/conversations/18/messages` → HK new-api fetchClusterTwinHistory → Tailscale 直连本机 8787 `/api/chat/twin/history` → 返回历史。

## 遗留 / 备注
- **Tailscale 已恢复**（此前 daemon 卡 NeedsLogin 是过期状态；现在 ping HK 18ms 正常）——HK 经 Tailscale 直连本机是当前主通道，无需 sshd 隧道
- **备份通道**：cloudflared `remote.xxssxx.top` 仍通（备选）；若 Tailscale 再挂，把 options `AssistantTwinEndpoint` 改为 `https://remote.xxssxx.top` 并重启 xxsx-api-mi 即可（一条 SQL + 一个 systemctl restart）
- 发送链路（POST messages）未测（会真实打扰 twin-daemon），B 步已验证过
- 用户需在 APP 里确认已升级到 v1.7.18；若仍空白，让用户重进对话页（或重登）刷新