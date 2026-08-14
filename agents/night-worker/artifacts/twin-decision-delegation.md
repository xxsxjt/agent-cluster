# 决策委托分身机制（twin-decision-delegation）

**日期**: 2026-08-08
**执行者**: night-worker
**需求来源**: 用户 2026-08-08 明确"这种决策让我分身决定，以后都是，全部任务都是，不要卡在这种地方"

## 目标
框架层面让**任何任务遇到决策点不再卡用户**，由分身（twin 大脑，user-twin 人格）代为决策。仅红线（花钱/永久删除/法律风险/超授权范围）升级用户。

## 机制设计

```
子智能体/管家遇决策点
  → 写 org/inbox/decisions/<ts>-<task>.md（问题+上下文+选项）
  → twin-daemon 巡查捡起（5 分钟周期 / --once 可立即触发）
      ├─ 红线检测（classifyRedLine，排除否定语境）→ 升级用户，分身不代决策
      ├─ 超时兜底（30 分钟无决策）→ 记录"决策超时待用户"，不无限等
      └─ 决策点 → 分身大脑（user-twin 人格）决策
          → 写 decisions/<ts>-<task>.decision.md（决策+理由）
  → butler 扫描 .decision.md（15s 周期）
      ├─ 红线/超时 → 升级用户待确认，不自动恢复
      └─ 决策点 → 恢复任务执行
          · 源任务仍在跑且可插嘴 → 直接 steer 决策进 agent 上下文
          · 源任务已结束 → 重派 <src>-resume 任务（注入决策继续）
  → 决策请求/结果归档 inbox/decisions/archive/ 供审计
  → 分身 activity.log 记录 [决策] 行
```

## 判定规则

### 决策点（分身代决策）
- 注册测试账号、继续挖/换面、任务拆解方式、方案 A/B、预算内分配、非敏感数据使用

### 红线（升级用户，分身绝不代决策）
- 花钱/付费、永久删除/破坏、法律风险/超授权范围、涉及隐私数据出圈、真实资金操作
- 红线正则：`REDLINE_PATTERNS`（花钱付费/永久删除/法律违规/隐私出圈/真实资金 五组）

## 实现清单

### lib/twin-daemon.js（分身侧）
- `DEC_DIR` = `inbox/decisions`，`DEC_TIMEOUT_MS` = 30 分钟
- `REDLINE_PATTERNS` 五组红线正则
- `classifyRedLine()` — 红线判定（**含否定语境排除**，本轮修复）
- `buildDecisionFile()` / `archiveDecision()` / `scanDecisions()` — 决策委托主流程
- `runPatrol()` 已接入 `scanDecisions()`

### butler.js（管家侧）
- `scanDecisionResults()` — 读取 .decision.md，区分红线/决策点
- `resumeTaskWithDecision()` — 源任务可插嘴则 steer，否则重派 <src>-resume
- `detectSourceAgent()` — 从源任务文件推断执行 agent
- 主管家主循环已接入 `scanDecisionResults()`

## 验证（全 E2E 通过）

### ✅ 决策点链路（是否注册测试账号）
1. 写入 `decisions/20260808-123724-test-reg-account.md`
2. 分身大脑决策：**"选A：注册测试账号（一次性邮箱）"**，理由贴合 du_ji 决策启发式
3. `.decision.md` 落盘，`activity.log` 记录 `[决策] test-reg-account 分身已决策`
4. butler 读取后派发 `test-reg-account-resume` 恢复任务（恢复链路触发）

### ✅ 红线链路（是否删除生产库）
1. 写入 `decisions/20260808-123755-test-drop-prod.md`（含"永久不可恢复"）
2. 分身**不代决策**，`activity.log` 记录 `[决策] test-drop-prod 触发红线 → 升级用户`
3. decision.md 内容 `决策: 升级用户`，类型 `红线`
4. butler 读取：`🚨 决策[test-drop-prod] 红线：升级用户 — 升级用户待确认，不自动恢复`，不自动恢复

### ✅ 修复的 Bug：红线否定语境误判
初始测试发现"是否注册测试账号（无付费）"被误判为红线（正则匹配"付费"子串，未排除"无付费"否定语境）。修复 `classifyRedLine`：用 `matchAll` 定位匹配位置，检查匹配串前 3 字是否含 `无不免零没未` 否定词，有则跳过。验证用例：
- `无付费`/`免费`/`不花钱`/`免费额度内` → 非红线 ✅
- `需要付费购买`/`花钱买服务器`/`删除生产库（永久不可恢复）` → 红线 ✅

### ⏱️ 超时兜底（静态验证）
`scanDecisions` 中 `Date.now() - st.mtimeMs > DEC_TIMEOUT_MS` → 写 `决策超时待用户`，不无限等。（30 分钟阈值，未实际等待，代码逻辑验证通过）

## 运行状态
- twin-daemon 已重启加载新代码（PID 480，含决策委托 + 红线否定修复）
- butler 健康（PID 31720，含决策恢复逻辑）
- `inbox/decisions/` 目录已创建（含 archive）

## 与 twin-supervision-loop 共存
- **讨论**（supervision-loop）= 主动议题（分身巡查验收发现完善空间→跟管家讨论）
- **决策**（delegation）= 任务内被动请求（执行遇决策点→分身代决策）
- 两者通道独立（discussion/ vs decisions/），互不干扰，均记 activity.log

## 后续建议
- 决策请求文件头部约定（`- 源任务`/`- 问题`/`- 上下文`/`- 选项`）应写入 README 供子智能体遵循
- 红线命中时可增强：记录问题摘要到 `pending-main.jsonl` 待用户下次打开主会话时处理
