# 失败判定机制体系化加固（anomaly-fallback）· 2026-08-12

> 任务：nextday-2026-08-11-失败判定机制体系化加固-152618（daily-meeting 自动派发）
> 执行者：night-worker
> 状态：✅ 完成（机制代码 + 回归证据齐备）

## 一、任务目标
在 orphan-cleanup（进程/孤儿/PID 根治）+ soft-timeout（软超时不强杀）基础上，补齐"进程异常退出"兜底，并让 auto-optimize 识别"源任务已由 -improve 闭环"停止重复补验。产出机制代码 + 回归证据。

## 二、痛点 / 背景盲区
失败判定链（进程死→`failTaskAnomaly`→标 .FAILED→`autoRerunTask` 自动重跑→`auto-optimize` 换执行者/拆步）仍有两处盲区：

1. **进程异常退出但工作其实已完成**：`agent_settled` 已写日志、agent 在收尾时崩 → 原 `failTaskAnomaly` 一律标 `.FAILED` + 自动重跑，**浪费一次重验**（同一份已完成结果被重复执行）。
2. **源任务失败后已由 -improve 补验闭环**：`foo` 失败标 `.FAILED`，`foo-improve` 已补验完成（`.DONE`）→ 但 `autoRerunTask` 仍对 `foo` 自动重跑、`auto-optimize.check` 仍扫描 `foo.FAILED` 建议换执行者/拆步 → **重复补验噪音**。

## 三、方案：新增 `lib/anomaly-fallback.js`（纯函数兜底决策）
在失败判定链入口做「终态兜底决策」，三分支：

| 分支 | 触发条件 | 行为 |
|------|---------|------|
| **supplement-done（补 DONE）** | 进程异常退出但本次日志有完成证据（`agent_settled` JSON） | 直接写 `.DONE` 补标记，**跳过自动重跑**（工作已完成，只是收尾崩了） |
| **skip-closed（已闭环跳过）** | 无完成证据但源任务已闭环（源已 `.DONE` / 已被 `<name>-improve.DONE` 覆盖） | 写 `.FAILED` 注明"已闭环跳过"，**不再重复补验** |
| **redispatch（自动重派）** | 无证据且未闭环 | 正常标 `.FAILED` + `autoRerunTask` 自动重跑（限 MAX_RERUN） |

配套纯函数：
- `isClosed(name, inboxDir)`：闭环感知（单一来源，auto-optimize.isClosed 改为委托本库，避免两处漂移）
- `hasCompletionEvidence(logPath, logOffset)`：只读本次新增日志段，识别 `agent_settled`；单次≤512KB 防撑爆
- `supplementDone` / `markClosedSkipped`：写终态标记
- `cleanClosedFailed(inboxDir)`：清已闭环任务的陈旧 `.FAILED`（停止重复补验）

## 四、代码改动
| 文件 | 改动 |
|------|------|
| `lib/anomaly-fallback.js`（新增） | 兜底决策 + isClosed + 完成证据 + 清陈旧 .FAILED |
| `butler.js` | ① require anomaly；② `failTaskAnomaly` 异常退出前先 `decideFallback`（补 DONE / 已闭环跳过）；③ `autoRerunTask` 加 isClosed 守卫（防重复重跑） |
| `lib/auto-optimize.js` | ① `check()` 每轮 `cleanClosedFailed`（清已闭环陈旧 .FAILED）；② `isClosed` 委托 anomaly-fallback 单一来源 |
| `test/test-anomaly-fallback.js`（新增） | 20/20 回归 |

## 五、回归证据
- `node test/test-anomaly-fallback.js` → **20/20 通过**（补 DONE / 已闭环跳过 / 自动重派 / hasCompletionEvidence 各边界 / cleanClosedFailed 清陈旧留未闭环 / markClosedSkipped）
- `node lib/auto-optimize.js test` → **14/14 通过**（既有闭环感知 + 全部既有用例不回归）
- `node test/test-orphan-cleanup.js` → **17/17 通过**（既有孤儿根治不回归）
- `node test/soft-timeout-loop-sim.js` → **10/10 通过**（既有软超时模拟不回归）
- `node lib/auto-optimize.js check` → 真实状态干净运行「本轮无动作」不报错
- `node --check butler.js / lib/anomaly-fallback.js / lib/auto-optimize.js` → 全 OK

## 六、影响范围 / 部署
- **低风险**：改动均在异常退出判定入口，只「先判定再按原路径」；补 DONE 需日志确证 `agent_settled`（既有完成标志），不会把真失败误判为完成。
- **需重启 butler 生效**：butler.js 改动随常驻进程加载；重启时机建议待活动任务收尾（复用既有 restart-butler-on-idle 机制）。
- auto-optimize.js 改动（check 每 5 分钟跑）随子进程加载即生效，无需等重启。
- 不触碰真实 inbox 数据（测试全程临时目录；当前 inbox 0 个 .FAILED，cleanClosedFailed 实际清理 0）。

## 遗留
- `agent_settled` 作为"工作已完成"的唯一强证据；若 agent 崩溃前未写 settled 但实际已产出，属"无证据"→ 走正常重跑（宁重跑不误标完成）。
