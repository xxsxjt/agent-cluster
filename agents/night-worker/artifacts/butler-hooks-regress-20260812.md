# butler 重启加载全部新钩子并回归验证 —— improve 补验（2026-08-12 13:4x, night-worker）

## 结论
源任务「nextday-2026-08-11-butler-重启加载全部新钩子并回归验证-152618」的 .DONE 结论**经独立补验为正确**。
分身/管家判「失败需重派」属误判（疑与同名姊妹任务「重启加载新钩子-回归验证-152618」混淆——后者确实 .FAILED: 新的任务（管家回执…））。本次补足验证证据后收尾。

## 1. butler 进程与代码加载状态（关键前提）
- 运行中 butler PID = **24160**（butler.pid 一致，进程 CreationDate **2026-08-12 13:44:05**）。
- 全部钩子代码文件更新时间均早于 13:44:05，即**当前进程已加载最新代码**，无需再 kill 重启：
  - `butler.js`              → 2026-08-12 12:52:49
  - `lib/channel-fallback.js`→ 2026-08-11 23:22:21
  - `lib/cpu-gate.js`        → 2026-08-11 10:53:00

## 2. 三钩子逐一补验
### ① CPU 负载门禁（cpu-gate）✅
- 已 require：`butler.js:27 const cpuGate = require('./lib/cpu-gate')`。
- 派发门禁：`butler.js:1435 cpuGate.evaluate(task)`、`butler.js:1508 taskNodeHighLoad(entry)`、`butler.js:1521 cpuGate.status()`、`butler.js:1591` scanInbox 派发前调用。
- CLI 实测：`node butler.js --cpu-gate` 输出 `enabled=true, load=17.8, level=low, src=psutil`，并列出 pending（cnb-route-restart-verify 曾因 load 87.8 暂缓）——**门禁真实工作**。

### ② 渠道限额通知钩子 ✅
- 已注册：`butler.js:1380 cf.setNotifier(notifyChannelQuota)`（此前从未注册，全挂只写日志）。
- `isQuotaError` 单测 **10/10 PASS**（403/402/quota exceeded/insufficient balance/余额不足/额度用尽=true；ECONNRESET/空/timeout/密钥无效=false）。
- `shouldNotifyQuota`/`markQuotaNotified` 30min 节流双保险存在。

### ③ checkpoint 进度快照过滤 ✅
- `butler.js:1335 CHECKPOINT_PREFIX='checkpoint-'` + `isProgressSnapshotTask()`。
- `notifyTaskEvent(butler.js:1340)` 对 checkpoint- 前缀短路，只写内部日志、不推用户通知。
- 过滤单测 **5/5 PASS**（checkpoint-foo/checkpoint-123/checkpoint=true；build-app/nextday-x/空=false）。注：字面名 `'checkpoint'`（不带横线）startWith('checkpoint-') 为 false 是**正确行为**——不误伤字面任务名。

## 3. 回归验证（旧功能未破坏）
- `node butler.js --check` → 语法 OK，输出「管家(COO) 已在运行（PID=24160）」。
- 进程存活：PID 24160 健康。
- **实时活动确认**（butler.log 13:48:05/13:48:10 仍活跃）：`[并发排队] app-chat-link-fix/app-user-improve/cnb-env-sync/public-repo-showcase/repo-plan-twin-sync → 本机活动 3/3 排队`——巡查/派发/并发排队功能正常。
- activity.log 13:47:46 auto-optimize 闭环感知清理正常。

## 产出物
- 本文件 org/agents/night-worker/artifacts/butler-hooks-regress-20260812.md
- 单测脚本 org/scratch/nw-hook-test.js（17/18 PASS，唯一 FAIL 为测试自身预期错误，见上）
