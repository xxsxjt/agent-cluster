# 渠道 fallback 增强——空回复/无内容也算渠道失效

- **日期**：2026-08-09
- **执行者**：channel-manager（渠道管理智能体）
- **任务名**：fallback-empty-reply
- **触发背景**：cnb-ctl-autostart 失败真因 = opencode-go 返回空回复（200 但 content 空、usage 0），而 model-fallback-chain 只对 403/5xx/连接错切换渠道，**空回复未触发 fallback**，且 settled 后被误标记为「空转超时」业务失败、不切换渠道。

## 目标
1. 渠道失效（含空回复）→ 自动换下一个渠道（opencode-go → aliyun-0731 → xxsx → deepseek 官方）
2. settled 但无 .DONE 时区分原因标记（空回复 = 渠道问题，非业务失败）
3. 移除误导性「空转超时」文本
4. 不影响正常回复；与 notify-tier 兼容（自动恢复成功不通知）

## 改动清单

### 1. `lib/channel-fallback.js` — 新增空回复检测
- 新增常量 `EMPTY_REPLY_REASON = '渠道空回复（content 空/0 token）'`
- 新增函数 `detectEmptyReply(logPath, offset)`：
  - 解析 pi rpc 日志（逐行 JSON）中的 `message_end`
  - 判定条件：assistant content 为空（无非空 text / 无 toolCall 块，thinking 块不算产出）+ `usage.totalTokens ≤ 5`
  - 无论是否带 `errorMessage`（200 静默空回 / 400 错误空回）都视为渠道失效（无可用产出）
  - `offset` 支持只扫描本轮派发后新增日志（避免误读上一轮失败）
- 导出 `detectEmptyReply` 与 `EMPTY_REPLY_REASON`

### 2. `butler.js` — dispatch 渠道 fallback 控制器增强
- **模块级**引入 `cf`（channel-fallback），供 `checkActive` 复用
- **exit 处理器**三处增强：
  - done 含 `.FAILED: 渠道空回复` → 属渠道问题：**清掉标记 + markFailure + tryNext 走 fallback 切换**（不再当作业务失败终止）
  - 无 done 且 `detectEmptyReply` 命中 → 用 `渠道空回复` 作为失败原因 markFailure + tryNext（与 403/5xx 同一冷却机制，连续 N=2 次后切下一渠道）
  - 保留原有业务失败（非渠道）终止逻辑

### 3. `butler.js` — checkActive 标记语义修正
- **settled 分支**：检测到空回复 + 无 .DONE → 标 `.FAILED: 渠道空回复（content 空/0 token）` + 强制结束 → 由 exit 处理器清标记 + 走 fallback（不再误判为成功或「空转超时」失败）
- **pid 死分支**：settled 后进程退出但空回复 → 标 `.FAILED: 渠道空回复`（防御性兜底），正常产出 → 仍标成功
- **移除误导性文本**：settled 宽限超时成功标记由「agent_settled 后进程空转未退出（宽限已过，判定完成）」改为「agent_settled 后进程退出（宽限已过，判定完成）」，不再使用「空转」误导措辞

## 验证

### 逻辑验证（真实日志）
| 用例 | 输入 | detectEmptyReply 结果 |
|---|---|---|
| 真实失败日志 `logs/cnb-ctl-autostart.log` | 全量 | `{empty:true, provider:opencode-go, reason:渠道空回复…}` ✅ |
| 正常任务日志（5 个样本） | 全量 | 全部 `empty:false`（无误报）✅ |
| offset=文件末尾（空窗口，新轮次） | 只扫新日志 | `empty:false`（不误读上一轮失败）✅ |
| offset=0（全量） | 全量 | `empty:true` ✅ |

### fallback 切换验证（真实冷却机制）
模拟 opencode-go 连续两次空回复：
- 第 1 次 → `fails=1`，`pickProvider` 仍返回 opencode-go（未达阈值，重试本渠道）
- 第 2 次 → `fails=2` → 进入冷却（10 分钟）→ `pickProvider` 返回 **aliyun-tokenplan** ✅
- 测试后 `markSuccess` 清理，`channel-health.json` 恢复干净（fails=0）✅

### 语法检查
- `node --check butler.js` ✅
- `node --check lib/channel-fallback.js` ✅

## 注意 / 遗留
- **butler 需重启生效**：当前运行中的 butler（pid 35404）为旧代码。按「延迟重启策略」不在此次强杀（避免中断运行中的 cnb-ctl-autostart 与 fallback-empty-reply 任务）。下一轮重启后本增强自动生效。

## 补验与收尾（improve，2026-08-11 18:2x channel-manager）

**判定**：源任务「失败需重派」实际为**误判**——代码改动自 08-09 已落地，且 butler 随后（本任务派发时 18:07:10）已自动重启加载新代码，「但ler 需重启生效」遗留缺口已补齐。当前生产运行一切正常，无需重跑；本补验聚焦**补足生产端到端验证证据**。

### 证据一：butler 已加载新代码（生产运行）
- `butler.js` 运行中进程 **PID 25720，启动 2026-08-11 18:07:10**，晚于 08-09 源码改动 → `detectEmptyReply` / `EMPTY_REPLY_REASON` / exit 处理器空回复 fallback 分支已生效。
- 进程存活、CPU/内存正常（50MB），`logs/butler.log` 持续写入（18:21 仍在滚动）。

### 证据二：空回复检测逻辑实测（当前生产代码）
- 构造 pi rpc JSONL：`message_end` content 空 + usage.totalTokens=0（opencode-go）→ `detectEmptyReply` 判定 `{empty:true, reason:渠道空回复（content 空/0 token）}` ✅
- 正常回复（content 非空 + totalTokens=150）→ `empty:false` 不误报 ✅
- offset 跳过空回复行（只扫新日志窗口）→ `empty:false` 不误读上一轮失败 ✅
- fallback 链 ≥4 渠道就绪 ✅

### 证据三：渠道健康表（fallback 链可正常切换）
| 渠道 | status | 冷却中 |
|---|---|---|
| opencode-go | recovered | 否 |
| aliyun-tokenplan | recovered | 否 |
| xxsx | healthy | 否 |
| deepseek | healthy | 否 |

四渠道全部健康、无冷却 → `pickProvider` 正常走 opencode-go 优先链；若空回复连续 2 次触发冷却可正常切 aliyun-tokenplan。

**验证结果：13/13 通过。结论：fallback-empty-reply 目标已达成并生产生效，收尾。**
- **空回复阈值**：复用既有 `RETRY_THRESHOLD=2`（与 403/5xx 同一冷却机制，符合「连续 N 次如 2 次 → 换下一个」）。
- **兼容性**：正常回复（content 非空）不受影响；空回复导致的自动恢复成功走既有 `[自动恢复]` 通知分级（不打扰用户）。
