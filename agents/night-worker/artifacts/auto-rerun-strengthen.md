# auto-rerun-strengthen — 失败自动重跑机制强化

**时间**：2026-08-12 20:38–21:1x（night-worker 执行）
**触发**：用户批评（2026-08-12 20:1x）："没修就修啊……那全死完了咋办，又要等到我追查任务进度再修？"

## 根因（实证）

1. **外部清理脚本误杀 3 个活任务**（butler.log 20:15:19 实证）：
   - `xxssxx-homepage-v2` / `app-chatroom-ui-fix` / `reviewer-quality-gate` 被标记 `.FAILED: 孤儿残留（并发名额释放）`，进程被杀
   - 写入者是临时脚本（已不存在，代码库中无该字符串）；管家将标记当「业务失败」→ 只通知不重跑 → 任务静默死亡
2. **管家自身多条失败路径同样静默死亡**：
   - 非 pi exit（`进程退出 code=N`）、pi 渠道超限（`渠道全部不稳定`）、HK/CNB 桥退出 → 写 .FAILED 后**不自动重跑**（旧代码只在 failTaskAnomaly/PID 死路径调 autoRerunTask，exit 路径 finalize 后无人接管）
3. **深层 bug：autoRerunTask 从未真正生效**（实证于验证中）：
   - `lib/anomaly-fallback.js isClosed()` 用 `fs.existsSync(<name>.DONE)` 判"已闭环"——但失败标记就是写在 `.DONE` 文件里（内容 `.FAILED: ...`）→ **失败任务被误判为"自身已完成"→ 自动重跑永远被拦截**（`⏭️ 源任务已由 -improve 闭环 → 跳过`）
4. HK/CNB 桥**无降级链**：`HK 不可达` / `CNB 不可达` 直接 .FAILED 收场（无转本机）

## 改动清单

### butler.js
| 位置 | 改动 |
|---|---|
| 新增 `isAnomalyFailure()` | 失败文本判别：异常失败（进程退出/卡死/渠道/不可达/误杀标记/超时等）vs 明确业务失败 |
| 新增 `isFailMarker()` | **收紧版**失败标记判别（防成功文章误扫）：仅 `.FAILED` 前缀 / 系统级失败前缀 / ≤80字明确失败声明 |
| 新增 `recoverFromFailure()` | **统一失败恢复入口**：业务失败→记录不盲跑；协调器类→记录+升级（防重开会）；节点不可达→降级本机；其余异常→autoRerunTask（限 2 次，超限升级带原因链） |
| 新增 `degradeNodeTask()` | HK/CNB 不可达 → 任务文件 `target/side: local` 改写 + 降级记录段 + 重派本机（限 1 次降级，防循环） |
| 新增 `sweepSilentFailures()` | 静默失败兜底巡检（10min + 启动 + --once）：扫 inbox/*.DONE 失败标记 → 未重跑过(recCount=0)且近 24h → 自动重跑；防历史失败洪峰 |
| 新增失败原因链 | `logs/failure-chain/<name>.jsonl` 逐次追加；升级用户通知带全链（`#1:... → #2:...`） |
| 新增业务失败留痕 | `logs/business-failures.jsonl`（不盲跑但记录，供复盘） |
| 非 pi exit handler | 异常退出 → recoverFromFailure（自动重跑） |
| pi 渠道超限路径 | `.FAILED: 渠道全部不稳定/疑似限额` → recoverFromFailure（自动重跑） |
| HK/CNB 桥 exit | 不可达→降级本机；业务失败→记录；异常→重跑 |
| 会议/例会协调器 exit | 记录 + 升级用户（不自动重跑，防重复协调） |
| checkActive done 分支 | 非 recovery 异常失败标记 → 自动重跑（兜底外部写入者）；业务失败 → 留痕 |
| autoRerunTask 超限 | 升级通知带失败原因链 |
| module.exports | 导出 isAnomalyFailure/isFailMarker/recoverFromFailure/sweepSilentFailures 等（供测试） |

### lib/anomaly-fallback.js
- `isClosed()`：`hasDONE` → `hasSuccess`（内容含 `.FAILED` 不算闭环）——**修复自动重跑被永久拦截的深层 bug**

## 验证（全部通过）

### 单元测试（scratch/test-auto-rerun-strengthen.js）34/34
- isAnomalyFailure：14 类异常→重跑 ✓、5 类业务→不重跑 ✓、空标记→异常 ✓
- isFailMarker：权威标记 ✓、成功文章/摘要/含失败词长文均不误判 ✓（实测误扫案例 channel-manager、daily-meeting 等全部拦截）
- 失败原因链：多次追加 + 格式化 ✓
- isClosed 修复：失败标记≠闭环 ✓、成功=闭环 ✓、-improve 覆盖=闭环 ✓

### 集成验证（scratch/verify-auto-rerun.js）16/16
- **场景 A（模拟误杀）**：构造任务 + 手写 `.FAILED: 孤儿残留（并发名额释放）` → sweepSilentFailures 自动重跑 → 恢复计数+1 → 重派（PID 出现）→ **重跑成功完成（DONE=ok）** ✓
- **场景 B（业务失败）**：`.FAILED: 任务文件未包含代码块` → 不盲跑（DONE 保留、无 PID）+ business-failures.jsonl 留痕 ✓
- **场景 C（节点降级）**：`HK 不可达` 失败标记 → recoverFromFailure → 任务文件 `target: hk→local` + 降级记录段 + 重派本机 → **本机执行完成** ✓

### 真实环境附带验证
- 兜底巡检扫描 803 个 .DONE 历史文件：成功文章全部正确跳过（未误重跑）；真失败标记（近 24h）自动重跑、-improve 闭环的跳过（防重复补验）——**修复前这些历史失败任务全是静默死亡状态**

## 生效方式
- 代码已落盘（git 仓库，git-sync 每 10 分钟自动 commit）
- 运行中管家（PID 17628）为旧代码；已预约 `scripts/restart-butler-on-idle.js --max-wait-min 480`（活动任务收尾后自动重启加载新机制）
- 重启后启动即跑 sweepSilentFailures → 近 24h 真实失败任务自动恢复

## 决策记录
- 会议/例会协调器失败**不自动重跑**：多 agent 协调器重开会/重复收集发言风险 > 收益，改为记录+升级用户（人工判断）
- 历史失败标记（>24h）不自动重跑：已由 -improve/人工处置过，防一次性洪峰抢占并发与渠道额度
- 降级仅限"节点不可达"类失败；任务文件写入 `## 降级记录` 段供追溯（不静默）

## 遗留建议
- 误杀源（`孤儿残留（并发名额释放）`写入脚本）已不存在；若再出现类似外部清理脚本，建议统一收敛到管家内部 sweepOrphans/sweepRpcOrphans（已有活任务保护），避免外部杀进程
