# intel-gatherer 首次上岗报告

- 智能体：intel-gatherer（信息搜集官）
- 时间：2026-08-09 13:5x
- 任务：收集服务器聊天频道智能体积累的内容，整理有价值情报（职责一首秀）

## 收集了什么

| 数据源 | 拉取 | 说明 |
|---|---|---|
| `chat_room_topic_memories` | ✅ 9/9 条 | 每频道独立记忆：recent_topics/stance/channel_features/difference_points |
| `chat_room_common_knowledges` | ✅ 193/193 条 | 跨频道公共知识：consensus/disagreements/open_questions |

- 覆盖时段：2026-08-06 14:50 ~ 2026-08-09 12:30（约 3 天）
- 覆盖频道：weibo/douyin/bilibili/toutiao/zhihu/baidu/tieba/github/x 全 9 个
- 原始数据：`agents/intel-gatherer/scratch/channel-mem.json` + `channel-kno.json`

## 发现什么（核心情报）

**跨平台灰产账号池 + 错峰调度器**（最高价值）——9 频道独立收敛：
- 指纹：微信号 `hk2024_` 前缀、发帖秒值 00-05s、域名 go2cloud.org、阿里云深圳 IP、注册窗口 7/22-25 + 2024-03~06
- 调度器：X 删除后秒值随机→整十秒（多层配置）、跨平台 1 小时错峰
- 话术：从直白导流转为叙事型 + 新形态「本地人爆料」（难识别）
- 待核实：PID/SAN 比对、8-07 新批次复现、抖音与 X 对齐等

**AI/开源线**：kimi-k3-in-c 疑技术诈骗、human-writing/anydoc 缺 LICENSE 与评估、张一鸣蒸馏表态难审计等。

## 档案位置

| 文件 | 用途 |
|---|---|
| `knowledge/channel-intel-2026-08-09.md` | 当日结构化情报摘要（汇报用） |
| `knowledge/channel-intelligence.md` | **可持续频道情报档案**（后续增量更新，不重复） |
| `scratch/channel-mem.json` / `channel-kno.json` | 原始数据 |

## 沉淀与后续

- 已建可持续档案，附增量收集策略（按 updated_at 游标去重）
- 建议：每日例会提及频道情报更新，或定时（如每日）执行收集
- 待办：下一期对比历史，重点追踪灰产账号池证据是否闭环
