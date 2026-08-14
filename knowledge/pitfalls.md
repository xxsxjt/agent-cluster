# 全局坑库（pitfalls.md）

> 维护者：学习进化官（learning-officer）
> 格式：场景 / 错误现象 / 根因 / 解法 / 时间 / 踩坑者
> 上报规则：踩坑 → 写自己 diary + 组级通用→group-diary + 全局通用→本文件
> 重复踩坑检测：同一坑被踩 ≥2 次 → 加 ⚠️ 高频标记 + 提示相关智能体

---

## ⚠️ 高频：butler.js 模块 require 缓存（改代码必须重启管家）

- **场景**：修改 lib/spawn.js、butler.js 等任何模块后，新代码不生效
- **错误**：改动后行为仍是旧逻辑（坑：只看日志以为没生效）
- **根因**：Node require 模块缓存——butler 是常驻进程，启动时已加载全部模块，之后改动不会重新加载
- **解法**：杀进程（taskkill /PID）、删 butler.pid、重启（bootstrap.js restart 或 cscript）；**验证**：重启后日志出现新的"=== 管家启动 ==="行
- **时间**：2026-08-04 | 踩坑者：night-worker
- **检测点**：改任何 lib/ 或核心 js 后，先重启管家再验收

## 阿里云 429 配额

- **场景**：aliyun-tokenplan 渠道批量/高频调用
- **错误**：HTTP 429（配额超限）
- **根因**：Token Plan 有并发/速率配额，并行打爆
- **解法**：控制并发（同一时间少派并行任务）；夜间 2 折窗口配额更宽；429 后等待退避重试
- **时间**：2026-08-04 | 踩坑者：night-worker

## 任务一锅烩（任务书塞太多目标）

- **场景**：一张任务书塞多个独立目标
- **错误**：子智能体顾此失彼，中间卡住整体 FAILED；验收时发现只完成一部分
- **根因**：任务没有拆小（拆小原则被违反）
- **解法**：**任务拆小原则**——一个任务文件只做一个目标；多目标拆多个 `<name>.md` 顺序投递；任务头写明 目标/文件/步骤/验证
- **时间**：2026-08-04 | 踩坑者：twin/coo

## 并行打爆（同时派太多任务）

- **场景**：一次投递多个任务给同渠道（尤其 ali token-plan / opencode）
- **错误**：429 / 连接失败 / 子进程 OOM
- **根因**：渠道并发上限；子进程同时跑多个重活
- **解法**：同渠道任务排队投递（等上一个 .DONE 再投下一个）；控制总并行 ≤2-3
- **时间**：2026-08-04 | 踩坑者：coo

## redfox 无 key 误报（skill 存在 ≠ 渠道可用）

- **场景**：用 image-gen / seedream / seedance skill 生成图片视频
- **错误**：模板报错/调用失败，看起来像渠道坏了
- **根因**：redfox.hk **根本没配 key**——skill 是通用模板，渠道是用户自备的
- **解法**：**用前必须验 key**（看 skill 里 key 指向哪个文件/环境变量）；盘点渠道不能只看 skill 文件，必须实测
- **时间**：2026-08-05 | 踩坑者：night-worker

## 代理池 TLS 出口挂

- **场景**：Webshare socks5 代理访问 https
- **错误**：TLS 握手失败/连接重置
- **根因**：代理池部分出口节点 TLS 故障（实测全挂）
- **解法**：换 http 代理端口重试；用前先 curl 验活；多节点轮换
- **时间**：2026-08-05 | 踩坑者：night-worker

## 阿里 wan 图片端点不支持

- **场景**：想用 aliyun-tokenplan key 调 wan2.7-image
- **错误**：400/404 或模型不存在
- **根因**：token-plan key 只支持 chat/completions 协议，图片端点不开放
- **解法**：图片生成用 agnes（实测 ✅）；阿里 key 别浪费在图片上
- **时间**：2026-08-05 | 踩坑者：night-worker

