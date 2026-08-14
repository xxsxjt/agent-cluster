# 孤儿进程失败机制加固 · coo 交叉验证闭环（2026-08-12）

> 任务：nextday-2026-08-11-孤儿进程失败机制加固-152618（daily-meeting 自动派发）
> 执行者：coo（交叉验证 + 闭环确认；机制主体由同批派发任务"失败判定机制体系化加固"实现）
> 状态：✅ 完成

## 一、本任务目标
调度层加"进程异常退出自动重派 / 补 DONE"兜底，根治约百级 FAILED 故障族；产出设计 + 落地 + 回归验证。

## 二、结论：目标已完整覆盖
同批派发的"失败判定机制体系化加固"已实现本任务全部诉求，coo 逐项交叉验证确认无缺口：

| 本任务诉求 | 落地点 | 验证结果 |
|-----------|--------|---------|
| **进程异常退出自动重派** | `failTaskAnomaly` → `decideFallback` 三分支，redispatch 分支走 `autoRerunTask`（限 MAX_RERUN） | ✅ 已接线 |
| **补 DONE 兜底** | `supplement-done` 分支 + `settlePending` 周期扫描（DONE 写入前死亡但有完成证据） | ✅ 已接线，butler cycle() + --once 均调用 |
| **根治 FAILED 故障族** | ①补 DONE 跳过无效重跑 ②`isClosed` 守卫防重复补验 ③`cleanClosedFailed` 清陈旧 .FAILED ④sweepOrphans/sweepRpcOrphans 孤儿清扫 | ✅ 全部落地 |
| **设计文档** | `agents/night-worker/artifacts/failure-judgment-hardening-20260812.md` | ✅ 已产出 |
| **落地** | `lib/anomaly-fallback.js`（新增）+ `butler.js` 3 处接线 + `lib/auto-optimize.js` isClosed 委托/cleanClosedFailed | ✅ |
| **回归验证** | 见下 | ✅ |

## 三、回归验证（coo 实测，全部通过）
- `node --check` butler.js / anomaly-fallback.js / auto-optimize.js → 全 OK
- `node test/test-anomaly-fallback.js` → **28/28**（补 DONE / 已闭环跳过 / 自动重派 / hasCompletionEvidence 边界 / cleanClosedFailed / markClosedSkipped / settlePending）
- `node test/test-fallback-consistency.js` → **9/9**
- `node test/test-orphan-cleanup.js` → **17/17**（既有孤儿根治不回归）
- `node test/soft-timeout-loop-sim.js` → **10/10**
- `node lib/auto-optimize.js test` → 闭环感知 / 渠道冷却 / 环境自查全过

## 四、真实 inbox 核对
- 当前 0 个 .FAILED（cleanClosedFailed 无陈旧可清）
- 无「死 PID + 无终态 + 有完成证据」的残留任务待 settlePending 补 DONE（三个 .PID 均在 active 表=正常在跑）

## 五、生效前提（关键）
当前运行但ler PID **24160 @ 13:44:05 启动，早于 anomaly-fallback.js 的 16:27:36** —— **尚未加载本机制**。
- `scripts/restart-butler-on-idle.js` 已后台待命（PID 状态存活，nohup 持续轮询），等待 3 个活动任务（含本任务）收尾后经 bootstrap 重启。
- 重启后 butler.js require 即加载 anomaly-fallback（新代码），`settlePending` 随 cycle() 周期生效。
- 本任务写 DONE 即从 active 表移除 → 收尾剩余 2 个 server-admin 任务后触发重启。

## 六、遗留
- `agent_settled` 为"完成"唯一强证据；崩溃前未写 settled 但实际已产出的任务归"无证据"→ 走正常重跑（宁重跑不误标完成）。
- 需等 restart-butler-on-idle 触发的重启真正完成，机制才在生产生效（无独立快速重启手段，依赖 idle 机制，避免中断活动任务）。
