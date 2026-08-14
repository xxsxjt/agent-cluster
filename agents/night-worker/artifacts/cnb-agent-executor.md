# CNB 智能体执行器 + side 优先路由（2026-08-12）

> 任务：cnb-agent-executor（night-worker）｜用户诉求："为什么又在本机并发排队，不是让你全部交给服务器吗"——任务全服务器化。
> 现状修复：isRemote 含 side（remote 不占本机名额）——但执行还在本机；本次落地 **CNB pi 智能体执行器** + **routeTask side 优先**。

## 一、改动清单

| 文件 | 改动 |
|---|---|
| `scripts/cnb-exec.js`（CNB 端执行器） | 升级为**双模式**：①含 ```` ```bash/```sh ```` 代码块 → 代码块模式（现有）；②无代码块 → **pi 模式**：任务全文作 prompt 交给 CNB 端 `pi --mode rpc`，按任务头 `agent/provider/model/thinking` 选身份与渠道，agent 身份 persona 取自 org 同步副本 `agents/<id>/identity.json`，执行完按任务指示写 .DONE |
| `scripts/cnb-task.js`（本机桥） | ①自愈版本检测升级：cnb-exec.js 需含 `runPiMode` 标记才视为新版（旧版含 /cnb-org/ 但无 pi 模式 → 强制上传）；②新增 **pi 可信渠道注入**：`/root/.pi/agent/` 缺 auth.json/models.json 时从本机 scp 注入（deepseek 官方/opencode-go 订阅池等）；③settings.json 注入时剥离 Windows 专用 shellPath（防 CNB pi 的 bash 工具指向 hidden-bash.exe 失效） |
| `butler.js` | `routeTask()` 增加 **side 优先**（第 0 步）：`task.side === 'remote'` → 返回 `'cnb'`（不管显式 agent——agent 身份在 CNB 侧）；本机只留显式 local/本机必需。另导出 parseTask/routeTask 供单测 |

## 二、关键坑（RPC 协议实测）

- **pi RPC 模式 stdin `end` 事件 = 立即 shutdown**（0.83/0.84 行为一致）：首版 `child.stdin.end()` 导致 pi 收到 prompt 后 3 秒退出、任务空跑。修复：**不关 stdin**，完成判定改为监听 stdout `"type":"agent_settled"` 事件（一轮完成标志，实测事件流：agent_start → …消息/工具流… → agent_settled），检测后 SIGINT 收尾 + 3s SIGKILL 兜底。
- **prompt 失败检测**：stdout 出现 `"success":false`（模型 preflight 失败）→ 尽早终止并写 .FAILED（防止退出码 0 误报成功）。
- **CNB 实例回收重建**后 /data/cnb-org 与 /root/.pi/agent 全清空：环境镜像恢复（logs/cnb-env/env-image.tar.gz，含 gradle+pi）→ java apt 补装 → 可信渠道注入，全链路自愈已在一次投递中自动完成（18:21→18:24）。

## 三、验证结果（全部通过）

1. **pi 模式智能体任务**（`inbox/cnb-pi-mode-verify.md`，side: remote、无代码块、agent: night-worker / provider: opencode-go / model: deepseek-v4-flash）：
   - CNB exec 日志：`代码块=0（pi 智能体模式）` → `agent=night-worker provider=opencode-go model=deepseek-v4-flash` → 2 分 37 秒真实执行（6:29:30→6:32:07）→ `agent_settled` → pi 自写 .DONE
   - .DONE 内容（pi 亲手写的摘要）：`pi-mode verify OK 2026-08-12: hostname=14011ed1ff4c pi=0.83.0 agents=31 (org.json); bash tool was broken (win shellPath) -> fixed settings.json to /bin/bash...`（pi 甚至自己修复了注入的 shellPath 问题）
2. **代码块模式未回归**：`cnb-blockmode-regression`（含 bash 代码块）→ `blockmode-regression-ok 14011ed1ff4c 18:33` ✅
3. **side 优先路由单测 5/5**：side:remote+显式 agent→cnb；side:remote 无 agent→cnb；side:remote+target:hk→cnb（side 优先于 target）；side:local 显式 agent→本机；无 side 显式 agent→coo
4. **本机零负担**：任务全程在 CNB 执行，本机 CPU 14%（空闲水平）
5. **butler 生效**：运行中但管家（PID 17628，18:11 启动）加载旧代码——已预约 `restart-butler-on-idle.js --max-wait-min 120`（PID 20422）待活动任务收尾后自动重启加载 side 优先路由

## 四、使用方式

任务文件头加 `side: remote` 即强制全服务器化（CNB 执行，agent 身份在 CNB 侧），不带代码块则走 pi 智能体模式；带 ```bash 代码块仍走代码块模式。CNB 端渠道：本机注入的可信配置（deepseek 官方 / opencode-go 订阅池 / aliyun-tokenplan 等，与任务头 provider/model 声明对应）。

## 五、后续建议

- CNB /workspace 的 org git 同步（git-sync）有 8h 延迟（最新 10:06），agent 身份 persona 可能过期——建议在 cnb-task.js 投递时顺带 `git -C /workspace pull` 或 scp 目标 agent 的 identity.json（待排）
- pi 0.83 与 0.84 的 RPC 事件流已实测兼容（agent_settled 判定两个版本一致）
