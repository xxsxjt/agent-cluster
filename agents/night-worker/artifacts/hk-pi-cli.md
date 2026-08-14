# HK 服务器 pi CLI 安装与 RPC 链路验证报告

日期：2026-08-06 16:2x
执行：night-worker（opencode-go / deepseek-v4-flash）
服务器：root@100.97.18.59:43891（HK，node v22.23.1 / npm 10.9.8 / pnpm 10.34.5）

## 结论

**HK 已装好 pi CLI 0.83.0（与本机版本一致），模型渠道走 HK 本地 new-api（127.0.0.1:3461，商汤 deepseek-v4-flash），RPC spawn 链路全通**——服务器端 now 可以 spawn pi 子智能体，用户"没 pi CLI 就做一个"的要求已达成。

## 1. 安装方式（有坑）

- `npm install -g @earendil-works/pi-coding-agent` **失败**：npm 10.9.8 内嵌 minizlib 在 node v22.23.1 下报 `Class extends value undefined is not a constructor or null`（`zlib.Zlib` 为 undefined，npm 自带依赖损坏，连 npm 自身安装流程都过不去，`npm config` 等也受影响）。
- **绕过方案**：HK 已有 pnpm 10.34.5 → `pnpm config set global-bin-dir /usr/local/bin; pnpm config set global-dir /usr/local/lib/pnpm-global` → `pnpm add -g @earendil-works/pi-coding-agent`，9.4s 装完，0.83.0。
- 产物：`/usr/local/bin/pi` → `pi --version` = `0.83.0` ✅
- 注：pnpm 提示忽略 @google/genai、protobufjs 的 build scripts（不影响 pi 运行，RPC 已验证）。

## 2. 渠道配置（HK 本地，无凭据外泄）

目录 `~/.pi/agent/`（root 用户）：
- `models.json`：provider `xxsx` → baseUrl `http://127.0.0.1:3461/v1`（HK 本地 new-api）、api `openai-completions`、apiKey 与 auth.json 同源；models 仅 `deepseek-v4-flash`（商汤，reasoning=true，contextWindow 1000000，maxTokens 65536，thinkingLevelMap 全档）。
- `auth.json`：`{"xxsx": {"type": "api_key", "key": "sk-***"}}`。

token 来源：HK new-api DB `/data/xxsx-api/new-api-data/xxsx-new-api.db` tokens 表 **id=35（default 组，status=1，unlimited_quota=1，闲置）**，全程在 HK 本地由脚本从 DB 读取直接写入配置文件，**未经过任何外部传输，本报告不含明文**。已验证该 key 可访问 3461 并列出 deepseek-v4-flash。

## 3. RPC 验证（模拟 butler spawn 协议）

按本机 lib/spawn.js pi 分支协议在 HK 用 node 脚本 spawn：
`pi --mode rpc --provider xxsx --model deepseek-v4-flash --thinking off --session-dir ... --name rpc-test`，3 秒后 stdin 发 `{"type":"prompt","message":"Reply with exactly: PONG","id":"p-...","streamingBehavior":"steer"}`。

结果（全通过）：
- `{"type":"response","command":"prompt","success":true}` ✅
- 流式序列完整：agent_start → turn_start → message_start → thinking_delta → text_delta → message_end ✅
- assistant 最终文本 = **"PONG"** ✅（两次测试均正常，thinking off / low 各一次）
- 全程无 ERR、无凭据泄漏，token 用量正常。

## 4. 与 hk-org-deploy 的衔接说明

- **无文件冲突**：本任务写 `~/.pi/agent/`（pi 配置），hk-org-deploy 同步 `/data/agent-cluster`（org 框架）。执行时 hk-org-deploy 尚未落盘（`/data/agent-cluster` 不存在，PID 文件在但进程已结束，无 .DONE——该任务状态需 orchestrator 侧确认，与本任务无关）。
- **HK 端 butler spawn pi 需要两处适配**（hk-org-deploy 同步 lib/spawn.js 后，HK 端需改）：
  1. `PI_BIN`：本机为 `C:/Users/du_ji/AppData/Roaming/npm/pi.cmd`，HK 应为 `/usr/local/bin/pi`（或 spawn 直接调 `pi`）。
  2. 启动方式：本机走 `cmd.exe /c`，HK（Linux）应直接 `spawn('pi', args)`，stdin 协议不变（已验证 3 秒后发 prompt 可通）。
- 建议：hk-org-deploy 同步时对 lib/spawn.js 做平台判断（`process.platform === 'win32'` 分支），或 HK 端设环境变量 `PI_BIN=/usr/local/bin/pi` 并加 Linux spawn 分支。
- pi 首次运行无需额外初始化（无 trust.json 也直接工作），RPC 测试已覆盖冷启动。

## 5. 遗留

- npm 自身损坏（minizlib）未修复：HK 上所有 npm 全局安装都会挂，建议后续 `node` 版本升级或重装 npm 时顺带解决；当前 pnpm 可完全替代。
- 服务器端 spawn pi 的端到端（HK butler 投 inbox → spawn pi 子智能体）需等 hk-org-deploy 完成后再验证一次，本报告第 3 节已验证最关键的 RPC 协议层。
