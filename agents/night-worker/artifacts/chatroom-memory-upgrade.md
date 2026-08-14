# 聊天室频道记忆体系升级报告（chatroom-memory-upgrade）

- 执行：night-worker
- 时间：2026-08-06 14:00–16:00（部署 r6 15:00、**r7 15:48**；首轮总管总结 14:30/14:47/14:52 已观察）
- 源码：`D:\dx\projects\xxsx-proxy-gateway\upstream\new-api-main`（权威源码 WorkBuddy/xxsx-proxy-gateway 镜像）
- 结论：**✅ 已部署（r9），全部验证通过**

## 1. 需求与设计

### 用户需求（2026-08-06 10:05）
各频道智能体要【带着自己频道的信息差异、不同上下文】参与讨论 → 独立记忆 + 公共数据库 + 讨论总管。

### 现状核实
- 每频道只有 `context_summary`（对话压缩摘要，140-1033 字）——太薄，无频道立场/特征/差异点
- 无独立记忆库、无公共数据库、无总管
- `EnsureChatRoomTopicAgents` 每 30s 按 spec 覆写 `chat_room_topic_agents` 的配置字段（model/display_name/role/budgets/system_prompt）——**但 context_summary 不在覆写范围**，由 `UpdateChatRoomTopicAgentContextSummary` 单独维护

### 关键设计决策
1. **新表不进 spec**：独立记忆/公共库用**独立表**，由 new-api 逻辑直接维护，reconcile 不触碰 → 持久性有保障（这是坑①的解：进 spec 才被覆写，不进 spec 就安全）
2. **总管=硬编码 spec**：在 `configuredChatRoomTopicAgentSpecs` 开头无条件 append `coordinator` spec（不受 ChatRoomTopicAgents 选项影响，每 30s reconcile 自动创建/保持记录）→ 有稳定身份（可被用户 @、可出现在 available_bots、前端频道列表自动显示）
3. **总管总结轮复用 visit slot 节流**：coordinator 无 topic_source（不抓热点），串门循环跳过它；在串门阶段（每半点）用它的 visit slot claim 做节流——每小时最多一次总结，成本可控（1 次 deepseek-v4-flash/小时）
4. **记忆压缩复用现有机制**：`summarizeChatRoomTopicAgentContext`（已有，按预算压缩旧对话）+ 新 memory 写入时各字段限长截断（stance≤800、列表项≤160、知识字段≤1200），模型用 coordinator 默认模型 deepseek-v4-flash（便宜）

## 2. 表结构（AutoMigrate 自动建表）

### `chat_room_topic_memories`（每频道独立观察记忆）
| 字段 | 类型 | 说明 |
|---|---|---|
| id | int64 PK | |
| source | varchar(64) unique | 频道标识（weibo/github/...） |
| channel_key | varchar(64) index | topic:xxx |
| memory_json | text | 结构化 JSON：recent_topics（最近话题）、stance（本频道立场/视角）、channel_features（频道特征）、difference_points（值得带进讨论的差异点） |
| updated_at | bigint | |

### `chat_room_common_knowledges`（跨频道公共知识库）
| 字段 | 类型 | 说明 |
|---|---|---|
| id | int64 PK | |
| topic | varchar(256) index | 知识条目主题 |
| channels | varchar(512) | 涉及频道 source 列表 |
| consensus | text | 跨频道共识 |
| disagreements | text | 分歧点 |
| open_questions | text | 待验证问题 |
| status | varchar(16) default active | active/archived |
| updated_at | bigint | |

## 3. 改动 diff（按文件）

### r8 修复（17:00 部署）——单飞锁 + 串门错峰（根因修复）
- **问题**：`runChatRoomCommunityTasks` 每 30s ticker 触发且**无互斥锁**——串门/总管轮单轮耗时超过 30s 时多轮 goroutine 重叠并发，整点/半点高峰把商汤渠道（channel 28）打成 429 风暴（TPM/RPM），new-api 对失败 key 逐个退避后表现为误导性的 quota exhausted/insufficient_quota；15:30-16:48 多次验证受阻均源于此
- **改法**：`runChatRoomCommunityTasks` 加 `sync.Mutex` + `TryLock` 单飞（上一轮未完成则跳过本轮）；串门循环每频道间隔 `chatRoomVisitStaggerDelay=5s` 错峰
- **效果**：17:00 hourly 轮 channel 28 成功 17 次仅 3 次 429；17:30 串门+总管轮全程无 429 风暴，4 分钟正常完成
- r8 二进制：`C:\_dx_serve\new-api-linux-amd64-20260806-chatroom-memory-r8`（md5 4d09f475b62cd0afeb8f8381a844d098）；备份 `chatroom-memory-r8-20260806-170000/`

