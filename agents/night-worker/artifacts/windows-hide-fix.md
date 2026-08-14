# windows-hide-fix 完善报告（重跑 + 补验）

日期：2026-08-08 21:07 | 执行：night-worker | 任务：`windows-hide-fix-improve`

## 一、源任务失败原因查明

源任务 `windows-hide-fix` 标记 `.FAILED: agent_settled 后进程未退出（空转超时，已强制结束）`——
即子 agent 完成思考后进程未自行退出，被监管超时强制结束，**修复本身实际未落地**。

排查验证（本次重跑时的真实代码状态）：
- `org/scripts/hk-task.js` line 58(`execFile('ssh')`) / line 73(`execFile('scp')`)：**缺 `windowsHide`**
- `org/scripts/hk-alert.js` line 76(`execFile('ssh')`)：**缺 `windowsHide`**
- `org/scripts/dual-sync.js` line 62(`execFile('ssh')`) / line 73(`execFile('scp')`)：**缺 `windowsHide`**
- 而 `lib/hermes-run.js`、`lib/spawn.js`、`lib/twin-daemon.js`、`web/server.js`、`hub/*.js` 已带 `windowsHide:true`

结论：用户反馈的"很多 scp.exe 弹窗闪一下"，根因正是上述三文件 ssh/scp 调用未设 `windowsHide:true`，
源任务因进程空转超时被强杀而未完成修复。

## 二、改动清单（只改 spawn 选项，不改业务逻辑）

### 1. 新增兜底 helper：`org/lib/win-spawn.js`（新建）
- 包装 `execFile / execFileSync / spawn / spawnSync`，在 **win32 且调用方未显式指定**时默认注入 `windowsHide:true`
- 显式 `windowsHide:false` 仍保留（不改业务逻辑）；非 Windows 无副作用
- 头部注释写明约定：**所有可能弹窗的外部进程调用（ssh/scp/rsync/cloudflared/powershell 等）一律走本模块**，新代码默认隐藏
- 签名与 Node `child_process` 完全一致，可无缝替换 import

### 2. 三个根因文件接入 helper（导入替换，调用体不变）
| 文件 | 原导入 | 改后 | 覆盖调用 |
|------|--------|------|----------|
| `scripts/hk-task.js` | `require('child_process')` | `require('../lib/win-spawn')` | `execFile('ssh')`、`execFile('scp')` |
| `scripts/hk-alert.js` | `require('child_process')` | `require('../lib/win-spawn')` | `execFile('ssh')` |
| `scripts/dual-sync.js` | `require('child_process')` | `require('../lib/win-spawn')` | `execFile('ssh')`、`execFile('scp')` |

- 每个文件均在导入处加了注释："Windows 下 ssh/scp 弹窗闪现修复：改走 win-spawn 兜底（默认 windowsHide:true），见 lib/win-spawn.js"
- 各文件仅用到 `execFile`（hk-task 的 `execFileSync` 未实际调用），导入替换零破坏

## 三、全仓扫描结果（覆盖 org/scripts、org/lib、org/web、hub 源码）

修复后所有含 ssh/scp/rsync/cloudflared spawn 的 Windows 相关调用均带 `windowsHide`：
- `dual-sync.js` / `hk-alert.js` / `hk-task.js` → 走 win-spawn helper ✅
- `lib/hermes-run.js`（ssh 2 处）、`lib/spawn.js`（4 处）→ 原本已带 ✅
- `web/server.js`（5 处）、`hub/butler-daemon.js`（4 处）、`hub/orchestrator.js`（6 处）→ 原本已带 ✅
- `bootstrap.js` 的 `systemctl` 等调用是 Linux 无窗分支（`isWin` false），无需 windowsHide ✅
- `org-watchdog.ps1` / `verify-notify-tier.js` / `lib/meeting.js` → 无 ssh/scp spawn 调用 ✅

## 四、验证证据

1. **语法检查**：`node --check` 通过 lib/win-spawn.js + 三个改动文件
2. **helper 行为单测**：
   - 未指定时注入 `windowsHide=true` ✅
   - 显式 `windowsHide:false` 保留为 false（不改业务逻辑）✅
3. **真实 SSH 连通（走 win-spawn helper）**：对 HK（100.97.18.59:43891）执行 `echo hk-ok-$(hostname)`，
   成功返回 `hk-ok-twjnrahg6gsg` + uptime —— 证明导入改动未破坏 ssh 功能，且调用全程走 `windowsHide:true`
4. **hk-task 桥投递 E2E**：任务成功投递到 HK（🚀 已投递 /data/agent-cluster/inbox/），
   桥的 ssh/scp 路径正常。HK 侧执行被**既有环境问题**阻塞（HK org 的 opencode-go provider 无 API key，pi 子 agent 无法运行）——与本任务无关，非本任务修复范围
5. **全仓复查**：确认无遗漏的无 `windowsHide` 的 scp/ssh/rsync/cloudflared spawn 调用

## 五、结论

用户反馈的"scp.exe 弹窗闪现"已修复：所有 Windows 下 ssh/scp 子进程调用现默认隐藏窗口，
并提供 `lib/win-spawn.js` 兜底约定保证后续新代码默认隐藏。改动仅限 spawn 选项，业务逻辑零改动。
