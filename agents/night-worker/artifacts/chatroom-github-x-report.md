# 任务报告：服务器聊天室新增 GitHub + X（推特）频道（7 → 9）

## 结论
xxsx AI 聊天室观察员频道已从 7 个扩展到 **9 个**：新增 **GitHub 观察员**（@github-ai，topic:github）与 **X 观察员**（@x-ai，topic:x）。
新二进制（v0.0.0-xxsx.chatroom-github-x.2-20260805）已部署 HK 生产服务并验证：频道入库、数据源抓取成功、服务稳定。
部署窗口内恰逢内置免费模型池（opencode-zen 匿名上游）被账号/IP 级限流（429，**部署前已存在**，全频道受影响：23:07 抖音发言后全部 9 个频道再无发言），新频道的「AI 选题发言」步骤按 3 分钟重试机制持续尝试，限流缓解后自动补发。

## 1. 数据源选型（HK 服务器实测）

| 频道 | 主源 | 兜底 | 实测结果 |
|------|------|------|----------|
| GitHub | `api.github.com/search/repositories?q=created:>7天前&sort=stars` | 无（API 稳定） | ✓ 200，返回近 7 新星仓库（名称+描述+star+URL） |
| X | `trends24.in/`（全球趋势，服务端渲染） | `getdaytrends.com/`（Worldwide 榜） | ✓ 双源均可达；getdaytrends 曾间歇 502，故设为兜底 |

- GitHub 无 token 限流：search 10 次/分钟，每小时抓 1 次远低于限额；服务器环境变量无 GitHub token，未配置。
- x.com 官方需登录态，按任务要求**不硬闯**，改用第三方趋势追踪站（内容即 X 官方趋势数据）。

## 2. 源码改动（权威源码 WorkBuddy/xxsx-proxy-gateway/upstream/new-api-main）

- **controller/chat_room_automatic.go**
  - `fetchChatRoomHotTopicsForSource` 新增 `github` / `x` 两个 case
  - 新增 `fetchGitHubHotTopics`（GitHub search API，标题=仓库名：描述（★N），URL=仓库页）
  - 新增 `fetchXHotTopics` = `fetchXHotTopicsFromTrends24`（主）+ `fetchXHotTopicsFromGetDayTrends`（兜底），共用 `parseXHotTopics`（正则提取+HTML 实体反转义+去重，URL 指向 x.com/search）
  - `chatRoomTopicSourceURL` 新增 github/x 分支
  - 新增 import：`html`、`regexp`
- **controller/chat_room_topic_agent.go**
  - topicSource 回填 switch 增加 `github`、`x`
  - 默认 display_name/role：「GitHub 观察员」（关注开源项目、开发者工具与技术趋势…）、「X 观察员」（关注全球实时议题与突发事件…）
  - `normalizeChatRoomTopicSource` / `normalizeChatRoomScheduledTopicSource` 增加别名：推特/twitter/x推特 → x
- **setting/chatroom/setting.go**
  - 默认 `HotTopicSources` 7 → 9（尾部追加 github、x）；`TopicAgents` 同步
  - `defaultTopicAgentConfig` 新增 github/x 中文名与角色
  - `normalizeTopicAgentSource` / `normalizeTopicAgentTopicSource` 增加别名映射
- **setting/chatroom/setting_test.go**：默认频道数断言 7 → 9，新增 github/x 频道断言
- **controller/chat_room_automatic_test.go**：新增 `TestParseXHotTopics`（双源 HTML 解析+去重+实体反转义）、`TestNormalizeChatRoomTopicSourceGitHubAndX`

botHandle：github-ai / x-ai；ChannelKey：topic:github / topic:x。模型沿用默认 opencode/mimo-v2.5-free（与其他频道一致）。

完整 diff：`org/agents/night-worker/artifacts/chatroom-github-x-full.diff`（含 8/2 遗留未提交改动，本次新增为 github/x 相关 hunk）。

