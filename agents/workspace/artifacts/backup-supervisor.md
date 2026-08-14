# 备用监督者机制（backup-supervisor）落地

> 执行：workspace（night-worker 域）| 2026-08-12 夜 | 任务：backup-supervisor
> 背景：用户 2026-08-12 21:4x 对话——通知全发给用户"真这样干我还是要累死"；第一版设计（hub orchestrator+supervisor 双进程）org 未移植："留一个备用的看着正在干活的；死机了→尝试修复→再分一个备用看着（监督者自身也要有人看）"。

## 一、现状盘点（动手前查证）

| 现有监督 | 机制 | 缺口 |
|---|---|---|
| `pi-org-watchdog`（schtasks 10min） | butler.pid+tasklist 判进程死 → bootstrap start 重启 | 只看进程死，不看卡死；本身无人看（靠 schtasks 系统级） |
| `lib/twin-daemon.js` scanButlerKeepalive（分身常驻，5min 巡查） | 进程死 + butler.log 停滞>10min 判卡死 → 死因快照 → bootstrap start → 防反复（5min 3 次→写 plan 升级） | 看管家但不看"监督者自身"；修复成功无"再分备用"；升级只写 plan 文件不通知用户 |
| `lib/task-watchdog.js` / `agent-rescue.js` | 看任务级卡死/互救 | 非监督者级 |

**用户 21:4x 设计的三点，org 全部未实现**：①备用监督者（监督者自身也要有人看）②死机→修复→再分一个备用 ③通知分流（日常失败/重启不通知，处理失败才通知）。

## 二、实现（双层看护 + 通知分流）

新增文件：
- `org/scripts/backup-supervisor.js` — 主脚本（L1 默认模式 / `--l2` 备用模式 / `--check` 只读 / `--root` 沙箱）
- `org/config/backup-supervisor.json` — 配置（改即生效，每轮重读）
- `org/scripts/backup-supervisor-l1.ps1` / `-l2.ps1` — schtasks 隐藏窗口包装
- `org/scripts/hk-alert.js` — 新增 `--supervisor <标题> <消息>` 升级通知通道（kind=supervisor_alert，APP 通知）
- 计划任务：`pi-org-backup-supervisor`（每 6min）、`pi-org-backup-supervisor-l2`（每 6min 错开 3min）

### 架构（三层）

```
L0 系统级：pi-org-watchdog（已有）          —— butler 进程死 → bootstrap 重启
L1 备用监督者（每 6min）                    —— 看管家：进程死/日志停滞 → 死因快照 → bootstrap start
                                             —— 修复成功 → 再分一个备用（查 L2 心跳，过期补拉起）
                                             —— 修复失败/30min 内反复 ≥3 次 → 通知用户（APP）
L2 备用监督者（每 6min 错开 3min，看 L1）    —— L1 心跳过期 → 判定 L1 死 → 补拉起 L1 一轮 + 接管管家检查修复
```

- **管家心跳**：`logs/butler.log` mtime（butler 每 15~60s 写一次，实测最大间隔 137s；>10min 判死/卡死——与 twin-daemon 判据一致）
- **L1/L2 心跳**：`logs/supervisor-l1.heartbeat` / `supervisor-l2.heartbeat`（每轮写 pid+ts）
- **修复链**：死因快照（butler.log 尾部 20 行 → `logs/supervisor-crash-<ts>.log`）→ `bootstrap.js start`（幂等）→ 等 30s 复查 → 成功记录 / 失败重试（默认 2 次）→ 仍失败通知用户
- **防反复**：`logs/supervisor-fix-state.json` 记录窗口内修复次数（默认 30min 内 ≥3 次 → 停止自动修复 + 通知用户，通知节流 30min 一条防刷屏）
- **事件留痕**：`logs/supervisor-fix-events.jsonl`（fixed / fix-failed / respwan-l2 / l1-dead / exhausted / l2-fixed / l2-fix-failed）
- **审计**：`logs/supervisor.log`

### 通知分流（用户无感原则）

- ✅ 管家死机被自动修复 → **不通知**（只写日志+事件文件）——用户无感
- ✅ 备用监督在场巡检、再分备用 → **不通知**
- 🚨 修复失败（重试耗尽）/ 30min 内反复失败 ≥3 次 → **才通知用户**（hk-alert.js --supervisor → APP 通知 kind=supervisor_alert，30min 去重）

## 三、验证（沙箱模拟 + 真实运行，均通过）

沙箱：mock bootstrap（记录调用+spawn 90s 存活"管家"）+ mock hk-alert（记录通知）+ 假 pidfile/旧日志。`--root` 隔离，全程未碰真实管家。

| 场景 | 预期 | 结果 |
|---|---|---|
| A. 管家死机（PID 999999） | L1 检测→bootstrap start→复查成功→再分备用→用户无感 | ✅ fixed+respwan-l2 事件，L2 心跳出现，mock-alert 空 |
| B. 管家卡死（进程活但日志 10min 停滞） | 判"疑似卡死"→修复成功 | ✅ reason="疑似卡死（butler.log 10 分钟未更新）" |
| C. L1 死机（心跳过期） | L2 判 l1-dead→补拉起 L1+接管管家检查 | ✅ l1-dead 事件 + L2 心跳写入 |
| D. 修复失败（mock bootstrap 永远失败） | 重试耗尽→通知用户 | ✅ fix-failed + mock-alert 收到 --supervisor 通知 |
| E. 防反复（30min 内 ≥3 次） | 停止自动修复→exhausted→通知（节流） | ✅ 第 2 轮 exhausted，通知仅 1 条 |
| F. 真实运行 | L1/L2 计划任务跑通、管家正常→待机、无弹窗 | ✅ 0:11/0:14 心跳落地，日志"待机"，窗口残留检测 0 |

## 四、与既有机制的关系

- 不替代 twin-daemon 保活（它更快 5min 且带分身接管），补的是**监督者自身被看 + 再分备用 + 通知分流**
- 不替代 org-watchdog（L0 系统级兜底），三层叠加互不冲突（bootstrap start 幂等防双启）
- 修改 hk-alert.js 仅新增 `--supervisor` 分支，不动既有 done/failed/quota 通道

## 五、后续建议（未做，留给 night-worker/框架开发评估）

1. **监督者自愈闭环补强**：L2 也死了且 schtasks 被禁用的极端场景，暂无第四层——可考虑把 L1/L2 心跳纳入 twin-daemon 巡检（它是唯一不看监督者的现有常驻）
2. **管家心跳显式化**：butler.js 主循环加显式 heartbeat 写（当前用 butler.log mtime 间接判，已足够可靠但显式更稳）
3. **监督者配置可面板化**：config/backup-supervisor.json 可在 hub 面板加只读展示

## 六、过程异常与处理

- **沙箱 PID 判定坑**：Git Bash `sleep &` 的 $! 是 msys 层 PID，node 的 process.kill 判定为死——改用 node spawn detached 拿真实 Windows PID 后场景 B 通过（验证方法问题，非脚本 bug）
- **再分备用竞态**：spawnSelf 最初用相对路径 --root，子进程 cwd 已切沙箱导致路径错位、L2 心跳不落地——改传绝对 ORG_ROOT 后修复（已复测通过）
- 修复后对真管家仅跑只读 --check 与待机轮，**未实际杀/重启真实管家**（当前有任务在跑，避免中断）；修复链路全部沙箱模拟验证
