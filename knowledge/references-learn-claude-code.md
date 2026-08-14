# 参考：learn-claude-code（shareAI-lab/learn-claude-code，MIT）— Harness 工程最佳实践

> 2026-08-11 学习记录。核心命题：**Agency（智能）= 模型（训练出来的）+ Harness（代码造出来的环境）**。
> "模型是司机，harness 是车。别想着编造智能，要造好智能栖居的世界。"
> 20 节课 s01-s20，每节往一个 agent loop 上叠一层机制。对我们的框架（butler/orchestrator/learning-officer）直接可抄。

## 一、核心思想（可抄进框架的底层信念）

1. **模型决定，harness 执行**。Agent Loop 恒定不变（messages ↔ LLM ↔ tool_use ↔ tool_result），harness 只负责给工具/知识/上下文/权限。
2. **别堆规则树**：靠 if-else/node graph/提示词瀑布硬造"自主行为"是 shell script 装大尾巴。真自主来自模型训练，harness 只提供 action space。
3. **Agent = Model + (Tools + Knowledge + Observation + Action + Permissions)**。

## 二、最值得抄的 8 个机制（⭐⭐⭐ 与虚无框架强相关）

### 1. 上下文压缩四层管线（s08）— 我们刚踩过 353K 上下文被杀 2 次的坑
**顺序不能换**（便宜的先跑、贵的后跑，budget 必须先于 micro）：
- **L1 snip_compact**：消息 >50 条 → 保头 3 条 + 尾 47 条，中间裁掉。边界保护：不能拆开 `assistant(tool_use)` + 紧随的 `user(tool_result)` 配对。
- **L2 micro_compact**：只保留最近 3 条 `tool_result` 全文，更旧的替换为 `[Earlier tool result compacted]`（内容>120 字符才动）。
- **L3 tool_result_budget**：最后一条 user 消息所有 tool_result >200KB → 从最大的开始落盘到 `.task_outputs/`，上下文只留 `<persisted-output>` 标记 + 前 2000 字符预览。
- **L4 compact_history（LLM 摘要）**：前三层仍超阈值 → 先存 transcript（JSONL，可恢复），再 LLM 摘要（保留目标/发现/已改文件/剩余工作/用户约束），替换整段历史。熔断：连续失败 3 次停止。
- **应急 reactive_compact**：API 返回 413 prompt_too_long → 激进触发，保最近 5 条原始消息，只摘要更早历史。重试上限 1 次。

> 落地：我们的 butler 读大文件（jsonl/日志）被杀——应该先预算落盘（大输出写磁盘不塞上下文）+ 会话压缩（旧 tool_result 占位）。这正好解决"上下文管理铁律"里被杀的根因。

### 2. 记忆四类 + 文件索引（s09）— 与 claude-mem/gbrain 互补
- 每记忆一个 `.md`，YAML frontmatter（name/description/type），`.memory/` 目录 + `MEMORY.md` 索引（一行一链接）注入 SYSTEM prompt（可被 prompt cache 缓存）。
- 内容**按需注入**当前 user turn（按 filename/description 匹配），不破坏 cache。
- **四类记忆**：`user`（你是谁）/ `feedback`（怎么做事）/ `project`（正在发生什么）/ `reference`（东西在哪找）。
- 写入 = 每轮结束后的**提取器**（用户显式说"记住"或表达稳定偏好时保存）；文件积累定期整理去重。

> 落地：比我们现在的 diary.md 全文读更省。可在 MEMORY.md 加索引，内容按需加载。

### 3. Skill 两层按需加载（s07）— 我们已有 skill 机制可对标
- L1 目录：启动时扫描 skills/ 注入 SYSTEM（~100 token/skill，每轮都带）。
- L2 内容：Agent 调 `load_skill` 时才注入（~2000 token/skill，按需）。用 tool_result 注入，不塞 system prompt。
- SKILL.md 可指引后续 read_file/bash 按需访问额外资源。

### 4. System Prompt 运行时组装（s10）
- 把硬编码 SYSTEM 拆成独立 section（identity / tools / workspace / context / memory...），运行时按真实状态拼接，缓存结果。
- 稳定部分保持不动以命中 prompt cache；动态部分（相关记忆、已启用工具）按需拼。

### 5. 错误恢复策略（s11）
- 重试、腾地方（压缩）、换路（token 升级 / fallback model）。失败不是终点，是重试的起点。

### 6. 文件收件箱 + 队友线程（s15 Agent Teams）— 与我们 hub/inbox 完全同构
- **MessageBus = 文件收件箱**：每 Agent 一个 `.jsonl` 邮箱，发消息=append 一行 JSON，读消息=读文件+删除（消费式）。真实 CC 加 `proper-lockfile` 防并发写冲突（我们但ler 也该防）。
- 队友 vs 子 agent：队友多轮 + 异步收件箱随时通信；子 agent 一次性只回结论。
- 我们的 hub/inbox/pending-main.jsonl 已是这个模式——对照补：消费式读（读后删）+ 文件锁 + shutdown_request 协议。

### 7. 自治看板自认领（s17 Autonomous）— 与我们"智能体自己看板"目标一致
- **三阶段生命周期**：WORK → IDLE → SHUTDOWN。
- **IDLE**：每 5s 轮询 inbox（优先，可能含 shutdown_request）+ 扫描任务看板；60s 超时。
- **scan_unclaimed_tasks**：pending + 无 owner + 所有 blockedBy 依赖已完成（can_start）。
- **claim_task**：检查 status/owner/can_start 再认领（防后写覆盖）；真实 CC 用文件锁 + read-modify-write 原子操作。
- **外层 while True**：WORK/IDLE 交替直到超时或收到关机请求 → 发 summary 给 Lead。

> 落地：这正对我们"自我繁衍 + 自主认领 + 不靠主会话逐条指挥"。任务系统（TaskRecord/blockedBy 依赖图）是我们 task-system 的蓝图。

### 8. Task 系统 + 依赖图（s12）+ Worktree 隔离（s18）
- 任务持久化到磁盘，`blockedBy` 依赖图决定 can_start，为多 agent 协调打底。
- 每个 worker 用 worktree 隔离目录，任务绑定目录，无干扰、无孤儿编辑。

## 三、可抄进虚无框架的落地优先级清单
| 优先级 | 机制 | 对应我们痛点 |
|---|---|---|
| P0 | 上下文四层压缩（预算落盘 + 占位） | 353K 被杀 2 次（已立铁律，但需机制化） |
| P0 | 文件收件箱加文件锁 + 消费式读 | hub/inbox 并发写冲突风险 |
| P1 | 记忆四类 + 索引按需加载 | diary.md 全文读费 token |
| P1 | 任务依赖图（blockedBy/can_start） | 任务拆分的调度基础 |
| P2 | Skill 目录/内容两层 | 现有 skill 已接近，可补"按需注入" |
| P2 | WORK→IDLE→SHUTDOWN 自治循环 | 智能体自组织目标 |

## 学习来源
- https://github.com/shareAI-lab/learn-claude-code（MIT，保留 LICENSE）
- 20 课结构：s01 agent loop / s02 tool use / s03 permission / s04 hooks / s05 todo / s06 subagent / s07 skill / s08 context compact / s09 memory / s10 system prompt / s11 error recovery / s12 task / s13 background / s14 cron / s15 teams / s16 protocols / s17 autonomous / s18 worktree / s19 MCP / s20 comprehensive
- 姊妹项目：claw0（heartbeat+cron+IM+memory+soul 常驻助手）、Kode-CLI、kode-agent-sdk
