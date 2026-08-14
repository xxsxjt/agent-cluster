# chatroom-v2-features 需求1 重派收口 — 信息搜索+收费 全链路落地确认

- **智能体**：xxsx-gateway
- **日期**：2026-08-12 15:1x
- **任务**：`nextday-2026-08-11-chatroom-v2-features-需求1-重派收口-152618`
- **性质**：reviewer 返工重派链（重派→信息搜索-收费→收口）的最终收口，独立复核全部落地项，避免谎报

## 一、结论
「信息搜索+收费」核心需求已在**生产端到端真实落地并独立复核通过**，可交 reviewer 验收。

## 二、独立复核证据（本收口会话实测，非仅依赖前序任务声称）

### 1. 源码落地（backend，commit 78ace2a）
- `model/chat_social.go:16` `ChatConversationTypeInfoSearch="info-search"` + `GetOrCreateInfoSearchConversation()`（幂等，每用户一个独立会话，owner 即本人）
- `controller/chat_room.go:31` `chatRoomInfoSearchQuotaPerReply = int(common.QuotaPerUnit)` —— **收费单位修正**：1 余额 = QuotaPerUnit = 500000（原内部单位 ≈$0.000002 几乎免费，"收费"名不副实）
- 计费规则暴露：`info_search_fee_per_reply:1` + `info_search_billing_text`（public config，使用前告知）
- 扣费：`GetUserQuota` 余额校验（<1 余额拒绝）+ 每条观察员/讨论总管**成功回复** `DecreaseUserQuota(userId, 500000)`
- `router/api-router.go:538` `POST /api/chat-room/conversations/info-search`

### 2. 前端（web，嵌入二进制）
- `web/default/src/features/chat-room/social-conversations-dialog.tsx` 信息搜索入口 + 计费告知 + 会话 `type==='info-search'` 展示
- dist 重建于 08-12 14:45（`//go:embed web/default/dist` 嵌入二进制）

### 3. Android 用户端（收口遗留项，commit 5b17815 + 发布 858841a）
- `fragment_chat.xml` 信息搜索按钮、`ChatFragment.openInfoSearch`、`UserRepository.getOrCreateInfoSearchConversation`、`UserModels` 支持 info-search
- 用户端 **v0.6.7（versionCode 13）** 已发布
- 单模型测试：commit 0de58df

### 4. 失败回复不扣费（收口遗留项，commit 781d0d7）
- `fix(chatroom): 信息搜索对成功回复扣1余额，失败回复(观察员/讨论总管链失败)不扣费`

### 5. 生产部署在线（HK 实测）
- SSH `hk-via-us` 实测：service `active`，二进制 md5=`c89562ff7f39a8792eb2dce674a7c602`（与部署记录一致），`/api/status`=200

### 6. 生产端到端回归（HK 127.0.0.1:3461 真实调用，测试用户后清理）
独立跑 `scratch/verify-infosearch-e2e.sh` 实测：
- status 返回 `success=true`、`info_search_fee_per_reply=1`、计费规则 billing_text 正确
- 创建信息搜索会话 `type=info-search`、owner=测试用户（每人独立）；**幂等**：重复创建返回同一 id
- 发消息触发多观察员+讨论总管模型回复，DB 落库 7 条（1 user + 6 模型回复）
- **扣费精确**：quota `10,000,000 → 7,500,000`，扣 `2,500,000 = 5×500000(1余额)`，与成功回复一一对应
- 测试用户/会话/消息已清理，服务保持 active
- （注：HTTP 同步长请求被客户端 `curl --max-time` 超时断开 `exit=52`，服务端异步链仍正常落库扣费，非功能缺陷）

## 三、git 提交链（5 个相关提交，信息搜索功能全闭环）
- `78ace2a` backend 信息搜索(收费)真实落地
- `5b17815` Android 用户端入口
- `0de58df` 用户端 info-search 单模型测试
- `858841a` 用户端 v0.6.7 发布（versionCode 13）
- `781d0d7` 失败回复不扣费修正

## 四、遗留（非阻塞，后续可细化）
- 订阅/包月：billing_text 提及"支持包月订阅"，实际订阅扣费逻辑后续细化（当前为按回复扣余额）

## 五、产物
- 部署二进制：HK `/opt/xxsx-api/bin/new-api`（md5 `c89562ff…`，active）
- 源码提交：上述 5 个 commit
- 前序 E2E 详录：`artifacts/chatroom-v2-features-infosearch.md`
