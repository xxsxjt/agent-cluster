# 控制台对话页优化 + 分身在线判定修复

- 任务: console-chat-optimize
- 执行: night-worker (2026-08-09 14:3x)
- 状态: 完成

## 一、分身在线判定修复（web/server.js twinDaemonStatus）

### 根因
web 只查 `twin.pid` 文件的 PID 存活（`kill(pid,0)`），无活性校验。PID 文件与实际进程脱节（进程重启/崩溃未清理旧 PID）就误判「离线」，即使 activity.log 仍在输出。

### 改法（双因子）
`twinDaemonStatus()` 现返回并综合三个活跃信号：
- `pidAlive`：twin.pid 的 PID 是否存活
- `activityFresh`：`agents/twin/activity.log` mtime 距今 < 10 分钟（`TWIN_ACT_FRESH_MS` 可调，默认 600000ms）
- `tcpAlive`：TCP 18788 可连（异步缓存探测，`probeTwinTcp()` 3 秒节流，避免同步 connect 阻塞）

### 判定表
| 场景 | PID | 足迹 | TCP | 结果 |
|---|---|---|---|---|
| 健康 | 活 | 新 | 任意 | 在线 `pid+active` |
| PID 过期但日志活跃 | 死 | 新 | 任意 | 在线（推断）`infer-activity` |
| PID 过期但 TCP 通 | 死 | 旧 | 通 | 在线（推断）`infer-tcp` |
| 僵死 | 活 | 旧 | 不通 | 离线 `zombie` |
| 无信号 | 无 | 旧 | 不通 | 离线 `no-signal` |

返回新增字段：`pidAlive / activityFresh / activityMtime / tcpAlive / inferred / reason`。

### 顺带修（lib/twin-daemon.js）
main() 循环新增 **PID 心跳**（每 60s 重写 `twin.pid = process.pid`），确保重启/进程重派后 PID 文件与当前进程始终同步（配合 web 双因子兜底）。该心跳在分身 daemon 下次自然重启后生效（本次未重启 daemon，避免中断正在进行的巡查/对话）。

## 二、对话页优化（web/index.html + app.js + style.css）

### 1. 对话入口明显化
- 顶部 `.tools` 新增醒目 `💬 对话` 按钮（`openChatTab()`），有会话时带红色活动圆点提示
- 行为：有会话→切到对话；无→优先开分身（twin）会话；分身不可聊→开选择器
- 底部 tabbar「对话」保留；分身 pill 悬浮提示「点击对话」

### 2. 终端级功能
**a. 粘贴/拖入文件 → 自动转路径引用**
- `@paste="onPastePath"`：识别 `C:\..`、`C:/..`、`\\server\..`、`/..`、`./..`、`../..`、`~/..` 路径（含空格），自动包成 `[file:路径]`
- `@drop.prevent` + `@dragover.prevent`：拖入文件插 `[file:文件名]`（浏览器安全限制只能取文件名，完整路径需粘贴）
- `insertAtCursor()` 在光标处插入，多会话共享一个 textarea ref

**b. 模型/渠道/思考等级状态栏（对照终端）**
- `.cv-statusbar` 显示：模型 / 渠道 / 思考等级 /（分身会话额外显示在线判定）/ 上下文
- 数据源：`/api/chat/agents` 返回 `config:{provider,model,thinking}`；分身会话走 `/api/twin/status` 的 `route`（model-router defaultRoute，当前 deepseek-v4-flash / opencode-go / off）

**c. 上下文/会话 token**
- `chatCtxLabel` 显示（无数据为 `—`，数据来自 chatUsage，当前链路未回传 token，预留）

**d. 会话切换/历史**
- 已有多开会话 tab（`chatSessions`）+ `loadChatHistory`，本次保留并接入状态栏元信息刷新（`loadChatMeta()`）

## 三、验证（全链路实测）
| 项 | 结果 |
|---|---|
| server.js / twin-daemon.js / app.js 语法检查 | ✅ 通过 |
| 双因子逻辑单元测试（7 场景） | ✅ ALL PASS |
| 健康状态（PID 活+足迹新+TCP 通） | ✅ running=true pid=26028 |
| PID 过期(99999)+日志活跃 → 显示在线（推断） | ✅ inferred=true reason=infer-activity |
| 活PID+日志停滞30min+TCP通 → 在线（TCP因子） | ✅ 不误判离线 |
| 僵死（PID在+日志停+TCP断）→ 离线 | ✅ 单元测试 zombie |
| 对话入口 `💬 对话` 顶部按钮 | ✅ 渲染 + 点击开分身会话 |
| 状态栏（模型/渠道/思考/分身/上下文） | ✅ deepseek-v4-flash / opencode-go / off / 常驻·PID26028 |
| 粘贴路径自动转 `[file:...]` | ✅ `[file:C:\Users\du_ji\my notes.txt]` |
| 拖入文件自动转引用 | ✅ `[file:报告.pdf] [file:图片 01.png]` |
| web 重启加载 | ✅ 旧 14504→新 37160，twin 判定正常 |

## 四、注意
- 分身判定改动不影响对话链路（twin-daemon 转发逻辑未动，仅 status 判定与 PID 心跳）
- twin.pid 已恢复真实 PID(26028)，activity.log 已刷新，daemon 未受影响
- PID 心跳待分身 daemon 下次自然重启后激活（本次为避免中断巡查未重启）
- 上下文 token 显示为预留位（当前 pi rpc 回复未回传 usage，回传后自动显示）
