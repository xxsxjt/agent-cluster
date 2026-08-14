# 睡前模式"巡查照常、派发转计划文档"（twin-sleep-mode-plans）

- 日期: 2026-08-08 00:5x
- 执行: night-worker (deepseek-v4-flash)

## 背景
用户 2026-08-08 00:4x 提出：睡前模式（或 shutdown-after-done 关机模式）下，分身与管家的**巡查/验收/讨论机制完全不变**（分身照样巡查、验收、讨论下一步），但**不立马派发新任务（不 spawn）**，改为**写下计划文档**（讨论结论 + 下一步计划），**下次启动时再派发**。
原因：不停派发新任务 → 永远没有关机机会（"根本不可能有关机的机会"）。

## 依赖处理
- 依赖任务 `twin-supervision-loop` 的**代码已完成**（butler.js / twin-daemon.js 于 00:36/00:37 修改到位，监督闭环已实现：分身验收→讨论议题→管家响应→派发完善任务→纪要归档），但其 agent 进程在写 .DONE 前死亡（无 .DONE，日志 560MB 失控流式输出）。
- 我确认依赖代码完整且语法通过，在其之上做**增量式**改造（睡眠模式分支），与监督闭环无冲突。

## 实现（统一判定 + 派发转计划 + 启动恢复）

### 1. 统一睡眠/关机模式标记
- **`org/sleep-mode.flag`** 文件为唯一判定源。
- `butler.js`: 新增 `const SLEEP_FLAG = org/sleep-mode.flag` + `sleepModeOn()`（存在即睡眠模式）。
- `web/server.js`: `POST /api/shutdown/arm`（睡前模式按钮）**写入 sleep-mode.flag**；`POST /api/shutdown/disarm` **删除标记**。睡前模式按钮 ⇔ 派发转计划标记 绑定，无需用户额外操作。
- `twin-daemon.js`: 通过 `scanDiscussionReplies` 读取回复内容，若含"计划文档/睡眠模式/待启动派发"则在 activity.log 注明 `（已转计划文档，待启动派发）`。

### 2. 讨论照常、派发转计划（butler.js scanDiscussion）
- 阅读讨论议题后照常生成管家回复（同意/调整/驳回），并归档纪要 knowledge/meetings/。
- **原派发逻辑分支**：`if (sleepModeOn())` → `writePlanDoc(...)` 写计划文档到 `org/plans/next-boot/<ts>-<topic>.md`，**不写 inbox 任务、不 spawn**；
  否则照旧写 `inbox/<task>-improve.md`。
- 计划文档内容：议题（分身验收结论）、分身判断、管家响应、**建议任务文件全文**（预写任务，含 `agent:` 头部，下次启动直接可用）。
- 回复中注明"已转计划文档，待启动派发（睡眠模式：讨论照常，派发转计划）"，分身 activity 据此闭环留痕。

### 3. 启动恢复派发（butler.js restorePlans）
- butler 启动时（非 --spawn、非 --once）调用 `restorePlans()`。
- 扫描 `org/plans/next-boot/*.md` → 提取"建议任务文件全文" → 写为 `inbox/<topic>.md` → 计划文档归档 `org/plans/done/`。
- **去重**：若 inbox 已存在同名任务（readIf(targetMd) 命中）则跳过恢复，仍归档 done。
- **睡眠模式下的启动不恢复**：若启动时 sleep-mode.flag 仍存在（同睡眠会话内重启），不转任务、不派发，等退出睡眠后下次启动再派。

### 4. shutdown-after-done.js 确认
- 无需改动。守护进程只扫描 **inbox/**.md 判定未完成任务；睡眠模式计划写在 **org/plans/**（不在 inbox），**不会被计为未完成任务** → "等当前任务完成 → 关机" 正常触发，不再因新派发无限等待。✅

## 验证（沙箱 E2E，隔离 live 环境）
在 `test/sleep-mode-sandbox/` 复制 butler.js + lib 依赖做隔离测试，20/20 断言通过：

1. **置 sleep-mode.flag** → 投递"有完善空间"讨论议题 → 管家响应"同意（睡眠模式→写计划文档）"，生成计划文档（含议题/判断/响应/任务全文/agent 头部），**inbox 无新任务**，生成回复注明"已转计划文档"。
2. **移除标记 → restorePlans()** → 计划转派发 `terraria-world2-seed-improve.md`（含 agent 头部、完善目标），next-boot 清空，计划归档 done。
3. **去重**：inbox 已存在同任务名 → 跳过恢复，归档 done。

## 改动文件
- `butler.js`：睡眠标记常量 + sleepModeOn()、scanDiscussion 派发分支、writePlanDoc()、restorePlans()、启动钩子
- `lib/twin-daemon.js`：scanDiscussionReplies 识别计划模式并注明 activity
- `web/server.js`：shutdownArm/disarm 绑定 sleep-mode.flag 读写

## 说明
- live butler（PID 48676）为改动前代码，本次未重启（避免中断当前任务执行）。**改动将在下次 butler 重启/关机后生效**：届时启动即扫描 next-boot 恢复派发计划任务。
