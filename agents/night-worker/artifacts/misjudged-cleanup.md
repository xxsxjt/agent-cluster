# 误杀残留标记清理 + 自动归档机制（2026-08-09）

任务：misjudged-cleanup · 执行者 night-worker · 状态 ✅ 完成

## 一、问题背景

空转超时误杀机制已修（agent_settled 只认 JSON 事件），但**历史误杀残留标记还在**：
这些任务（原版/improve 版）实际已完成，却因空转超时被强制结束，落盘了
`.FAILED: agent_settled 后进程未退出（空转超时，已强制结束）` 的失败标记，
导致 web/控制台把大量"已完成"任务统计为失败，误导统计。

## 二、误杀特征匹配（严格按内容特征）

```
const MISJUDGED_PATTERNS = [/agent_settled\s*后\s*进程未退出/, /空转超时，已强制结束/];
```

只归档**内容含上述误杀特征**的失败标记；真失败（内容不含特征）一律不动。

## 三、一次性清理结果（10 个误杀归档）

按 `inbox/<name>.DONE.misjudged-20260809` 改名保留证据，同时归档对应 `.md`/`.PID` 到 `inbox/archive/`：

| 误杀任务 | 处理 |
|---|---|
| butler-stability-and-verify | ✅ 归档 |
| butler-stability-and-verify-improve | ✅ 归档 |
| cluster-twin-chat-improve | ✅ 归档 |
| disaster-recovery | ✅ 归档 |
| dual-cluster-sync | ✅ 归档 |
| dual-cluster-sync-improve | ✅ 归档 |
| interconnect-final-improve | ✅ 归档 |
| task-auto-recovery | ✅ 归档 |
| task-auto-recovery-improve | ✅ 归档 |
| windows-hide-fix | ✅ 归档 |

**排除（真失败，保持不动，8 个）**：cluster-twin-chat、hk-smoke-test-improve、
paid-model-price-compare-v2、terraria-world3、test-scp-improve、
win-hide-e2e-verify-improve、win-hide-e2e-verify-improve.test-improve、
win-hide-e2e-verify-improve.test。

> ⚠️ **额外发现（本次未动，单独上报）**：`cluster-task-notify-docs` 实为**成功摘要**
> （内容是 v2 发布完成总结），但正文含"任务 .DONE/.FAILED → hk-alert.js"字样，
> 被 web 的 `/\.FAILED/i` **子串匹配**误判为失败。真失败应为 **8 个**，
> web 显示的 9 个中含此 1 个误判。根因是失败检测用了子串而非行首锚点 `^\.FAILED`。

## 四、自动归档机制（butler.js）

`cleanupMisjudged()` 函数已加入 butler.js（主循环 `cycle()` 中，主管家、节流 60s）：

- 扫描 inbox 中仍为 `.DONE` 命名且内容含误杀特征的标记
- 自动改名 `<name>.DONE.misjudged-20260809`（证据保留，不参与统计）
- 归档对应 `.md`/`.PID` 到 `inbox/archive/`
- 记 `[清理]` 活动行到 twin activity.log
- **幂等**：只处理未归档的（已归档的 `.DONE.misjudged-*` 跳过；无残留时近零开销）
- 真失败（内容不含误杀特征）绝不误归档

**验证**：模拟一个"未来误杀"标记 → 函数自动归档成功；幂等复跑命中 0。✅

## 五、统计口径（web/server.js 加固）

- 新增 `misjudgedArchived(name)`：检测 `<name>.DONE.misjudged-*` 是否存在
- `listTasks`：跳过误杀归档任务（不进失败/待处理/运行统计）
- `shutdownPending`：误杀归档任务不算"待处理"（不阻塞关机判定）
- 已归档任务因 `.DONE.misjudged-*` 不匹配 `^(.+)\.(md|DONE|PID)$`，天然移出统计；
  上述加固为防御性兜底。

## 六、统计结果

- 清理前：失败 19 个（10 误杀 + 8 真失败 + 1 成功误判 cluster-task-notify-docs）
- 清理后：真失败 **8 个**（误杀 10 个已移出）
- 归档 10 个误杀标记 + 对应 md/pid 均已落 `inbox/` 与 `inbox/archive/`，审计可查

## 七、后续动作

1. **butler 重启后自动归档巡查生效**（当前 butler PID 35404 为旧代码在跑，
   改动已就位，重启即加载；因误杀不会再发生，巡查为安全网，不阻塞任何功能）
2. 建议（可选）：把 web `listTasks` 失败判定从 `/\.FAILED/i` 收紧为 `/^\.FAILED/i`，
   可消除 cluster-task-notify-docs 这类"成功摘要含 .FAILED 字样"的统计误判
