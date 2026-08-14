# 智能体职责自动化补全（auto-schedule）— 2026-08-09

## 背景
用户批评"很多地方要提醒才干活，很多活应该是自动化的"。盘点缺口：**渠道管理(channel-manager)巡检、信息搜集官(intel-gatherer)收集、审核官(reviewer)验收** 三个智能体建了但从不自动干活。

## 方案落地：统一「职责调度表」
一个入口调度三个职责，避免散落。

### 新增/改动
| 文件 | 内容 |
|---|---|
| `org/config/auto-schedule.json` | **职责调度表**：channel-manager(每30min inline)、intel-gatherer(每6h dispatch)、reviewer(每日21:30 dispatch)。改间隔即生效。 |
| `org/lib/auto-schedule.js`（新增 ~10k） | 统一调度器。`check()` 每分钟检查到点触发；`force <name>` 手动触发。状态存 `logs/auto-schedule-state.json`，日志 `logs/auto-scheduler.log`。 |
| `org/butler.js` | 主进程新增 `runAutoSchedule()`：`if(!spawnGroupId)` 下每 60s 调 `auto-schedule.check()`（与 daily-meeting 调度器同款）。 |
| `org/scripts/restart-butler-auto-schedule.ps1` | 延迟重启脚本（BOM 编码修复后可用）：等 active 任务收尾 → kill 旧 butler(31036) → bootstrap start 加载新 hook。 |

### 三职责实现
1. **渠道管理自动巡检**（30min，inline）：
   - 读 `logs/channel-health.json` → 汇报渠道状态 → `channel-fallback.probeCoolingChannels()`（冷却渠道恢复探测，内部 30min 节流幂等）→ activity `[渠道]` 留痕；全挂发告警。
   - 与 twin-daemon 已有的 scanChannels 兜底并存（幂等，不双探）。
2. **信息搜集官自动收集**（6h，dispatch）：
   - 写 `inbox/intel-collect-<ts>.md` → butler 自动派发给 intel-gatherer 智能体 → 拉 HK 频道记忆/公共知识增量（对比游标）→ 增量更新 `knowledge/channel-intelligence.md`。
3. **审核官自动验收**（每日 21:30，dispatch，例会前）：
   - 扫描当日 DONE 任务 → 写 `inbox/review-daily-<date>.md` 派发给 reviewer → 按完整性/证据/回归验收 → 材料 `knowledge/meetings/<date>-review.md` 供每日例会(22:00)使用。
   - 当日无任务则跳过（写 .DONE 防刷屏）。

## 验证（全链路实测）
- **force channel-manager** → activity `[渠道] 渠道管理自动巡检 — 渠道 1 个：0 个冷却中待探；恢复 0` ✓
- **force intel-gatherer** → 写 `inbox/intel-collect-20260809-131934.md` → butler 派发给 intel-gatherer → **真实执行完成**：`.DONE`（HK 游标后无新增，knowledge 无新情报）✓
- **force reviewer** → 写 `inbox/review-daily-2026-08-09.md` → butler 派发给 reviewer → **真实执行**：审核官正在对今日任务(含 release-20260809 APK 发布)做深度验收（核对 APK sha256 / 源码 / 发布脚本）✓
- 状态文件 `logs/auto-schedule-state.json` 三个调度 lastRun 均记录 ✓
- 配置表生效：`check()` 每次重读 config（改间隔即生效），state 佐证 ✓

## 踩坑
1. **日志文件冲突**：初版模块日志名 `auto-schedule.log` 与本任务名 `auto-schedule` 的 butler 任务日志撞名 → butler 把本 agent 会话流写进该文件(144MB)。改名 `logs/auto-scheduler.log` 避开。
2. **PowerShell BOM**：write 工具写 ps1 无 UTF-8 BOM，PS5.1 按 ANSI 误读中文注释导致 `param()` 解析失败 → 用 `printf '\xEF\xBB\xBF'` 补 BOM 后解析正常（与既有脚本一致）。
3. **force 模式误触发**：初版 force 某调度时其他到点调度也触发 → 加 `if(opt.force && name!==opt.force) continue`。

## 生效状态
- 调度 hook 已写入 butler.js，需 **butler 重启后生效**（`scripts/restart-butler-auto-schedule.ps1` 已后台运行，等 4 个 active 任务收尾后自动重启）。
- 重启后：channel 巡检每 30min、intel 收集每 6h、reviewer 验收每日 21:30 自动跑。

## 遗留
- intel-gatherer 的 HK 频道/微信真实数据源通道（identity 标注"本期不实现"）仍待后续接入；当前收集任务是真实派发但增量源有限。
- reviewer 深度验收耗时长（APK/sha256 级核查），若 22:00 例会前未完成会自动顺延（daily-meeting 已有顺延逻辑）。