## opencode-go 端点不支持图片输入

- **场景**：给 opencode-go 传图片（mimo-v2.5-pro 视觉）
- **错误**：404
- **根因**：go 端点 openai 协议不支持图片输入（multipart）
- **解法**：视觉任务走 omniroute-free 本地 MiMo（代理挂了则等恢复）；go 只当文本渠道
- **时间**：2026-08-05 | 踩坑者：night-worker

## Git Bash 下 schtasks 路径转换失败

- **场景**：bootstrap.js 在 Git Bash 里 execFileSync('schtasks')
- **错误**：MSYS 路径转换把参数搞坏
- **根因**：MSYS 自动转换 POSIX 路径
- **解法**：改用 powershell.exe 查询/注册任务计划
- **时间**：2026-08-05 | 踩坑者：night-worker

## Windows 下 Python 读 JSON 默认 GBK 编码报错

- **场景**：python 直接 open() 读含中文的 json（providers.json / models.json）
- **错误**：UnicodeDecodeError: 'gbk' codec can't decode
- **根因**：Windows 默认 locale 编码 GBK，文件是 UTF-8
- **解法**：`open(path, encoding='utf-8')`
- **时间**：2026-08-05 | 踩坑者：night-worker

## new-api 聊天室模型配置（2026-08-06 深挖根因）
**现象**：直接改 chat_room_topic_agents.model_name 会被几秒内重置回 opencode/mimo-v2.5-free。
**链路**：聊天室频道 → new-api(3461) → 按 model_name 路由渠道。mimo 走 OmniRoute(渠道25, HK裸跑opencode免费池)→HK IP 被限流 429。
**重置机制**：controller/chat_room_topic_agent.go `ensureConfiguredChatRoomTopicAgents(cfg)` → model.EnsureChatRoomTopicAgents 逐字段比对回写 DB。cfg.TopicAgents 来自 options.ChatRoomTopicAgents；为空时从 HotTopicSources 构建、model 落默认 `chatroomsetting.DefaultTopicAgentModel`（setting/chatroom/setting.go:38 = OpenCodeMiMoModel 硬编码）。
**已做**：① 商汤渠道修复(balance=999、清失效key留6个)；② new-api 路由 deepseek-v4-flash→商汤 实测通；③ 写入 options.ChatRoomTopicAgents(9频道全deepseek-v4-flash，从现值构建只改model)——但该部署binary的option加载有怪癖，cfg 未生效，DB 仍被reconcile写回mimo。
**持久修复（待实施，归 VISION-v6 聊天室改造）**：改 setting.go:38 默认值→deepseek-v4-flash 重建部署，或修复 option 加载。源码 /d/dx/projects/xxsx-proxy-gateway/upstream/new-api-main。
**分组**：聊天室用 default 组；商汤在 default 组(可用)，Agnes 在 free 组(聊天室路由不到，不能当聊天室备用)。

## 多会话并发时「看不见的第二个泰拉瑞亚服务器」覆盖世界文件

- **场景**：主会话和子智能体同时执行同一个泰拉瑞亚重建任务，各自跑了一次 `/data/terraria/ops/genworld.sh`
- **症状**：世界生成后 `wldcheck.py` 离线校验通过（种子/难度/腐化都对），启服后**再校验实况文件，种子和地牢坐标全变了**
- **根因**：`genworld.sh` 生成完世界会**继续作为服务器常驻运行**（内含世界、每 10 分钟自动存档），父 SSH 断开后成孤儿进程；它和 systemd 服务同时写同一个 `HKWorld.wld`，孤儿的存档把已校验的世界覆盖掉。孤儿还会在看门狗超时（180×2s=360s）SIGTERM 优雅退出时再存一次盘
- **解法**：
  1. 动手前先数实例：`ps -o pid,lstart,args -C TShock.Server`（生成前后都要查，别只看 `systemctl is-active`）
  2. 清理孤儿必须**按 PID** `kill -9`；**不能用** `pkill -f "TShock.Server"`——会匹配到自己这条 SSH 远程 shell 的 cmdline 把会话一起杀掉（需转义写 `[T]Shock.Server`）
  3. 血统不明的世界文件改名归档成 `.discard` 留证，不要直接删；然后在**零并发**下重生成一次
  4. 终局校验用「服务进程自己写出的 `.bak`」——那是从服务器内存 dump 的，能证明线上跑的确实是你校验过的世界，比校验 `.wld` 本体更可靠
