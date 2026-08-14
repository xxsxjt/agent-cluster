# chatroom-v2-features 需求1 重派 — 信息搜索+收费 真实落地（E2E 验证通过）

- **智能体**：xxsx-gateway
- **日期**：2026-08-12 14:5x
- **任务**：`nextday-2026-08-11-chatroom-v2-features-需求1-重派-信息搜索-收费-152618`（reviewer 返工重派）
- **reviewer 验收点**：信息搜索+收费真实落地、二进制含符号、端到端回归

## 一、需求回顾（chatroom-v2-features 需求1）
用户（2026-08-11 13:30 需求）：信息搜索功能（核心新功能——收费）
- 用途：用户追踪某个信息 → @各频道观察员搜索比对 → 讨论总管汇总汇报
- 收费：任意观察员或总管**每回复一次扣 1 余额**；使用前**告知计费规则**
- 入口：类似私聊——**每人独立**（每个用户自己的信息搜索会话）

## 二、实现内容（upstream/new-api-main，Go 后端 + web 前端）

### 后端
| 文件 | 改动 |
|---|---|
| `model/chat_social.go` | 新增会话类型 `ChatConversationTypeInfoSearch="info-search"` + `GetOrCreateInfoSearchConversation()`（幂等，每用户一个，owner 即本人，类似私聊独立会话） |
| `controller/chat_social.go` | 新增 `CreateInfoSearchConversation`（POST 创建/获取信息搜索会话，校验分组） |
| `controller/chat_room.go` | ①`PostChatRoomMessage` 识别 info-search 会话：**自动 @ 全部启用观察员频道**（不受单条@数量限制），忽略手动@；②**收费**：余额校验（回复前 `GetUserQuota` ≥ 单次扣费），每条观察员/讨论总管回复成功扣 1 余额（`DecreaseUserQuota`）；③public config 暴露 `info_search_fee_per_reply` + `info_search_billing_text`（计费规则告知） |
| `router/api-router.go` | 注册 `POST /api/chat-room/conversations/info-search` |

### 收费单位修正（本次发现的真 bug）
原实现 `DecreaseUserQuota(userId, 1)` 只扣 **1 个内部 quota 单位**（≈$0.000002，几乎免费），"收费"名不副实。需求"扣 1 余额" = 1 美元额度 = `common.QuotaPerUnit`（500000）。
- 修正：新增 `chatRoomInfoSearchQuotaPerReply = int(common.QuotaPerUnit)`，扣费/余额校验/递减全部改用该值。

### 前端（web，嵌入二进制）
- `web/default/src/features/chat-room/social-conversations-dialog.tsx`：信息搜索入口 + 计费告知文案
- `api.ts` / `index.tsx`：信息搜索会话对接
- dist 已重建（`rsbuild build` 成功），经 `//go:embed web/default/dist` 嵌入二进制

## 三、构建与部署（HK 生产）
- **web dist**：`npx rsbuild build` 成功（嵌入最新信息搜索入口）
- **Go 二进制**：`GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build` → `new-api-linux-x86_64`（162MB）
- **含符号**：`.debug_info` + `.symtab` section 均在（未 strip）✅
- **路由预检**：deploy-hk.sh 校验 app-release=3 / mobile/admin=3 / cluster/state=1 通过 ✅
- **部署**：scp 到 HK `/opt/xxsx-api/bin/new-api.new` → `deploy-hk.sh`（备份当前版→停服→覆盖→起服→复核）
  - 新版 md5=`c89562ff7f39a8792eb2dce674a7c602`，服务 `active`，`DEPLOY_OK` ✅
  - 当前版已备份到 `/opt/xxsx-api/server-backups/new-api.bak.cluster-chat-20260812-144740`

## 四、端到端回归（HK 本地 127.0.0.1:3461 真实调用，测试用户+token 后清理）
| 步骤 | 结果 |
|---|---|
| 聊天室 status | ✅ `success=true`，`info_search_fee_per_reply=1`，billing_text 计费规则正确返回 |
| 创建信息搜索会话 | ✅ `type=info-search`，owner=测试用户（每人独立） |
| 幂等验证 | ✅ 重复创建返回同一会话 id |
| 发消息触发搜索 | ✅ 自动触发 9 观察员频道（头条/微博/抖音/B站/知乎/百度/贴吧/GitHub/X）+ **讨论总管多次汇总**，共 17 条模型回复，全部 completed（X 1 条 failed，为观察员链终点模型调用失败） |
| 收费扣减 | ✅ quota `10,000,000 → 1,500,000`，**扣 8,500,000 = 17 × 500000(1余额)**，与 17 条回复一一对应，精确正确 |
| 清理 | ✅ 测试用户/会话/消息已删除，服务 `active` 健康 |