## 3. 测试与构建
- `go test ./setting/chatroom/` ✓、`go test ./controller/ -run 'ChatRoom|Topic'` ✓（含新增 2 个测试）
- 构建：`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags embed -ldflags "-X ...common.Version=v0.0.0-xxsx.chatroom-github-x.2-20260805"`
- 产物：`C:\_dx_serve\new-api-linux-amd64-20260805-chatroom-github-x-r2`（162MB；r1 为单源 X 版本，被 r2 取代）

## 4. 部署（HK root@100.97.18.59:43891）
- 备份：`/data/xxsx-api/server-backups/chatroom-github-x-20260805-230044/`（原二进制 140MB + 数据库）
- 上传 md5 校验一致（35011bef…）→ systemctl stop → 替换 /opt/xxsx-api/bin/new-api → start
- **踩坑：ETXTBSY**——首次替换后服务 crash-loop（node spawn 报 ETXTBSY）。排查发现一个残留 sftp-server 进程以写方式持有 bin/new-api 文件句柄。处置：kill 残留 sftp → cp 重建文件（新 inode）→ 启动成功。经验已记录：**替换二进制前先 `fuser -v` 确认无写入者；被写占用的文件要重建 inode 再启动**。
- 部署后校验：服务 active、`/api/status`（3461）200、二进制版本串确认为 r2

## 5. 运行验证
- `chat_room_topic_agents` 表 7 → **9**：
  ```
  8|github|topic:github|github-ai|GitHub 观察员
  9|x|topic:x|x-ai|X 观察员
  ```
- **抓取层验证成功**：部署后 github/x 的每小时话题抓取均无错误（r1 时 x 曾 502 → r2 双源改造后消除）；日志中 github/x 的失败仅剩「站内 AI 调用 429」，证明 fetch→候选→AI 决策链路已走到决策步。
- **AI 发言被既有限流阻塞**：HK 的 omniroute sidecar 以匿名（noauth）方式接 opencode-zen 免费端点，日志显示 `Model-only lockout for opencode-zen:mimo-v2.5-free — 429 (failureCount=140+)`、`No credentials for opencode-zen`（无备用凭据）；omniroute `provider_connections` 表为空（0 账号池），且直连 sidecar 实测 **mimo 与 deepseek-v4-flash-free 全部 429**——是上游账号/IP 级限流，非单模型问题。该限流**在部署前已存在**（23:01 旧二进制的 weibo/toutiao 日志同样 429；抖音观察员在 23:07 限流间隙成功发言一条，证明链路在间隙期可完整走通）。新频道按 3 分钟重试机制持续尝试，限流缓解后自动补发当小时话题。
- 临时尝试过把新频道模型切到 default 组健康的商汤日日新渠道（glm-5.2），但 `EnsureChatRoomTopicAgents` 每 30s 会按配置 spec 把 DB 的 model_name 覆写回默认值（持久改模型需走 ChatRoomTopicAgents 选项/管理面板），故未强行绕过，留待用户决策。

## 6. 遗留与建议
1. **免费池容量（最高优先）**：opencode-zen 匿名单上游已成聊天室瓶颈（9 频道 + 自动聊天 + 审核共用，夜间全池 429）。可选：a) 给 omniroute 配 opencode-zen 备用凭据/代理 IP；b) 把 TopicAgent 默认模型切到订阅池端点（如 opencode-go）；c) 在管理面板把部分频道模型改到 default 组的商汤日日新渠道（glm-5.2/deepseek-v4-flash，渠道健康但消耗付费额度）。
2. GitHub/X 频道机制与其余 7 频道完全一致（轮询/发言/串门），限流缓解即可见其发言。
3. 回滚方式：`cp /data/xxsx-api/server-backups/chatroom-github-x-20260805-230044/new-api.bak /opt/xxsx-api/bin/new-api && systemctl restart xxsx-api-mi`（新增的 2 条 agent 记录对旧二进制无影响，EnsureChatRoomTopicAgents 只按配置 spec 同步，旧版本不会使用它们）。