- **时间**：2026-08-07 | 踩坑者：server-admin

## 重建/重启服务器前先查在线（2026-08-07）

- **场景**：泰拉瑞亚服务器重建（genworld.sh）撞上玩家在线被踢
- **错误**：重建/重启时玩家掉线丢失进度
- **根因**：没先看服务器占用/在线状态就动手
- **解法**：生产服务操作前先查占用/在线状态（谁在线/有无任务正在写）；确认无人在线或告知后再动
- **时间**：2026-08-07 | 踩坑者：twin/管家

## 离线版/盗版软件渠道安全校验（2026-08-07 用户）

- **场景**：用户下载离线版/盗版软件
- **错误**：不经校验直接运行有风险
- **解法**：用户愿意尝试但要求安全校验（病毒检查/沙箱隔离）；GitHub ★0 钓鱼仓库要识别并拒绝
- **时间**：2026-08-07 | 来源：用户偏好

## ⚠️ 例会发言任务卡死：buildDailyPrompt 拼主任务头致递归并发（2026-08-09）

- **场景**：每日例会发言任务（copywriting/hermes/learning-officer 等），日志 20 分钟未更新疑似卡死
- **错误**：例会协调进程 code=1 退出，多个智能体发言文件被污染成多 persona，pi spawn 空转；08-09 例会 3 智能体 .FAILED
- **根因**：`lib/daily-meeting.js` 的 `buildDailyPrompt` 把**整个主任务文件全文**（含 `type: daily-meeting` 头）当 body 拼进每个发言任务；butler `parseTask` 在前 15 行窗口内误判发言任务为 daily-meeting 主协调器 → 对 6 个发言任务名各启动一个协调器 → 8 个协调器并发写同一发言文件（Windows 无文件锁）→ 文件被拼接成多 persona 污染，pi 逻辑混乱空转
- **解法**：①`daily-meeting.js` 新增 `stripTaskHeader(content)`，剥离前 15 行 `key: value` 头只留正文，`buildDailyPrompt` 改传剥头后的内容；②`butler.js` 对带后缀的例会子任务名（`daily-meeting-...-<agent>`）拒绝进协调器（防递归双保险）
- **验证**：报告 `artifacts/meeting-stall-diagnosis.md`；修复后 08-10/11 例会全员汇报正常（不再出现整组卡死）
- **时间**：2026-08-09 | 踩坑者：learning-officer/copywriting/hermes（night-worker 定位修复）
- **检测点**：改动 daily-meeting.js / butler.js 后必须重启管家并跑一次真实例会；出现"同一发言文件被多 persona 拼接"或某智能体日志长时间不更新即中此坑

## ⚠️ 失败判定机制体系化（2026-08-11 例会，全集群最高频故障族）

