# auto-optimize 换执行者闭环感知（improve 补验收尾）

> 任务：nextday-2026-08-11-auto-optimize-换执行者闭环感知-152618（improve 重派）
> 日期：2026-08-12 | 执行者：night-worker
> 状态：✅ 完成（源任务异常中断，本任务查明根因 + 补足验证证据 + 收尾）

## 一、源任务失败根因（查明）

源任务 `nextday-2026-08-11-auto-optimize-换执行者闭环感知-152618` 被分身兜底标记为「进程异常中断（pid 已死）」。

**补验发现：代码本身已实现且工作正常**，但源任务中断在**收尾阶段**——未产出 artifact、未写 .DONE、未 git 提交，导致验收视角判定为「失败需重派」。

已实现的闭环感知能力（lib/auto-optimize.js）：
- `isClosed(name)`：闭环感知判断——① 自身已有 .DONE；② 去掉 `-improve` 后缀的源任务已有 .DONE；③ 已被 `-improve` 版本覆盖（存在 `<name>-improve.DONE`）。
- `cleanClosedCounts()`：清理已闭环任务在 `logs/recovery-count.json` 里的重跑失败计数（pending 噪音源头）。
- `optimizeTask()` 换执行者分支加入「闭环感知门禁」：已闭环任务跳过换执行者。
- `check()` 周期扫描开头调用 `cleanClosedCounts()`。

## 二、补足验证证据（本任务实测）

### 1. 内置自检 `node lib/auto-optimize.js test` → **14/14 通过**
覆盖：阈值判断 / 换执行者配置链 / 兜底 / 决策留痕 / 环境自查 / 渠道冷却 / **闭环感知 4 项**（自身.DONE、-improve源.DONE、已闭环抑制换执行者、未闭环仍换执行者）。

### 2. 真实文件级端到端（跑 butler 每 5 分钟同款 `check()`）
| 场景 | 构造 | 期望 | 实测 |
|------|------|------|------|
| 已闭环任务 | `e2e-closed-*` 写 .DONE + recovery计数=3 | 计数被清理、check 不换执行者 | ✅ 「闭环感知清理：移除 2 个已闭环任务的重跑计数」；计数从 jsonl 移除 |
| 未闭环任务 | `e2e-open-*` 写 .FAILED + 计数=3 | 正常换执行者+拆步 | ✅ 「优化 1 个失败任务：e2e-open-*(3次→换执行者 night-worker→workspace｜任务拆小)」 |

### 3. pending 噪音清理实况
`logs/recovery-count.json` 原仅剩 **2 条**已闭环残留计数，`node lib/auto-optimize.js clean` 清理后为 **0 条**（85 条 pending 噪音此前已随源任务实现逐步清零，本次确认无残留）。

### 4. 决策留痕
`logs/auto-optimize.jsonl` 可见闭环感知留痕：「闭环感知: 源任务已 .DONE/被 -improve 覆盖，跳过换执行者」。

## 三、代码改动
- `lib/auto-optimize.js`：+70 / -6，新增 `isClosed`、`cleanClosedCounts` 及调用点（optimizeTask 门禁 + check 清理）。
- git 提交 `aa57aa1`：`auto-optimize 换执行者闭环感知: 源任务已.DONE/被-improve覆盖即不换执行者，清理85条pending噪音`。
- `node --check` 通过。

## 四、遗留 / 备注
- 本改动需 butler 重启加载后生效（butler 每 5 分钟 `check()` 会自动调用闭环感知清理）。
- 源任务「85 条 pending 噪音」已无残留（recovery-count = 0）。