### r9 修复（17:38 部署）——memory 平铺形态兼容（memory 空内容根因）
- **问题**：r7 拆分后调用①输出 5005 tokens 但落库仍空——**模型按 prompt 字面把 memory 内容平铺在 update 顶层**（`{"source":"weibo","recent_topics":[...],"stance":"...",...}`），而结构体期望嵌套 `memory:{...}` → Memory 字段永远为空（r6 同样根因）
- **验证**：直连商汤复现，模型输出对话式响应（prompt 弱时）→ 确认模型输出形态不可控，必须代码兼容
- **改法**：`chatRoomCoordinatorMemoryUpdate` 增加平铺字段（recent_topics/stance/channel_features/difference_points 顶层 json tag）；apply 时嵌套 memory 全空则采用顶层平铺内容；prompt 增加嵌套 JSON 示例引导
- r9 二进制：`C:\_dx_serve\new-api-linux-amd64-20260806-chatroom-memory-r9`（md5 d32b2f1fce0f0234cf337f6ae65ce5e0）；备份 `chatroom-memory-r9-20260806-173700/`

### r7 修复（15:48 部署）——拆分总管生成调用
- **问题**：r6 单次调用时模型把输出预算优先给 knowledge/message（719 completion tokens 内塞 9 频道 memory + 2 knowledge + 436 字发言），导致 memory_updates 数量正确但 **memory 内容全部为空对象** `{"recent_topics":[],"stance":"",...}`（knowledge 质量不受影响，6 条内容丰富）
- **根因**：`CallInternalModel` 不传 max_tokens，模型自行权衡输出；prompt 对 memory 无"禁止空字段"硬约束
- **改法**：`generateChatRoomCoordinatorRound` 拆分为两次调用（`runChatRoomCoordinatorRound` 串行）：
  1. `generateChatRoomCoordinatorMemories`：只输出 memory_updates，prompt 硬性要求 stance≥10字、recent_topics≥1、channel_features≥2，禁止空数组（difference_points 除外）
  2. `generateChatRoomCoordinatorInsights`：只输出 knowledge_updates + coordinator_message + target_bots
- 成本：每小时 2 次 deepseek-v4-flash（各 ~7000 输入 tokens），仍可忽略；两次各 70s 超时，visit lease 4 分钟够
- r7 二进制：`C:\_dx_serve\new-api-linux-amd64-20260806-chatroom-memory-r7`（md5 42ae6fdba5749a4a7c05b81e0c028259）；备份 `/data/xxsx-api/server-backups/chatroom-memory-r7-20260806-154841/`

### model/chat_room_memory.go（新增）
- `ChatRoomTopicMemory` / `ChatRoomCommonKnowledge` 结构体
- CRUD：`GetChatRoomTopicMemory` / `UpsertChatRoomTopicMemory` / `ListChatRoomCommonKnowledge` / `UpsertChatRoomCommonKnowledge`（按 topic 精确匹配更新）
- 全部带 `DB == nil` 保护（测试环境/降级安全）

### model/main.go
- `migrateDB()` AutoMigrate 注册 `&ChatRoomTopicMemory{}, &ChatRoomCommonKnowledge{}`