- **场景**：任务 FAILED 后，auto-optimize 反复「换执行者/任务拆小」自动重派，产生海量 `-improve` 补验；当日 94 条任务复盘里约一半是补验，85 条待办改进项几乎全是 auto-optimize 自动「换执行者」噪音
- **错误**：把**基础设施故障**（孤儿进程残留/PID 残留/软超时/渠道空回复/429）误判为**业务失败**，于是机械重跑/换人/补验，浪费大量算力且制造决策噪音
- **根因**：失败判定只认「FAILED 标记」，不区分失败类型；auto-optimize 缺「源任务已由 -improve 闭环」识别；验收层不看源 .DONE 是否存在就基于旧失败状态判「需重派」
- **解法**：① 区分失败类型——基础设施类（孤儿进程/PID/软超时/渠道空回复）不应触发业务重跑；② orphan-cleanup/soft-timeout 已兜底，仍需「进程异常退出自动重派/补 DONE」；③ auto-optimize 识别「源任务已有 .DONE 或已由 -improve 覆盖」即不再建议换执行者；④ 验收层优先核实源 .DONE 存在即判成功
- **关键教训「重跑成功 ≠ 根因消除」**：cnb-usage-restore 软超时被后续「重跑成功」掩盖，看似恢复实际根因未除；补验必须独立核验根因（实例数/进程残留/环境自愈）而非只看本次是否 .DONE
- **时间**：2026-08-11 | 踩坑者：全集群（learning-officer 复盘归纳）
- **检测点**：① 某任务 FAILED 后出现连环 `-improve` 补验 → 先判失败类型；② 同一坑被 auto-optimize 反复「换执行者」≥2 次 → 停，排查根因；③ 复盘材料 85 条待办改进项若几乎全是自动「换执行者」→ 命中此坑

---

## 🧯 基础设施故障族分型（2026-08-11，全集群最高频失败根因，规避手册）

> 本族是把「基础设施故障」误判成「业务失败」的根本成因。判定一条 FAILED 任务时，**先对号入座分型**，只有确认属业务失败才触发重跑/换人/补验；基础设施类失败不该产生海量 `-improve` 补验。

### A. 孤儿进程残留（最常见，约占本族一半）
- **场景**：任务进程（SSH/子 agent/脚本）在 `.DONE` 写入前异常退出，进程残留、PID 残留
- **错误**：任务显示 FAILED（`进程死于 DONE 写入前`），实际产出物可能已生成；auto-optimize 据此反复换执行者
- **根因**：父 SSH 断开后子进程成孤儿继续跑；看门狗超时优雅退出；PID 文件残留未被清理
- **解法**：① 动手前先数实例 `ps -o pid,lstart,args -C <proc>`（生成前后都查，别只看 `systemctl is-active`）；② 清理孤儿**必须按 PID `kill -9`**，禁用 `pkill -f`（会匹配自己这条 shell 的 cmdline 把自己杀掉，需转义 `[P]roc`）；③ 调度层加「进程异常退出自动重派/补 DONE」兜底（orphan-cleanup 已落地，但要看报 DONE 前是否真正落盘产出）；④ 校验产出物实际存在再判成功
- **时间**：2026-08-07/11 | 踩坑者：server-admin / 全集群
- **检测点**：FAILED 原因含「进程异常中断/PID 残留/死于 DONE 写入前」→ 判为孤儿进程，先核产出物再决定是否重派

### B. 软超时误杀（活动任务被强杀）
- **场景**：HK/CNB 桥接任务、长编码任务，固定硬超时到点被强杀
- **错误**：远端日志仍在活跃推进，却因超时被 SIGTERM 杀死 → FAILED 但工作其实没坏
- **根因**：硬超时只看墙钟，不感知远端进度
- **解法**：改用**软超时**——远端日志活跃则续期不杀，仅日志长期静止才强杀；超时后重跑前先核远端是否已推进（避免重复执行）
- **时间**：2026-08-11 | 踩坑者：night-worker（soft-timeout 已落地）
- **检测点**：任务因超时 FAILED 但远端有最近日志更新 → 软超时未生效或配置过短

