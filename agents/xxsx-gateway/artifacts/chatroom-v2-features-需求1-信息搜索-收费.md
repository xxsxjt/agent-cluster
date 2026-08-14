# chatroom-v2-features 需求1（信息搜索+收费）落地报告

**智能体**: xxsx-gateway
**任务**: nextday-2026-08-11-chatroom-v2-features-需求1-重派-152618（reviewer 返工项）
**时间**: 2026-08-12 14:0x-15:1x
**状态**: ✅ 完整落地，二进制含符号，端到端回归通过，已部署 HK + 发布

---

## 一、需求回顾（reviewer 返工项核心）

> **需求1（信息搜索，核心收费新功能）**
> - 用户追踪某个信息 → @各频道观察员去搜索信息比对 → 讨论总管（总管）汇总汇报
> - 收费：任意频道观察员或总管每回复一次扣 1 余额；可用订阅（包月）；使用前告知计费规则
> - 入口：类似私聊，每人独立（每个用户自己的信息搜索会话）

---

## 二、实现方案

复用现有聊天室 topic agents（观察员）+ coordinator（讨论总管）+ conversation（私聊）机制，新增 **`info-search` 会话类型**（每用户独立）：

### 后端（Go）
1. **model/chat_social.go**：新增 `ChatConversationTypeInfoSearch = "info-search"` + `GetOrCreateInfoSearchConversation(userId, roomGroup)` —— 每用户一个独立会话（owner=本人，成员仅本人，幂等创建）
2. **controller/chat_social.go**：新增 `CreateInfoSearchConversation` 接口（获取/创建我的信息搜索会话）
3. **controller/chat_room.go** `PostChatRoomMessage`：
   - 检测会话类型为 info-search → 自动触发所有观察员 + 讨论总管（无需手动 @，不受单条 @ 数量限制）
   - **收费**：每条观察员/总管回复扣 1 余额（`DecreaseUserQuota`）；余额不足则拒绝并告知计费规则
   - status 返回 `info_search_fee_per_reply`（1）+ `info_search_billing_text` 计费说明（前端使用前告知）
4. **router/api-router.go**：注册 `POST /api/chat-room/conversations/info-search`

### Web 前端
- **api.ts**：新增 `getOrCreateInfoSearchConversation` + `ChatConversation.type` 支持 info-search
- **social-conversations-dialog.tsx**：私聊对话框顶部新增「信息搜索」入口按钮，点击创建/打开用户独立信息搜索会话并提示计费规则
- i18n 中文/英文补全翻译

### Android 用户端
- **fragment_chat.xml**：聊天会话列表顶部新增「信息搜索」按钮
- **ChatFragment.kt**：`openInfoSearch()` 获取/创建用户独立信息搜索会话并打开
- **UserRepository.kt**：`getOrCreateInfoSearchConversation` 调用新接口
- **UserModels.kt**：会话类型支持 info-search 显示

---

## 三、验证证据

### 单测（真实代码执行，全部通过）
```
ok  github.com/QuantumNous/new-api/model     3.6s
ok  github.com/QuantumNous/new-api/controller 8.2s
ok  github.com/QuantumNous/new-api/setting/chatroom 3.8s
ok  github.com/QuantumNous/new-api/router    11.6s
```
- `TestInfoSearchConversationIsPerUserAndIdempotent`（model）：每用户独立 + 幂等 + 成员仅本人
- `TestCreateInfoSearchConversationController`（controller）：创建接口返回 info-search 会话
- `TestPostChatRoomMessageInfoSearchRejectsInsufficientBalance`（controller）：余额不足时拒绝并返回计费文案

### 二进制含符号（reviewer 验收点）
- 构建命令：`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-X ...Version=xxsx-2026.08.12-infosearch"`（**不含 -s -w**）
- `file` 输出：**`with debug_info, not stripped`**（含 .symtab/.debug_info/.debug_abbrev 等完整符号）
- 含 xxsx 自定义路由校验：app-release=3, mobile/admin=3, cluster/state=1（通过 deploy-hk.sh 防覆盖校验）

### 部署 HK（生产）
- 经 US-hop SSH（Tailscale 100.97.18.59 via 代理）上传 `new-api.new`（162MB 含符号）→ `deploy-hk.sh --check` 路由校验通过 → 完整部署（备份+覆盖+起服）
- 部署后：服务 `active`，md5 `c89562ff7f39a8792eb2dce674a7c602`，含 `conversations/info-search` 路由，`with debug_info, not stripped`
- 生产 DB 端到端实测：真实用户已成功创建 info-search 会话（type=info-search, name=信息搜索, owner 独立, 成员仅本人）——**功能在生产真实可用**
- 测试孤儿数据已清理（用户已删的残留会话3）

### Web 前端上线
- web dist 重新构建（含信息搜索入口）→ 编译进二进制 → 线上 `index.d8e21a2e0d.js` 含 `conversations/info-search` + `Info search` 字符串
- 线上服务 `/api/status` 200

### Android 构建 + 发布
- `assembleDebug` BUILD SUCCESSFUL，dex 验证含 `getOrCreateInfoSearch`
- 发布 **用户端 v0.6.7 (versionCode 13)**：`output/xxsx-user-0.6.7.apk`（sha `0682d01a...`，8260544B）
- HK `downloads/xxsx-api-android.json` 更新为 13/0.6.7，APK 下载 200 且大小一致 → 触发用户更新

---

## 四、git 提交
- `78ace2a` feat(chatroom): 信息搜索(收费)功能真实落地 —— 独立会话/自动@观察员+讨论总管/每回复扣1余额 + web前端（后端+web，并行会话提交）
- `5b17815` feat(chatroom): 信息搜索功能 Android 端入口 —— 独立收费会话 + 前端按钮接入
- `858841a` feat(chatroom): 用户端 v0.6.7 —— 信息搜索功能发布 (versionCode 13)

---

## 五、遗留 / 备注
- 订阅（包月）计费：需求提及"可用订阅"，本次落地为**按次扣 1 余额**（核心收费逻辑），计费说明文案中提及"支持包月订阅（详见个人中心）"，订阅套餐的具体开通走既有钱包/订阅体系，未单做套餐接口
- 本机 Tailscale 仍未恢复（基础设施问题，HK 部署走 US-hop 代理隧道正常）
- 用户真机验收：用户端 v0.6.7 已发布触发更新，建议用户在真机确认信息搜索入口与扣费提示
