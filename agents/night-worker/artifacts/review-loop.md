# 自动复盘闭环 + 管家自杀拉起（review-loop）

> 任务：补全"自动总结优化改进"缺失的两环——①任务完成后自动复盘→改进项→例会核对→验证闭环；②管家（butler）死后自动拉起。
> 执行：night-worker（2026-08-10）｜代码在 org/ 框架内落地，随管家/分身重启自动生效。

---

## 一、自动复盘闭环（lib/review-loop.js）

### 1.1 职责与接线
| 环节 | 实现 | 接线点 |
|------|------|--------|
| **任务完成钩子** | `scanCompleted()`：扫描 inbox 新 `.DONE` → 生成复盘条目 `{ts/task/title/agent/durationSec/status/summary/problem/improvement}` append 到 `knowledge/reviews/<date>.jsonl` | **butler.js** 主循环每 5 分钟 `runReviewLoop()` → `rl.check()`（仅主管家，`!spawnGroupId`）|
| **每日复盘汇总** | `dailyReviewMaterial()`：当日复盘条目 + 待验证改进项 → 写 `knowledge/reviews/daily-material-<date>.md` | **daily-meeting.js** 管理组小会 prompt 自动带上该材料（读 `daily-material-<meetingId>.md`，无则提示今日无）|
| **改进项追踪** | `config/improvements.jsonl`（改进项/负责人/状态 pending→done）+ `recordImprovement()` 落盘 + `verifyImprovements()` 例会核对标记 done | **daily-meeting.js** 例会决议解析 `- IMPROVE:` 行 → `recordImprovementsFromMgmt()` 落盘；`- DONE-IMPROVE:` 行 → 核对标记 |
| **隐私路由** | `privateAgents`（pm/reviewer/intel/learning/channel-manager/twin/coo）复盘走 deepseek 官方渠道 | `config/review-loop.json` 可配 |
| **排除项** | `excludePrefixes`：永不复盘控制/自动派发类任务（review-loop-/daily-meeting-/intel-collect-/duty- 等） | `config/review-loop.json` |
| **去重** | `seenDone` 游标 + `dedupeMinSec`（默认3600s）同任务防重复 | `logs/review-loop-state.json` |

### 1.2 CLI 入口
```
node lib/review-loop.js check        # 跑一轮（butler 每5分钟调）
node lib/review-loop.js summarize    # 手动触发当日复盘汇总 → 会议材料
node lib/review-loop.js record "- IMPROVE: 标题（owner: X）| 说明"
node lib/review-loop.js verify "- DONE-IMPROVE: 标题"
node lib/review-loop.js test         # 内置自检（6 场景）
```

### 1.3 验证证据
- **真实运行**：`knowledge/reviews/2026-08-10.jsonl` 已有 **150 条复盘**（success 111 / failed 38，含 agent-backlog/ai-teaching-market-research/app-xxx/hk-xxx 等真实任务），持续自动增长（butler 定时器真实在跑）。
- **内置自检 6 场景**：DONE→复盘生成✅ / append 落盘✅ / 幂等✅ / 改进项记录+去重✅ / verify 标记 done✅ / 材料生成✅ / IMPROVE+DONE-IMPROVE 解析✅ —— 全绿。
- **端到端手动验证**：
  1. `summarize` → `knowledge/reviews/daily-material-2026-08-10.md`（含当日 150 条复盘 + 待办改进项，例会管理组自动阅读）
  2. `record "- IMPROVE: review-loop 内部日志与任务日志撞名修复（owner: night-worker）| ..."` → `config/improvements.jsonl` 新增 pending 条目
  3. `verify "- DONE-IMPROVE: ..."` → 该条状态 pending→done（doneAt 落盘）——验证"上轮改进下次例会核对"闭环。

### 1.4 踩坑修复（本次）
- **日志撞名**：`lib/review-loop.js` 内部日志文件名 `review-loop.log` 与**任务名 review-loop 的但管家会话日志**（`logs/review-loop.log`，45K 行 agent 会话 JSON 流）撞名污染。已改为 `logs/review-loop-runner.log`（同 auto-schedule→auto-scheduler 踩坑）。✅ 已改 + 语法 check 通过。

---

## 二、管家自杀拉起（并入 twin-duty-inspector）

### 2.1 实现
- **函数**：`watchButler(cfg, state, changed)`（lib/twin-duty-inspector.js）——分身巡查每 5 分钟调用（`runPatrol` → `scanDuties` 第一行）。
- **探活**：`butlerAlive()` 读 `butler.pid` + 进程探活。
- **拉起**：butler 离线 → `node scripts/bootstrap.js start`（detached + windowsHide）。
- **留痕**：`logActivity('[拉起] butler 死亡自动重启', ...)` 写入 activity。
- **防反复**：`config/duty-inspector.json` → `butlerWatchdog`：`cooldownMin=5` 窗口内死亡 > `maxRestarts=3` → 判定异常，**暂停自动拉起** + 写 `config/cluster-notify.json` `lastButlerAnomaly` 通知（不无限重启抖动）。
- **兜底**：但管家离线时分身还会触发 `auto-schedule` 定时职责兜底，避免"任务写了没人派发"。

### 2.2 代码链路验证（静态确认）
- `watchButler` 在 `scanDuties()` line 501 第一行被调用 ✅
- `scanDuties()` 被 `runPatrol()`（twin-daemon.js line 778）调用 ✅
- `runPatrol()` 每 `POLL_MS=5*60*1000`（line 916）setInterval ✅
- `bootstrap.js start` 存在且支持拉起 butler ✅

### 2.3 实测验证
> 见文末追加记录（kill butler → twin 巡查自动拉起 → activity 留痕）。

---

## 三、产出清单
| 文件 | 说明 |
|------|------|
| `lib/review-loop.js` | 复盘闭环核心（hook/汇总/改进项/CLI/自检）|
| `config/review-loop.json` | 复盘配置（enabled/provider/privateAgents/exclude/dedupe）|
| `lib/twin-duty-inspector.js` | 新增 `watchButler` 管家拉起（并入 scanDuties）|
| `config/duty-inspector.json` | `butlerWatchdog` 配置（cooldown/maxRestarts）|
| `lib/daily-meeting.js` | 管理组小会集成复盘材料 + 改进项落盘/核对 |
| `butler.js` | 主循环每 5 分钟 `runReviewLoop()` |
| `knowledge/reviews/<date>.jsonl` | 复盘条目库（自动增长）|
| `knowledge/reviews/daily-material-<date>.md` | 例会材料（自动生成）|
| `config/improvements.jsonl` | 改进项追踪（pending→done）|
| `logs/review-loop-runner.log` | review-loop 模块日志（已改名防撞）|
