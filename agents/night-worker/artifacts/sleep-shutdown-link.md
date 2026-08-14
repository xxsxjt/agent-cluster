# 睡前模式联动自动关机（sleep-shutdown-link）

> 2026-08-11 · night-worker · butler.js 新增睡前自动关机联动
> 背景：用户昨晚只开了 `sleep-mode.flag`（行为标记），没联动关机，机器整夜没关。用户预期「睡前模式 = 任务跑完自动关机」。

## 一、机制（butler.js）

`sleep-mode.flag` 存在时，但管家（主管家）主循环 `checkSleepShutdown()` 每个轮询周期检测：

1. **触发条件**：任务队列为空（`active` 无任务/无 PID）**且**连续 `idleMin` 分钟（默认 5）无新活动 → 触发自动关机
2. **关机执行**：`shutdown /s /t <shutdownDelaySec>`（默认 60 秒倒计时，留时间保存）→ 关机前写 `LAST_SHUTDOWN_NOTE.txt` 快照（时间 / 触发原因 / 最后任务 / 关机命令）→ 日志 `[睡前模式] 任务队列清空已满 X 分钟无新活动 → 触发自动关机`
3. **防误关**：
   - 仅 flag 存在时启用（用户明确睡前才关）
   - 有关键任务在跑（`active` 非空）→ 不关，重置空闲计时，等完成
   - 用户醒后清 flag → 检测到 flag 不存在即取消关机计划
   - 空闲窗口内有新任务 → 取消倒计时（取消关机计划 + 重置空闲计时）

## 二、代码位置

- 常量：`butler.js` `SLEEP_SHUTDOWN_NOTE` / `SLEEP_SHUTDOWN_CFG`（约 L43-44）
- 逻辑：`sleepShutdownCfg()` / `writeShutdownNote()` / `runShutdown()`（约 L110 起）
- 主循环内：`checkSleepShutdown()` + 挂在 `cycle()` 末尾（约 L1455 起 / L1513）
- 配置：`config/sleep-shutdown.json`

## 三、配置（`config/sleep-shutdown.json`）

```json
{
  "dryRun": true,          // true=只打日志不真关机（安全/验证）；false=真机自动关机（=用户授权）
  "idleMin": 5,            // 任务队列清空后连续无新活动多少分钟触发
  "shutdownDelaySec": 60   // shutdown /s /t 倒计时秒数（留时间保存）
}
```

- **默认 `dryRun: true`** —— 关机是大事，真机模式需用户明确授权：把 `dryRun` 改成 `false` 即启用真实自动关机。
- 环境变量 `SLEEP_SHUTDOWN_DRY_RUN=1` 可强制进入 dry-run（验证用）。
- 改配置即时生效（每次检测实时读），无需重启。

## 四、验证（dry-run，未真关机）

独立 harness `scratch/test-sleep-shutdown.js` 用 mock 驱动（复制 butler.js 精确逻辑），**14/14 全绿**：

| 场景 | 结果 |
|---|---|
| 1. flag + 空队列 + 空闲满阈值 → 触发关机(dry-run) + 写快照 | ✅ 触发 + `[DRY-RUN] 将执行: shutdown /s /t 60` + 写 `LAST_SHUTDOWN_NOTE.txt` |
| 2. flag 清除 → 取消关机计划 | ✅ `flag 已清除，取消关机计划` |
| 3. 有新任务(active 非空) → 重置空闲、不触发、记最近任务 | ✅ |
| 4. 空闲未满阈值 → 不触发 | ✅ |
| 5. `dryRun=false` → 分支可达（生产就绪） | ✅ |

- `node --check butler.js` 语法通过。
- 测试全程 dry-run，未执行真实 `shutdown` 命令；未创建真实 `sleep-mode.flag`；测试后配置/`LAST_SHUTDOWN_NOTE.txt` 已还原。

## 五、生效与启用

1. **butler 需重启加载新钩子**：当前运行 butler 为 PID 47300（旧代码，不含本功能）。重启命令见现有重启脚本（如 `scripts/restart-butler-*.ps1` 或 bootstrap start）。
2. **启用真机自动关机**：把 `config/sleep-shutdown.json` 的 `dryRun` 改为 `false`（= 用户授权）。
3. 之后用户睡前开 `sleep-mode.flag` → 任务清空 5 分钟后自动 `shutdown /s /t 60`。

## 六、与 hub shutdown-after-done 的区分

- hub 的 `shutdown-after-done.js` 是**手动模式**（显式命令时用）。
- 本机制是 **flag 自动**：`sleep-mode.flag` 存在 + 队列清空 + 空闲满阈值 → 自动关机，无需手动干预。
