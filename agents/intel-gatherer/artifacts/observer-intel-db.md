# 观察员信息 → 共享数据库（observer-intel-db）

- 执行：intel-gatherer（信息搜集官）
- 时间：2026-08-12 20:00
- 背景：用户问"有没有根据观察员们收集到的信息更新数据库？"——聊天室各频道观察员（微博/抖音/B站等）收集的情报/讨论/灰产观察，应进所有智能体可查的共享数据库。

## 1. 现状盘点

### 观察员信息存哪（HK new-api DB，`/data/xxsx-api/new-api-data/xxsx-new-api.db`）

| 表 | 行数 | 说明 | 此前采集？ |
|---|---|---|---|
| `chat_room_messages` | 9244 | **观察员实时讨论/交叉验证/发现**（16 频道 topic agent），最新到 08-12 19:16 | ❌ **从未入库** |
| `chat_room_topic_memories` | 15 | 每频道记忆（recent_topics/stance/features） | ✅ 已采（文档型） |
| `chat_room_common_knowledges` | 383 | 跨频道公共知识（consensus/disagreements/open_questions） | ✅ 已采（文档型） |
| `chat_room_topic_agents` | 16 | 观察员 agent 配置/状态 | ❌ 未采（运维信息） |

### intel-gatherer 现有链路（intel-collect）

- 每 6h auto-schedule 派发 `inbox/intel-collect-<ts>.md` → 拉 HK 记忆/公共知识 → 整理追加 `knowledge/channel-intelligence.md`（文档型档案，80KB md）
- **核心缺口**：
  1. `chat_room_messages`（观察员**实时**讨论，最新鲜情报）从未采集——此前只采了记忆/知识两张"沉淀表"
  2. 共享库是文档型 md，非结构化存储——其他智能体只能 grep 全文，无法按频道/类型/时间精确检索
  3. 无独立共享库路径，检索入口不清晰

## 2. 共享数据库落地

### 结构：`org/knowledge/observer-intel/`

```
knowledge/observer-intel/
├── README.md              检索方式说明（所有智能体入口）
├── index.json             游标/统计（幂等依据）
└── entries/2026-08-12.jsonl  按日增量 JSONL（每行一条，三类混合）
```

条目类型：`message`（观察员讨论：room_group/username/content/created_time/reply_to_id）、`memory`（频道记忆）、`knowledge`（公共知识：topic/consensus/disagreements/open_questions）

### 同步链路：`scripts/intel-observer-sync.js`（新脚本，幂等增量）

- 游标依据 `index.json.cursor`（初始 = 1786519805，对齐 channel-intelligence.md 既有游标，只拉真正增量）
- 拉 3 表增量 → JSONL 按日入库 → 游标推进 → channel-intelligence.md 头部追加一行摘要
- `--dry-run` / `--quiet` 支持；HK 不可达快速失败不误写
- **挂接定时**：`lib/auto-schedule.js` intel-collect 任务书新增步骤 0「先跑 intel-observer-sync.js 结构化入库」（需 butler 重启生效，属轻量改动）

### 三端同步（所有智能体可查）

| 端 | 通道 | 状态 |
|---|---|---|
| 本机 Windows | 本地文件 | ✅ |
| HK Linux | dual-sync（knowledge 递归同步） | ✅ 已验证文件落地 |
| CNB / GitHub | git-sync（git 提交推送） | ✅ f67e3a0 已 push 双端 |

## 3. 验证（观察员新信息 → 入库 → 其他智能体可检索）

- 首次入库：**264 条增量**（messages 238 + memories 15 + knowledges 11），游标 → 1786535777
- 幂等：重跑 0 新增（游标机制生效）
- 本机检索：「灰产」命中 61 条（3 knowledge + 55 message + 3 memory），覆盖 8 频道
- HK 端检索：同一文件 61/264 命中（cross-end 验证通过）
- 样例（message 层，观察员实时情报）：抖音观察员在 B 站频道报告"灰产号自导评论时间戳秒级分布 1.8-2.2s（固定间隔轮询），与 X 侧 $MOTION 整十秒节流不同；落地页 CSS 类名 form-control-yt 自定义命名"——此前这类**实时讨论从未进过任何共享库**
- 知识层样例：`跨平台灰产脚本特征差异（抖音评论秒位1.8-2.2秒 vs X推文整十秒）` id=379

## 4. 产出清单

| 产物 | 位置 |
|---|---|
| 共享数据库 | `org/knowledge/observer-intel/`（README + index.json + entries/2026-08-12.jsonl） |
| 同步脚本 | `org/scripts/intel-observer-sync.js` |
| 定时挂接 | `org/lib/auto-schedule.js`（intel-collect 任务书加步骤 0） |
| 档案摘要 | `org/knowledge/channel-intelligence.md` 头部追加自动入库摘要 |
| git 提交 | f67e3a0（CNB + GitHub 已推送） |

## 5. 后续建议

1. **butler 重启**后 auto-schedule 新任务书生效（下次 intel-collect 自动跑结构化入库）
2. 可选：观察员活跃期（每 2h）增频 intel-collect，实时性更强
3. 可选：`chat_room_topic_agents` 状态表入库（观察员健康度），本期未做（运维性质）
4. 注意：channel-intelligence.md 存在 GBK 乱码 DONE 历史问题（见 2026-08-12 15:46 记录），新链路均 UTF-8 写盘无此问题