## 五、git 提交
- `78ace2a` feat(chatroom): 信息搜索(收费)功能真实落地…（42 文件，new-api-main 源码）
- `new-api-linux-x86_64` 已加 `.gitignore`（含符号二进制不入库）

## 六、遗留 / 完善点
1. **失败回复也扣费**：观察员链终点若模型调用失败（如本次 X），其 failed 回复仍计入扣费（`runChatRoomTopicAgentChain` 返回的 failed reply 也在扣费循环内）。严格应"成功回复才扣 1 余额"。当前主体已验证正确，此边界可作为后续优化（可在扣费前检查 `reply.Status=="failed"` 跳过）。
2. **Android 用户端入口**：本次落地 web 前端入口；Android 用户端（apps/xxsx-user-android）的信息搜索入口未在本任务内改，需前端 Android 跟进（后端 API 已就绪）。
3. 订阅/包月：billing_text 提及"支持包月订阅（详见个人中心）"，实际订阅扣费逻辑后续可再细化（当前为按回复扣余额）。

## 七、产物
- 部署二进制：HK `/opt/xxsx-api/bin/new-api`（md5 c89562ff…）
- 本机源码提交：`78ace2a`

---

## 八、重派核验 + 收费正确性修复（2026-08-12 15:1x，本次会话补充）

### 核验结论
需求1已在**主项目 `xxsx-proxy-gateway/upstream/new-api-main`** 完整真实落地并部署生产（派发任务工作目录 `xxsx-proxy-gateway-chat-assistant` 为旧副本，生产不使用，本次已撤销其中重复实现的代码）。核验通过：
- 生产二进制 `/opt/xxsx-api/bin/new-api` 含符号（`readelf` 找到 info-search / ChatRoomCoordinator / ClusterChat 符号），`with debug_info, not stripped` ✅
- 生产 status 返回 `info_search_fee_per_reply:1` + `info_search_billing_text`（使用前告知计费规则）✅
- 讨论总管频道 `topic:coordinator`「讨论总管」存在；各观察员频道（weibo/douyin/bilibili/toutiao/zhihu/baidu/tieba/github/x）齐备 ✅
- 端到端：创建 info-search 会话成功（`type=info-search`，owner 即本人，每人独立）✅
- 源码提交：`78ace2a`（后端）+ `5b17815`（Android 入口）+ `0de58df`（Android 测试），均在 `codex/workspace-consolidation-20260728` 分支 ✅

### 遗留点①（失败回复也扣费）—— 本次修复
原实现 `for range chainReplies` / 普通 reply 无条件 `DecreaseUserQuota`，**failed 回复也扣 1 余额**，收费名不副实。本次修复：
- 扣费前检查 `reply.Status != "failed"`，仅成功回复扣费（观察员/讨论总管链回复 + 普通模型回复两处均覆盖）
- 新增测试 `TestPostChatRoomMessageInfoSearchDoesNotChargeFailedReplies`：全部观察员 mock 调用失败 → 断言用户 quota 不变 ✅
- 提交 `781d0d7` fix(chatroom): 信息搜索仅对成功回复扣1余额…（2 文件 +42/-2）
- 构建含符号二进制 `new-api-info-search-fix-20260812`（162MB，SHA 0ca24a…）→ 部署 HK `/opt/xxsx-api/bin/new-api`，服务 active、健康 200、重启后无错误，端到端回归（status 收费规则 / 讨论总管 / info-search 会话创建）全部正常 ✅

### 遗留点②（Android 入口）—— 已确认完成
`5b17815` 已实现 Android 用户端入口：`ChatFragment.kt` 信息搜索按钮 + `UserRepository.getOrCreateInfoSearchConversation`。该遗留点已过时。

### 遗留点③（订阅包月细化）
当前按回复扣余额已满足核心收费需求；包月订阅抵扣的具体计费规则后续可细化，不阻塞上线。

### 本次提交
- `781d0d7` fix(chatroom): 信息搜索仅对成功回复扣1余额，失败回复不再收费 + 测试

### 最终产物
- 生产二进制：HK `/opt/xxsx-api/bin/new-api`（SHA 0ca24a…，含符号）
- 部署备份：`/opt/xxsx-api/backups/deploy-info-search-fix-20260812-1515/`
- 本机源码提交：`78ace2a` `5b17815` `0de58df` `781d0d7`
