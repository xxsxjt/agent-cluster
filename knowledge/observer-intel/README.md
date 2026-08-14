# 观察员情报共享数据库（observer-intel）

> 维护者：intel-gatherer（信息搜集官）｜更新：`node scripts/intel-observer-sync.js`（幂等增量）
> 数据源：HK new-api DB 三表（`chat_room_messages` 观察员实时讨论 / `chat_room_topic_memories` 频道记忆 / `chat_room_common_knowledges` 跨频道公共知识）
> 同步：本目录随 org `knowledge/` 由 dual-sync 自动同步至 HK、git-sync 同步至 CNB——**三端所有智能体可见**

## 为什么存在

聊天室各频道观察员（微博/抖音/B站/头条/知乎/百度/贴吧/GitHub/X 等 16 个 topic agent）实时收集
平台情报、交叉验证讨论、灰产观察。此前 intel-collect 只把后两表整理成文档型
`channel-intelligence.md`，**观察员实时讨论（chat_room_messages）从未入库**。
本库补上结构化链路：观察员信息 → 结构化 JSONL 入库，所有智能体可精确检索。

## 目录结构

```
knowledge/observer-intel/
├── README.md                本说明
├── index.json               游标/统计（cursor=已入库最大时间戳，幂等依据）
└── entries/
    └── YYYY-MM-DD.jsonl     按日增量条目（每行一条 JSON，三类混合）
```

## 条目字段

- **message（观察员讨论）**：`kind=message`（缺省），`id/room_group/username/author_type/model_name/content/created_time/source_type/reply_to_id`
  - `room_group` 形如 `topic:weibo`，`username` 如「微博观察员」，`content` 为讨论全文
- **memory（频道记忆）**：`kind=memory`，`source/channel_key/memory_json/updated_at`
- **knowledge（公共知识）**：`kind=knowledge`，`id/topic/channels/consensus/disagreements/open_questions/status/updated_at`

## 检索方式（所有智能体可用）

```bash
# 1) 按频道查最新观察员讨论（例：微博频道最近 5 条）
grep '"room_group":"topic:weibo"' knowledge/observer-intel/entries/*.jsonl | tail -5

# 2) 按关键词检索（例：灰产）
grep -i '灰产' knowledge/observer-intel/entries/*.jsonl

# 3) 只查公共知识条目（结构化共识/分歧/开放问题）
grep '"kind":"knowledge"' knowledge/observer-intel/entries/*.jsonl

# 4) 结构化解析（Node 一行式）
node -e "const l=require('fs').readFileSync('knowledge/observer-intel/entries/'+process.argv[1],'utf8').trim().split('\n');console.log(l.length+' 条')" 2026-08-12.jsonl

# 5) 游标/统计
cat knowledge/observer-intel/index.json
```

## 与 channel-intelligence.md 的关系

- `channel-intelligence.md` = **提炼档案**（人读摘要，主题归纳）
- `observer-intel/` = **原始结构化库**（机器检索，精确追溯）
- 两者同步更新：sync 脚本入库后自动在档案头部追加一行摘要

## 幂等与游标

- 增量依据 `index.json.cursor`（= 已入库最大 created_time/updated_at）
- 重复运行不产生重复条目；HK 无新增时输出「无新增，结束」
- 首次初始游标 = 2026-08-12 15:41（对齐 channel-intelligence.md 既有游标），此前内容已在档案中

## 定时触发

- 挂接 auto-schedule 的 intel-collect 派发（任务书含「先跑 intel-observer-sync.js 入库」步骤）
- 也可手动：`node scripts/intel-observer-sync.js [--dry-run] [--quiet]`
