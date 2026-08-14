# 异常通知分级（notify-tier）

> 智能体集群 · night-worker · 2026-08-08

## 背景

用户 2026-08-08 21:4x 批评：任务"疑似卡死"的通知直接发给了用户，但管家**已有异常自动恢复链**（failTaskAnomaly：标记失败 + 请求分身决策 + 自动重跑）。用户质疑：
1. 通知有没有发给分身/管家去重启？→ 有，failTaskAnomaly 已做
2. **重启成功发用户干嘛**？→ 多余
3. **重启失败应该先尝试修复再发用户** → 重跑超限才升级
4. 发用户再让用户跟分身说 = 多此一举

**用户期望的通知分级**：

| 事件 | 通知用户？ |
|---|---|
| 任务正常完成（task_done）| ✅ 通知 |
| 任务异常（卡死/中断）| ❌ 不通知，走 failTaskAnomaly（标记+分身决策+自动重跑）|
| 异常但自动恢复成功（重跑完成）| ❌ 不通知，记 activity/log |
| 异常且自动恢复失败（重跑超限/分身决策=归档/无法恢复）| ✅ 通知（带说明：尝试了什么、为什么失败）|

## 改动（org/butler.js）

1. **failTaskAnomaly**：移除「异常时立即 notifyTaskEvent(false)」——异常标记只写日志 + 请求分身恢复决策，不再打扰用户。

2. **分级通知机制（checkActive 完成分支）**：
   - 正常任务完成/失败 → 照常通知（notifyDone 配置，失败必报）
   - **异常重跑（recovery rerun）完成**：
     - 成功 → **不通知用户**，记 `♻️ [自动恢复]` 日志；仅当配置 `notifyAnomalyAutoRecovered: true` 才通知
     - 失败（重跑仍失败）→ **自动恢复失败，升级用户**带说明 `自动恢复失败（异常重跑仍失败）：<原因>`

3. **标记机制**：分身决策「重跑」时打 `inbox/.recovery/<name>.flag`（markRecoveryRerun），重跑完成时查 `isRecoveryRerun` 决定是否通知，完成后 `clearRecoveryRerun` 清理。flag 目录在 inbox 子目录，不影响 scanInbox。

4. **重跑超限升级**：`handleRecoveryDecision` 重跑超限（MAX_RERUN=2）→ 通知文案改为 `已尝试自动恢复 2 次仍失败（进程异常/疑似卡死），已强制归档，需人工处理`（带尝试说明）。

5. **分身决策=归档**：原无通知，现补通知 `自动恢复失败：分身决策归档不再自动重派，需人工处理`（符合「分身决策=人工 → 通知」）。

6. **配置**：`config/cluster-notify.json` + `scripts/hk-alert.js` 默认增加 `notifyAnomalyAutoRecovered: false`（显式可配，默认不打扰）。

## 不破坏恢复链

只改通知时机，未动 failTaskAnomaly 的 requestRecoveryDecision → 分身决策 → handleRecoveryDecision → 重派/归档主链路；未动进程死/日志停滞/空转检测。

## 验证（scripts/verify-notify-tier.js，17/17 通过）

隔离测试脚本从 butler.js **源码按函数名提取真实函数体**（brace 匹配），经 new Function 注入 mock 依赖，确定性跑通 5 个场景：

- **A** 异常标记（failTaskAnomaly）→ 不立即通知 + 写出恢复决策请求 + active 移除 + 写失败标记
- **B** 分身决策「重跑」→ 打 recovery 标 → 重跑完成识别为「自动恢复成功」→ **不通知** + flag 清理 + 记 [自动恢复]
- **C** 重跑超限（MAX_RERUN=2）→ 通知用户 1 次，状态 failed，消息含 `已尝试自动恢复 2 次仍失败`，强制归档写失败标记
- **D** 分身决策「归档」→ 通知用户带 `自动恢复失败：分身决策归档` 说明
- **E** 正常任务完成 → 仍照常通知（回归）

执行：`node scripts/verify-notify-tier.js`（临时目录，不触碰真实 inbox；结束后恢复真实 config）。

## 部署

butler 守护进程（PID 37604）运行旧代码，需重启加载新代码。因 notify-tier 任务自身是 butler 的子进程，重启会中断自身 → 采用**延迟独立重启**：本任务完成后，独立脚本 sleep 等待任务退出，再 kill 旧 butler + `bootstrap.js start` 拉起（watchdog 同款重启方式）。改动语法已通过 `node -c butler.js`。

## 产出文件
- 改动：`org/butler.js`、`org/config/cluster-notify.json`、`org/scripts/hk-alert.js`（默认值）
- 验证：`org/scripts/verify-notify-tier.js`
- 本报告：`org/agents/night-worker/artifacts/notify-tier.md`
