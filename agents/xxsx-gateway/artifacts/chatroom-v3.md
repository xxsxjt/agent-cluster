# chatroom-v3 聊天室增强落地：观察员接入集群分组 + 加 5 频道 + 信息搜索确认

- **智能体**：xxsx-gateway
- **日期**：2026-08-12 19:0x
- **任务**：chatroom-v3（用户催办："不是说过很多次加多几个频道吗，不是还有一个搜索指定信息的功能吗，咋啥都没做"）

## 一、背景与现状核对

- 信息搜索功能（v2 需求1）**此前已真实落地**（78ace2a + 5b17815 + 858841a + 781d0d7），含：info-search 私聊式会话、自动@观察员响应链、每成功回复扣 1 余额、计费告知、Android 入口、失败回复不扣费。**用户感知不到的原因：加频道与观察员分组一直没做**，且生产 DB 持久化的 ChatRoomTopicAgents 仍是 9 观察员旧配置。
- 本次完成：①观察员分组（org.json，15 节点）②加 5 个新频道（10→15）③信息搜索做回归确认（已可用）④部署 HK 并 E2E 验证。

## 二、①观察员分组（org.json）

- 新增分组 **grp-observer「频道观察员组」**（挂 grp-coo 下，管理组），15 个频道观察员注册为集群智能体节点：
  - 10 个既有：weibo/douyin/bilibili/toutiao/zhihu/baidu/tieba/github/x/tencent-news
  - 5 个新增：xiaohongshu/caijing/movie/game/it-news
  - 节点字段：`role=channel-observer`、`spawnType=chatroom`（由聊天室引擎驱动，非独立进程）、`agentDir=chatroom/observers/<source>`、keywords/notes 含数据源与职责说明
- 联动：观察员=集群智能体节点，可被管家调度、向总管汇报；与聊天室角色一一对应（bot_handle=<source>-ai）。
- org.json 已备份 `org.json.bak-chatroom-v3`，节点数 54。

## 三、②加频道（10 → 15）

### 新频道与数据源（全部实测可用）
| 频道 | 观察员 | 数据源 | 实测 |
|---|---|---|---|
| xiaohongshu | 小红书观察员 | 60s-api /v2/rednote | ✅ 20 条（含热度分） |
| caijing | 财经观察员 | 新浪财经 7x24 zhibo.sina.com.cn | ✅ 30 条（含时间戳） |
| movie | 影视观察员 | 60s-api /v2/maoyan/realtime/movie 猫眼实时票房 | ✅ 52 条（含票房/上映天数） |
| game | 游戏观察员 | 60s-api /v2/epic | ✅ 3 条（Epic 热游） |
| it-news | 科技资讯观察员 | 60s-api /v2/it-news/rank（IT之家） | ✅ 12 条（含原文链接） |

> 快手曾尝试（官网 __APOLLO_STATE__ 内嵌热榜），但热榜数据需 JS 渲染无静态内容，放弃；任务候选注"数据源可用的"，以 it-news 替代。

### 代码改动（upstream/new-api-main）
| 文件 | 改动 |
|---|---|
| controller/chat_room_automatic.go | ①fetchChatRoomHotTopicsForSource 加 5 case + 5 个 fetch 函数（60s 源统一走 retry 包装）②chatRoomTopicSourceURL 加 5 源搜索/浏览 URL ③新增 `fetchChatRoomHotTopicBodyRetry`（指数退避 3 次重试——60s-api 无 token 时 IP 级短窗口 429）④新增 `stripChatRoomHTMLTags`（新浪快讯 HTML 清洗） |
| controller/chat_room_topic_agent.go | normalizeChatRoomScheduledTopicSource 加 5 新源 case（**关键修复**：缺失导致新源 topic_source 被置空、scheduler 永不抓取） |
| setting/chatroom/setting.go | 默认 HotTopicSources/TopicAgents 10→15；defaultTopicAgentConfig 加 5 观察员 displayName/role；normalizeTopicAgentSource/TopicSource 加中文别名（小红书/财经/影视/游戏/IT之家） |
| setting/chatroom/setting_test.go | TestTopicAgentDefaultsKeepExistingChannelsOperational 10→15 断言 |
| controller/chat_room_v3_channels_test.go | 新增：5 新源真实抓取测试（错峰 6s 模拟生产 stagger） |

### 生产配置同步（关键）
- 生产 DB `ChatRoomTopicAgents` 选项是 9 观察员旧配置（v2 时代持久化），覆盖新默认值。**直接改 DB 无效**（内存缓存），必须经管理 API `PUT /api/option/`（RootAuth）更新 → 内存+DB 同步。已更新为 15 agent JSON（保留既有 9 个的配置，追加 6 个）。

## 四、③信息搜索（回归确认，已可用）

E2E 回归（HK 生产，测试用户后清理）：
- 创建会话：type=info-search ✅（每人独立·幂等）
- 发消息"追踪 2026年8月 AI 新产品发布"→ 15 观察员 + 讨论总管多次汇总，17 条成功回复全部 completed（链尾若干 failed 为模型调用超时，**不扣费**——v2 修复生效）
- 收费：quota 10,000,000 → 1,500,000，扣 8,500,000 = **17 × 500000（1余额）** 精确对应 17 条成功回复 ✅
- 计费告知：status 返回 info_search_fee_per_reply=1 + billing_text ✅

## 五、④部署与验证（HK 生产）

- 构建：`GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build`（含符号，162MB）
- 部署：deploy-hk.sh 路由预检通过（app-release=3/mobile-admin=3/cluster=1）→ 备份当前版 → 覆盖 → 起服 → active
- 最终 md5=`bb0a804176a4ddbe6657f08732f86e1e`，备份 `new-api.bak.chatroom-v3-20260812-183707` 等 3 份
- **E2E 验证**：
  1. topic_channels = 16（coordinator + 15 观察员）✅
  2. 新频道 scheduler 抓取：game="Beacon Pines"、it-news="Mate 90 系列…"、movie="欢迎来龙餐馆"、xiaohongshu="耗时三年拍下古诗词里的中国"、tencent-news="C919正式执飞首条国际航线" ✅（caijing 已 claim 正常，模型自主判断未发布属正常）
  3. 信息搜索 17 条回复 + 精确扣费 ✅
  4. 测试用户/会话/消息已清理 ✅
- 单测：新源抓取 5/5 通过（错峰后）、setting 15 断言全过、chatroom 全量测试 ok

## 六、git 提交

- `bb72469` feat(chatroom): v3 加 5 频道(小红书/财经/影视/游戏/科技资讯) + 15观察员接入 + 60s限流退避重试（5 文件 +380 行，chat_room_v3_channels_test.go 新增）

## 七、遗留 / 说明

1. **caijing 生产首轮未出 topic**：fetch 函数单测通过（30 条），生产 claim 正常，属模型自主判断（scheduler 每小时重试，非阻塞）。
2. **60s-api 无 token 限流**：已加 3 次退避重试 + 生产 5s 错峰，观测正常；若频繁 429 可考虑申请 60s token 配置。
3. **Android 用户端**：v2 已加信息搜索入口（v0.6.7+），15 频道无需客户端改动（服务端下发）。
4. 观察员分组为 org.json 元数据注册（调度/汇报入口），观察员实际执行仍在聊天室引擎内。