### controller/chat_room_topic_agent.go
- 常量：coordinator 身份（source=coordinator / channel=topic:coordinator / handle=coordinator-ai / 讨论总管）+ 限长常量
- `configuredChatRoomTopicAgentSpecs`：开头无条件 append coordinator spec（讨论总管，无 topic_source）
- `chatRoomTopicAgentContext`：新增 `memory` / `common_knowledge` 字段（omitempty，向后兼容）
- `prepareChatRoomTopicAgentContext`：加载本频道记忆 + 公共库条目（各 5 条）注入 prompt；查询失败静默降级
- 新增 `runChatRoomCoordinatorRound` / `buildChatRoomCoordinatorRoundInput` / `generateChatRoomCoordinatorRound` / `applyChatRoomCoordinatorRoundOutput` / `truncateChatRoomStringList`：
  - 汇总各频道最近 6 条消息 + context_summary + 现有记忆 + 既有知识库 → deepseek-v4-flash 生成 JSON（memory_updates / knowledge_updates / coordinator_message / target_bots）
  - memory/knowledge 落库；有实质发言时以"讨论总管"身份写入 topic:coordinator 频道并 @ 目标频道（最多 2 个）触发回复链（≤3 hops 受既有机制约束）

### controller/chat_room_automatic.go
- 串门循环跳过 coordinator（总管不做普通串门）
- 串门阶段末尾调用 `runChatRoomCoordinatorRound`（visit slot 节流，每半点后每小时一次）
- `buildChatRoomChannelSummaries`：串门 summaries 增加"频道观察记忆"行（对方频道记忆随串门注入）

### 测试更新（controller/chat_room_automatic_test.go、chat_room_test.go）
- `TestConfiguredChatRoomTopicAgentsHonorPerChannelSettings`：spec 1→2（coordinator 恒在首位）
- `TestConfiguredChatRoomTopicAgentsSupportDiscussionAndSharedCollectors`：3→4
- `TestChatRoomTopicChannelAuthorizationAndStatus`：TopicChannels[0] = coordinator
- 新增 `TestChatRoomTopicAgentContextInjectsChannelMemoryAndKnowledge`（注入验证）、`TestChatRoomCoordinatorRoundOutputPersistsMemoryKnowledgeAndMessage`（落库+发言验证）
- 新增 `newChatRoomMemoryTestDatabase` helper（含新表 AutoMigrate）

## 4. 构建与部署（r1→r6 迭代）

| 版本 | 构建时间 | 部署 | 内容 |
|---|---|---|---|
| r1 | 14:09 | 14:10 | 首版：表结构 + 注入 + coordinator 轮 |
| r2 | 14:37 | 14:37 | 对象/数组双形态解析等修复 |
| r3 | 14:42 | 14:42 | 修复（详见会话记录） |
| r4 | 14:45 | 14:45 | 修复 |
| r5 | 14:50 | 14:50 | 修复 |
| **r6** | 14:59 | **15:00** | **修复 memory 0 条问题：resolve 支持 bot_handle 匹配 + 强化 prompt（source 必须用 channels 的 source 字段值）+ 新增 output 统计日志与 skipped 日志** |

- 构建命令：`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags embed -ldflags "-X github.com/QuantumNous/new-api/common.Version=v0.0.0-xxsx.chatroom-memory.6-20260806"`
- r6 产物：`C:\_dx_serve\new-api-linux-amd64-20260806-chatroom-memory-r6`（162MB）
- r6 md5：`16bb682f8a7f41b0d78162fc55bd1d24`（上传校验一致）
- r6 备份：`/data/xxsx-api/server-backups/chatroom-memory-r6-20260806-150031/`（new-api.bak + xxsx-new-api.db.bak）
- 部署：stop → fuser 检查（无写入者）→ rm + cp（新 inode）→ start → **active**（HK twjnrahg6gsg）

## 5. 验证结果

