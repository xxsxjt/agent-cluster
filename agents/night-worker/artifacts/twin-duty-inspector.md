# 分身职责巡检（twin-duty-inspector）落地报告

- 日期：2026-08-09 14:4x
- 执行者：night-worker（框架开发）
- 目标：让分身（twin-daemon 巡查）**主动发现"该干活没干"的智能体并派活**，把已建好的 auto-schedule 机制转起来。

## 背景
用户（2026-08-09 15:4x）："已完成就用起来吧，分身不应该看看哪些智能体应该有活干吗"——auto-schedule（定时职责表，butler 每分钟触发）已就绪，但**分身不主动看"谁该有活"**。建了机制要转起来，分身要主动盯。

## 落地内容

### 1. 新模块 `lib/twin-duty-inspector.js`
分身每轮巡查（5 分钟）增加职责巡检，入口 `scanDuties()`，四类检查：

| 检查 | 逻辑 | 触发 |
|---|---|---|
| **定时职责漏跑兜底** | 读 `config/auto-schedule.json` + state（lastRun）→ 到期没跑（超时窗口）→ 调 `auto-schedule.check()` 触发（其内部幂等，不会重复写任务） | **仅当 butler 离线**（butler 在线则每分钟 auto-schedule 为权威，分身不抢——幂等协调） |
| **智能体闲置检测** | 扫各智能体 activity/identity.createdAt/org.json lastTaskAt → 长期闲置（如 48h）且负有周期性职责 → 该干没干 → 写 inbox 派活 | `config/duty-inspector.json` 的 `idleDuties` 表（learning-officer 48h、pm 168h） |
| **业务信号驱动** | 规则表 + 分身判断：①新任务完成/失败批次 → 审核官验收 ②chat-signals 用户新强信号 → PM 规划 ③chat-signals 新信号 → 学习进化官合并 | 各信号 `businessSignals` 开关 + 独立节流 |
| **防骚扰节流** | 同职责最小派活间隔（`throttleMinutes`，如 reviewer/pm 6h、learning 24h）+ 幂等（在队列/已派过则跳过） | 状态 `logs/twin-duty-state.json` |

### 2. 规则配置 `config/duty-inspector.json`
- `scheduledFallback`：定时职责兜底开关
- `idleThresholdHours` + `idleDuties`：闲置判定与各智能体职责周期
- `throttleMinutes`：同职责派活最小间隔
- `businessSignals`：三个业务信号的开关/窗口/阈值

### 3. 挂入 `lib/twin-daemon.js` `runPatrol()`
巡查循环在渠道健康之后调用 `scanDuties()`，失败不影响整体巡查。

## 隐私合规
- 派活任务头 `provider: deepseek`（官方渠道）——reviewer/pm/intel-gatherer/learning-officer/channel-manager 均属隐私敏感 agent（处理用户偏好/纠正/chat-signals），任务模板内也写明"只在本任务 deepseek 渠道处理，不写原文出圈"。

## 验证（内置自检 `node lib/twin-duty-inspector.js test`，5 场景全过）

| 场景 | 造的场景 | 结果 |
|---|---|---|
| 1 定时漏跑 | 临时置 intel-gatherer lastRun 为 7h 前（到期未跑）+ 模拟 butler 离线 | ✅ 分身兜底触发派活 intel-collect；state 还原 |
| 2 闲置派活 | 真实闲置 agent（learning-officer 创建 8/5，闲置 91h > 48h） | ✅ 派活 learning-merge 且被 butler 执行完成（真实闭环证据） |
| 3 业务信号 | 构造窗口内新完成 DONE | ✅ 派活审核官验收（review-batch） |
| 4 防骚扰 | 审核官 6h 内重复派发 | ✅ 被节流抑制，无重复 |
| 5 留痕 | 校验 activity [派活] tag | ✅ 写入成功 |

**真实运行验证**（`node lib/twin-duty-inspector.js scan`）：非破坏性，butler 在线 + 冷启动基线 → 本轮 0 派活（seenDone/chatSig 游标正确落盘，避免把存量当新增误派）。

## 派活闭环证据（真实发生的）
- `inbox/learning-merge-20260809-144014.md` → `.DONE`：分身闲置派活 → butler 派发 → learning-officer 执行完成（"30 条信号全部已处理，0 条新信号"）——**完整的"分身发现该干没干 → 派活 → 执行 → 完成"链条**。
- `inbox/intel-collect-20260809-144055.md` → `.DONE`：定时职责兜底场景下派发，butler 执行完成。

## 生效方式
分身（twin-daemon）已重启加载新代码（旧 PID 26028 → 新 PID 33452），此后每 5 分钟巡查自动带职责巡检。改动 `config/duty-inspector.json` 即生效（每轮巡查重读），无需重启。

## 与 butler auto-schedule 的分工（幂等协调）
- **butler 在线**：定时职责（channel-manager 30min / intel 6h / reviewer 21:30）由 butler 每分钟 auto-schedule 全权负责；分身只做业务信号（审核官 on-demand / PM / 进化官）与闲置派活。
- **butler 离线**：分身兜底触发到期未跑的定时职责（`auto-schedule.check()` 幂等，不会双写）。
- **防骚扰**：每职责最小派活间隔（6h/24h 不等），避免同职责刷屏。

## 踩坑
- activity 的 `[派活]` 前缀与 tag='派活' 重复 → 去掉 action 前缀，只留 tag（避免 `[派活] [派活]`）。
- 冷启动基线：chatSig 游标初始为空时，首次扫描会把已处理的 30 条存量信号误当新增触发派活 → 首次只记游标不派发。
- 测试副作用：自检场景会真实写 inbox 任务、被在线 butler 抢跑执行 → 测试后清理孤儿 .PID/.md；学习进化官 createdAt 为 8/5（闲置 91h）导致闲置派活为真实现象（非误报，已留作证据）。

## 产物
- `lib/twin-duty-inspector.js`（巡检模块）
- `config/duty-inspector.json`（规则）
- `lib/twin-daemon.js`（挂入巡查）
- `logs/twin-duty-state.json`（节流/游标状态）
- `logs/twin-duty-inspector.log`（模块日志）
