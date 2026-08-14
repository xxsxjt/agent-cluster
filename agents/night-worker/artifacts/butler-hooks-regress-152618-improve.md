# butler 重启加载新钩子 + 回归验证（improve 补验，2026-08-12 13:4x，night-worker）

## 背景
源任务 nextday-2026-08-11-butler-重启加载新钩子-回归验证-152618 验收为「失败需重派」。
源任务 `.DONE` 内容为 `.FAILED: 管家认为管家回复不了` —— **失败原因是管家调度层面的通知/回复异常，非代码问题**。
源目标：butler 重启加载 quota 通知/cpu-gate/checkpoint 过滤钩子，投递真实构建任务验证端到端生效，回归确认旧功能未破坏。
本 improve 补足端到端验证证据。

## 1. butler 进程与钩子加载状态（无需重复重启）
- 当前 butler PID **24160**，启动于 **2026-08-12 13:44:05**（butler.pid + 进程 StartTime 双确认）。
- 三钩子代码文件修改时间全部早于启动时间 → 已随最新代码加载，无需 kill 重启：
  - `butler.js` mtime 12:52:49（含 cpu-gate require@L27、notifyChannelQuota 注册@L1380、checkpoint 过滤@L1340）
  - `lib/channel-fallback.js` mtime 08-11 23:22:21（isQuotaError / setNotifier 逻辑）
  - `lib/cpu-gate.js` mtime 10:53:00
- 钩子注册确认：`cf.setNotifier(notifyChannelQuota)`（L1380）已挂载；cpuGate 在 scanInbox 派发前 evaluate（L1435）；notifyTaskEvent 对 checkpoint- 前缀短路跳过用户通知（L1341-1344）。

## 2. 端到端验证（投递真实构建任务）✅
向 inbox 投递 `load-sensitive: true` + `target: cnb` 的真实构建任务 `hook-e2e-build-ok-verify-152618-improve`，内容为无害构建自检 `node --version && echo HOOK_E2E_BUILD_OK`。运行中 butler 实测：
- **CPU 门禁在 low 负载正确放行**：无 [负载门禁] 暂缓日志，构建任务未被误拦 → 旧功能未破坏
- **远程派发链路全通**：dispatchToCnb → cnb-task.js → CNB 空间1 可达（SSH 动态解析）→ 投递成功 → 执行器拉起 → 代码块执行
- **构建执行成功**：`✅ CNB 任务完成（1 代码块）：v22.23.1 / HOOK_E2E_BUILD_OK`，桥进程退出 code=0
- 首次投递缺 ```bash 代码块被 CNB 执行器正确拒绝（.FAILED: 任务文件未包含任何代码块）→ 修正后成功，证明执行器校验真实生效

## 3. 三钩子逻辑单测（UTF-8 内联验证）✅
- **isQuotaError**：9/9 通过（403/402/quota/insufficient/余额不足/额度用尽=true；network timeout/connection reset/空=false）——中文关键词支持确认
- **cpu-gate**：status level=low load=14.8 enabled=true；`evaluate(load-sensitive)` → `action=dispatch`（low 放行）
- **checkpoint 过滤**：4/4 通过（checkpoint-* 跳过用户通知；非 checkpoint 不误拦）

## 4. 旧功能回归确认 ✅
- 巡查/派发正常：日志可见 `🚀 派发 [app-chat-link-fix] → xxsx-gateway`、`[app-user-improve] → xxsx-gateway` 正常派发
- 并发排队正常：`⏳ [并发排队] app-chat-link-fix → 本机活动 3/3，排队等待`（本机活动满时正确排队）
- 完成收尾/通知正常：任务完成触发 HK 告警注入、子进程收尾

## 结论
三钩子（quota 通知 / cpu-gate / checkpoint 过滤）已随最新代码加载，端到端真实构建任务派发执行成功，旧功能（巡查/派发/并发排队/通知）未破坏。源任务失败为管家调度层面原因，代码与钩子均验证通过。
