# 参考：oh-my-pi（can1357/oh-my-pi，MIT）— 增强版 pi（omp）

> 2026-08-11 学习记录。pi-mono 的 fork（作者 Can Bölük），"A coding agent with the IDE wired in"。
> 60+ providers · 31 内置工具 · 14 LSP ops · 28 DAP ops · ~80k 行 Rust 核心。MIT（© Mario Zechner / Can Bölük）。
> 定位：不是抄它的代码（太大），而是借鉴**前端/协议/加密/多代理**四个维度的设计理念。

## 一、核心设计哲学
- **一切工具同命名空间**：read/bash/edit/task 全部一个 namespace，GitHub 也是"filesystem"（PR 是路径）。
- **本地原生实现**：把 rg/grep/glob/find/bash 链接进进程（Rust），不 shell out（省 fork-exec 往返），Windows/macOS/Linux 同一二进制无 WSL 桥。
- **模型只是驱动**：跟 learn-claude-code 同哲学——模型决定，harness 执行；prompt 按模型反复调（"Edits that land on first attempt"）。

## 二、最值得借鉴的 4 个维度（⭐⭐⭐）

### 1. 加密 / 密钥混淆（docs/secrets.md）— 对隐私铁律有用
**Secret Obfuscation**：防止 API key/token/密码被发给 LLM provider。
- 启用后，configured secrets + 内置"凭据形状"token 模式在 provider-visible 文本离开进程前替换。
- 收集来源：环境变量（KEY/SECRET/TOKEN/PASSWORD/AUTH/CREDENTIAL/PRIVATE/OAUTH 命名的，值≥8 字符）+ `secrets.yml` + 内置 GitHub/GitLab/OpenAI 风格 token regex。
- 替换为确定性占位符 `$$3P8W5JH1TK2Q$$`。
- **工具参数深走查**：模型写的 tool arguments 在执行前把占位符还原（否则工具收不到真值）；session 本地显示/resume 再还原、provider replay 再混淆。
- 两种模式：`obfuscate`（可逆占位，默认）/ `replace`（替换成配置值或等长随机，单向）。
- 短于 8 字符忽略（避免把普通词误伤）。

> 落地：我们有隐私数据隔离铁律（微信/身份数据只走 deepseek 官方）。omp 这种"进 provider 前混淆、执行时还原"可移植到我们路由——把敏感字段在发给第三方模型前混淆。

### 2. 多代理 / Agent Hub（docs/agent-hub.md + task 工具）— 对集群指挥有用
- **task 工具**：fan out 并行子 agent，每个跑独立 worktree + 自己的工具面，返回 **schema-validated 对象**（不是散文，父 agent 直接读字段）。无合并冲突、无孤儿编辑。
- **Agent Hub（Alt+A）**：实时看子 agent roster——状态（running/idle/parked/aborted）、模型 role、活动/成本/请求数/tool 数/token；点开读 live transcript、发 steering 消息、**revive 停泊 worker、kill 卡住的**（不 abort 父会话）。
- **advisor（第二模型监视）**：配对 reviewer 模型读主 agent 每轮，注入 notes（quiet aside/concern/hard blocker）。跑在自己 context + 自己 model，catch 主 agent 赶路漏掉的。
- **Magic keywords**：`ultrathink` / `orchestrate` / `workflowz` 三个词触发特化行为（并行子 agent 跑大活、确定性多子 agent 工作流）。
- 十个 model role 按意图路由：default/smol/slow/plan/commit/vision/designer/task/advisor/tiny。

> 落地：Agent Hub 的"看 roster + revive + kill + steering"正是我们要的集群看护（对比我们的 hub panel）；advisor 双模型监视可借鉴到"质量门禁/评审"。task 返回 schema 对象比"prose 汇报"强。

### 3. 前端 / TUI 与 ACP（docs/tui.md + 四入口）— 对面板 UI 有参考
- 四个入口：interactive TUI / `omp -p` 一次性 / Node SDK（embed 进程）/ RPC+ACP（stdio 交给别的程序）。
- **collab（/collab）**：把 live session 放 relay，给链接+QR，别人 `omp join` 或浏览器加入。可读可写配对 / `view` 只读。frames 客户端密封，relay 看不到 keys。= 多人实时共操一个 agent。
- **ask 工具**：mid-turn 结构化选项选择器（不是自由文本），歧义路由用。
- 工具调用渲染成卡片，编辑先预览后落地，`ast_edit` 返回 (proposed) 卡片确认后才原子应用。

### 4. 协议 / 能力面（值得参考但不照搬）
- **hashline 编辑**（按内容哈希锚点，不是重打要改的行）→ 省 61% 输出 token，stale anchor 拒绝 patch 防损坏。
- **内部 scheme**（pr:// issue:// agent:// skill:// ssh://）统一解析进每个 FS 形状工具。
- **web_search** 链 23 个 provider。
- **15 格式兼容**：直接读 Cursor MDC / Cline .clinerules / Codex AGENTS.md / Copilot applyTo 等原生形状（不迁移）。

## 三、对我们框架的落地建议（优先级）
| 优先级 | 借鉴点 | 对应价值 |
|---|---|---|
| P0 | **secret obfuscation**（provider 前混淆 + 工具执行前还原） | 隐私隔离铁律机制化 |
| P0 | **Agent Hub 看护**（roster/revive/kill/steering） | 集群指挥/看护对标 |
| P1 | **task 返回 schema 对象**（不是散文汇报） | 子任务结果结构化 |
| P1 | **advisor 双模型评审** | 质量门禁/评审增强 |
| P2 | collab 实时共操 / ACP 编辑驱动 | 多人协作形态 |
| 不抄 | Rust 原生 80k 行实现 | 工程成本过高，我们 node 够用 |

## 注意
- VENDOR-PLAN 原存 scratch/，本次学习时**未在 scratch 找到**（疑似已清理）——本文档即为补齐产出。
- 仓库极大（bazel + 多 packages + 6 rust crates），只读 README + 关键 docs（secrets/agent-hub/collab/tools），未 cat 大文件。

## 学习来源
- https://github.com/can1357/oh-my-pi（MIT，保留 LICENSE）
- 关键文档：docs/secrets.md、docs/agent-hub.md、docs/collab.md、README 21 大特性