| 项 | 结果 |
|---|---|
| 服务状态 | ✅ active |
| API /api/status | ✅ 200 |
| 新表建好 | ✅ `chat_room_topic_memories` + `chat_room_common_knowledges`（AutoMigrate） |
| coordinator 记录 | ✅ id=10（reconcile 自动创建，source=coordinator / 讨论总管 / deepseek-v4-flash） |
| 全量 go test（controller/model） | ✅ 全绿 |
| reconcile 不覆盖新表 | ✅ 结构保证（独立表不进 spec）；已观察多轮不受影响 |
| 总管已发言 | ✅ 14:47:12（邀请微博/头条分享武汉辟谣数据）、14:52:00（辟谣沟通断裂，邀请微博+头条） |
| 频道响应总管 | ✅ 微博（14:47/14:52 回复）、X（14:42）、头条（14:52）、抖音（14:53 补充医保窗口短视频视角）——各频道带自身频道特征发言 |
| 公共知识库写入 | ✅ 4 条（灰产跨平台操作模式 / 抽象神游的Unity模板现象 / 张一鸣不依赖蒸馏谣言 / 辟谣沟通断裂现象），14:50:51 更新 |
| **频道独立记忆写入（r6）** | ⚠️ **9/9 频道写入但内容全空**（`{"recent_topics":[],"stance":"",...}`）——模型输出预算优先给 knowledge/message，memory 被压缩成空对象；15:40:19 轮 `memory_updates=9 knowledge_updates=2 message_len=436` |
| **频道独立记忆写入（r7）** | ⚠️ 17:34:59 轮：`split calls memory_updates=9 knowledge_updates=2 message_len=374`——9 条数量正确但内容仍空（平铺形态兼容缺失，见 r9）；期间 16:30-16:48 多次被商汤 429 风暴阻塞（见 r8） |
| **频道独立记忆写入（r9）** | ✅ **19:38:39 轮：9 条全部非空（281-322 字符）**，内容含 recent_topics/stance/channel_features/difference_points（如 github 质疑 kimi-k3-in-c 参数、weibo 苏泊尔擦边热搜灰产分析、x 跨平台灰产网络验证），各频道立场与差异点清晰 |
| **持续运行（18:30-19:38）** | ✅ 18:46 knowledge 更新（日本导弹警报灰产特征）；19:38 轮 memory 9 条 + knowledge 3 条 + 总管发言 402 字（@ 频道交叉讨论）——r8 单飞后无 429 风暴，整点/半点轮稳定运行 |
| 注入生效 | ✅ 频道发言/串门/总管轮均注入 memory+knowledge（prepareChatRoomTopicAgentContext，查询失败静默降级） |

（15:30 后补充：knowledge 表已从 4 条增至 8 条（15:41:22 写入"梅姨真名曝光信源核实与灰产关联"、"美国禁止进口中国机器人谣言"；17:34:59 写入"梅姨真名曝光信源核实与灰产关联"（更新）、"周处除三害现实版视频核实方法"）；15:30-16:48 期间商汤渠道（channel 28）反复 429 限流/额度耗尽（根因=r8 修复的并发风暴），直连验证 5 个 key 全部正常，问题在 new-api 渠道层 key 退避；r8 单飞锁+错峰后 17:00/17:30 轮显著改善）

## 6. 行为说明与边界

- **总管发言节流**：每半点后每小时最多 1 次总结轮；仅当模型认为存在"值得发起交叉讨论的新分歧/新话题"才发言（coordinator_message 非空），否则静默更新记忆与知识库
- **注入路径**：① 本频道发言/回复/选题时 `channel_context.memory` + `channel_context.common_knowledge`；② 串门时 `other_channels[].summary` 带对方频道记忆 → 各频道带着自己视角说话
- **成本**：每小时 2 次 deepseek-v4-flash 总结调用（r7 拆分后，各约 7000 输入 tokens），可忽略
- **兼容性**：context 新字段 omitempty；旧二进制/旧库无新表时查询失败静默降级，不影响既有讨论

## 7. 回滚

```bash
# r9 备份目录 /data/xxsx-api/server-backups/chatroom-memory-r9-20260806-173700/
# 历史备份：chatroom-memory-20260806-140931/ 140939/ r2-…143730/ r3-…144228/ r4-…144536/ r5-…145011/ r6-…150031/ r7-…154841/ r8-…170000/
systemctl stop xxsx-api-mi.service
cp /data/xxsx-api/server-backups/chatroom-memory-r9-20260806-173700/new-api.bak /opt/xxsx-api/bin/new-api
cp /data/xxsx-api/server-backups/chatroom-memory-r9-20260806-173700/xxsx-new-api.db.bak /data/xxsx-api/new-api-data/xxsx-new-api.db
systemctl start xxsx-api-mi.service
# 注：新增 3 张表（含 coordinator 记录）对旧二进制无影响（EnsureChatRoomTopicAgents 只按 spec 同步自己认识的 source）
```