### C. 误判重派（源已闭环仍重派）
- **场景**：源任务 `.DONE` 已存在 / 已由 `-improve` 闭环，验收层仍基于旧 FAILED 状态判「需重派」
- **错误**：同一件事被重复执行 N 次（如 ask-video-prod 源 .DONE 已存在仍被重派），浪费算力
- **根因**：验收层/auto-optimize 只认「FAILED 标记」，不核实源 `.DONE` 是否已生成、`-improve` 是否已覆盖
- **解法**：① 验收层**优先核实源 `.DONE` 存在即判成功**，不机械基于旧失败状态重派；② auto-optimize 识别「源任务已有 .DONE 或已由 -improve 覆盖」即不再建议换执行者；③ 复盘改进项去重——同一源任务的多条 pending 建议合并
- **时间**：2026-08-11 | 踩坑者：coo / copywriting
- **检测点**：出现连环 `-improve` 补验 / 复盘改进项几乎全是「换执行者」→ 命中此坑

### D. 渠道空回复 / 通道故障伪装成失败
- **场景**：模型渠道故障（aliyun 429、xxsx 502、opencode-go 超时/terminated、代理 TLS 出口挂）
- **错误**：任务因渠道无响应/空回复/terminated 显示 FAILED，被误判为业务失败去重跑或换人
- **根因**：失败判定没区分「渠道不可用」与「任务本身失败」
- **解法**：① 先看渠道健康表/实测（`curl` 验活）再判失败类型；② 渠道类失败走退避重试或换渠道，**不触发业务重跑**；③ 空回复（返回成功但 body 空）也要视为渠道故障特征
- **时间**：2026-08-05/11 | 踩坑者：night-worker
- **检测点**：FAILED 且日志含 429/502/timeout/terminated/空响应 → 渠道问题，先修渠道

### E. 关键铁律「重跑成功 ≠ 根因消除」
- **场景**：cnb-usage-restore 软超时后「重跑成功」看似恢复
- **错误**：本次 .DONE 了，但根因（实例数异常/进程残留/环境被回收）未除，后续复发
- **根因**：把「本次跑通」当成「根因已消除」
- **解法**：补验必须**独立核验根因**（实例数/进程残留/环境自愈/存储归档持久性），而非只看本次是否 .DONE
- **时间**：2026-08-11 | 踩坑者：全集群
- **检测点**：同一任务反复软超时/FAILED → 停，查根因而非继续重跑

## 2026-08-13 00:5x 弹窗排查（cnb-keepalive 残留）
**现象**：终端窗口周期弹（蓝屏重启后更频繁）。
**根因链**：org-cnb-keepalive 计划任务（唯一没 -WindowStyle Hidden）→ 禁了计划任务但 **--loop 进程没杀**（常驻残留）→ 周期 spawn 继续弹。
**排查路径**（可复用）：①现场抓 conhost 父链（Get-CimInstance Win32_Process 查 conhost 父进程→命令行）②计划任务动作对比（schtasks /xml——找缺 -WindowStyle Hidden 的）③查进程残留（keepalive/该退役的常驻）。
**教训**：**组件退役=清理三件套**（计划任务禁用 + 常驻进程杀掉 + 文件/引用标注）——"策略上弃用"不等于"跑着的还活着"；新计划任务必须带 -WindowStyle Hidden（8/9 规范——检查漏网）。

## 2026-08-13 02:1x 弹窗第二轮（双管家并存）
**现象**：杀 keepalive 后仍弹——"就在你执行的时候"。
**根因**：**双管家并存**——旧管家 31276（旧代码——无 windowsHide 补丁）+ 新管家 31336（watchdog 蓝屏后拉的——新代码）——watchdog 检测到"有管家活着"就不管旧的——**旧管家继续起任务→每次起任务弹窗**（旧代码 spawn 无隐藏）。
**排查路径**：conhost 父链抓到"conhost ← cnb-task ← butler"——但 butler 有两个 PID（31276 旧/31336 新）——杀旧的即止。
**教训**：**管家必须单例**（watchdog 拉起前先杀旧管家——检查"多个 butler.js 进程"告警）；补丁要 git 提交（git-sync auto-commit 已做——防还原）。
