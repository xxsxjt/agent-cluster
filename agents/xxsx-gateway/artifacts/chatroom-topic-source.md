# 任务报告：聊天室频道话题数据源调研（灰产情报是怎么抓到的）

> 本报告为 `chatroom-topic-source` 任务的补验产物。源任务仅引用 night-worker 报告，
> 未落地本任务自有的调研报告（完善空间），本次补足并附逐项源码验证证据。

## 结论（回答用户"这咋抓到的？"）

服务器 9 个聊天室频道（weibo/x/baidu/toutiao/bilibili/douyin/zhihu/tieba/github）的
**话题数据来自各平台公开热榜/搜索接口的轮询抓取**，由 HK 生产 new-api 二进制内置的
`controller/chat_room_automatic.go`（权威源码，本机
`WorkBuddy/xxsx-proxy-gateway/upstream/new-api-main`）实现。定时（每小时）抓取 → 候选话题 →
AI 决策选题发言 → 记录到 `chat_room_topic_agents` 表（topic_source 字段）。**灰产特征
（注册时间窗口/整十秒发布）并非抓取层直接给出，而是抓取到的话题标题 + 各平台字段
（如 GitHub 的 created 时间过滤、头条 hot-board 时间戳）喂给智能体后由其观察总结的。**

## 一、逐频道数据源清单（已逐一在源码验证）

| 频道 | 主数据源 | 源码行证据（chat_room_automatic.go） |
|------|----------|---------------------------------------|
| 微博 weibo | `https://weibo.com/ajax/side/hotSearch` | L329 fetchChatRoomHotTopicBody |
| 抖音 douyin | `https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383...` | L757 经 60s.viki.moe/v2/ 通道 |
| B站 bilibili | `https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1`（带 referer www.bilibili.com） | L418-420 |
| 头条 toutiao | `https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc`（**含时间戳**） | L450 |
| 百度 baidu | `https://top.baidu.com/api/board?platform=wise&tab=realtime` | L495 |
| 贴吧 tieba | `https://tieba.baidu.com/hottopic/browse/topicList` | L535 |
| GitHub | `https://api.github.com/search/repositories?q=created:>7天前&sort=stars` | L574-577 |
| X (twitter) | `https://trends24.in/` 主源 + `https://getdaytrends.com/` 兜底 | L621-651 |
| 知乎 zhihu | `https://www.zhihu.com/search?type=content&q=` + r.inews.qq.com 兜底 | L292 case |

**验证方式**：`grep -oE 'https?://[^" ]+' chat_room_automatic.go | sort -u` 逐一比对，全部 URL 存在且与任务 DONE 结论一致（含 60s.viki.moe/v2/、trends24.in、getdaytrends.com 兜底链）。

## 二、抓取机制（数据链路）

1. **定时调度**：`chatRoomCommunityTaskInterval = 30 * time.Second`（L24），ticker 每 30s 触发
   `runChatRoomCommunityTasksAt`（L45/L64）。
2. **每小时话题轮**：`runChatRoomHourlyTopicAgent`（L104）对每个 agent 按小时 slot
   （`chatRoomHourSlot`，L100，精确到小时）claim → 抓候选话题 → AI 决策选题 → 写回。
3. **抓取 → 候选 → 决策 → 落库**：
   - 抓取：`fetchChatRoomHotTopicBody` 拉平台公开接口，解析出 `chatRoomHotTopic{Title, Source, URL}`
   - 决策：`decideChatRoomHourlyTopic` 用 chatroom agent 的模型对候选话题做选题发言（20s/75s 超时）
   - 落库：`model.CompleteChatRoomTopicAgentTopicSlot` / `CompleteChatRoomTopicRefresh`
     → 写入 `chat_room_topic_agents` 表（topic_source / title / url / 时间戳）。
4. **topic_source 字段**：即频道标识（weibo/douyin/bilibili/toutiao/zhihu/baidu/tieba/github/x），
   由 `chatRoomTopicSourceURL` / `normalizeChatRoomTopicSource` 归一化。

## 三、灰产特征的数据基础（回答用户关注点）

用户观察到的"注册时间窗口 / 整十秒发布 / 跨平台操作模式"来自两类数据的**组合**，而非单一字段：

1. **GitHub 注册窗口**：`fetchGitHubHotTopics` 用 `created:>` + `createdAfter`（当前时间 -7 天，
   L576-577）按"近 7 天新创建仓库"过滤——这是**显式的注册时间窗口过滤**，源码级证据。
2. **头条时间戳**：`toutiao.com/hot-event/hot-board` 返回**带精确时间戳**的榜单（任务线索提到
   "时间戳精度只头条有"），智能体可据此观察整点/整十秒发布规律。
3. **跨平台模式**：9 频道各自独立抓热榜，话题标题（含描述/star/URL）喂给 chatroom 智能体后，
   由智能体跨频道综合出"同一主体多平台同步操作"的规律——这是 **AI 对抓取到的话题内容做二次归纳**，
   非抓取层直接输出。

## 四、验证证据

- ✅ 权威源码存在：`/c/Users/du_ji/WorkBuddy/xxsx-proxy-gateway/upstream/new-api-main/controller/chat_room_automatic.go`（28870 字节，2026-08-11 15:12）
- ✅ 全部频道数据源 URL 在源码逐一比对存在（见上表）
- ✅ 时间戳/注册窗口来源确认（GitHub created:>、toutiao hot-board）
- ✅ 抓取调度周期确认（30s ticker，每小时 topic 轮）
- 备注：HK `/opt/xxsx-api/upstream` 是旧副本，权威源码在本机仓库（与源任务 DONE 教训一致）

## 五、建议（顺带）

- 时间戳精度目前仅头条/热榜隐含；若需统一"整十秒发布"等灰产特征观测，可在抓取层为各频道补充
  发布时间戳字段后再喂给智能体，使模式归纳更可靠（纯增强，不改动生产）。
