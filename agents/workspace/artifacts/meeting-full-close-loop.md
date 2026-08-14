# 例会完整闭环补全（meeting-full-close-loop）

> 执行：workspace（night-worker 域）· 2026-08-13 16:0x
> 任务文件：`inbox/meeting-full-close-loop.md` · 状态：✅ 完成
> 基础：meeting-close-loop（卡点闭环，git 18098da）——**扩展不重做**

## 一、背景与用户诉求

用户 2026-08-13 连续两次指出例会闭环不全：

1. **「例会不只是卡点修复的问题，不是还有后续规划吗，然后自动学习呢？」**
   - 22 个智能体例会里都有「明日计划」（规划类），但**无系统转派**——靠智能体自己记得（不记得就没了）
   - 例会内容（经验/教训/新发现）→ learning-officer 提炼→进化的**链路未确认**
2. **「例会=群聊形态 + 闲时智能体主动找活」**
   - 例会发现的**异常情况**（空转/无任务/低产出/重复）必须**自动转派处理**（激活该智能体），不是记录完就完
   - 例会后智能体**互相评价与交流建议**（"有没有后续各个智能体都评价一次以及交流提出建议呢"）

## 二、方案：例会完整闭环五通道

在 `lib/meeting-close-loop.js`（原卡点闭环）基础上扩展为**五通道自动闭环**，例会管理组小会后统一触发（daily-meeting Phase 4.5），全部不靠人记得：

| 通道 | 提取器 | 转派 | 产出 |
|---|---|---|---|
| A 卡点 | `extractBlockers`（已有） | `meeting-card-*` 修复任务（域路由） | artifacts 根因/修复/验证 |
| B 明日计划 | `extractPlans`（新增） | `meeting-plan-*` 待办任务（**转派给计划归属智能体本人**） | 完成 .DONE 即销号；清单含待办汇总表（计划→任务→销号） |
| C 异常发现 | `extractAnomalies`（新增） | `meeting-anomaly-*` 激活任务（**转派给异常涉及方**，如 mc-dev-earth 长期空转→mc-dev-earth） | 自查 backlog/列可推进事项/评估存在合理性 |
| D 自动学习 | `extractLessons`（新增） | `meeting-learn-<id>-batch` **批量 1 条**（防 19 条信号=19 任务的信号风暴）→ learning-officer | 学习信号明细落盘 `knowledge/meetings/meeting-learn-<meetingId>.md`（产出可见） |
| E 例后互评 | — | `meeting-peer-*` 每人 1 条（读全员材料→挑 2-3 人给建议/协作提议） | 互评任务投递 |

**关键设计**：
- **幂等**：统一幂等游标 `logs/meeting-close-loop-state.json`（通道前缀+文本指纹），重跑只跳过
- **防任务风暴**：计划/异常/学习/互评任务头部 `priority: low` + butler `URGENT_MARKERS` 追加 `meeting-*` 前缀（自动派发类，低优先排队）——63 条计划不会挤占真实任务
- **多段卡点提取修复**：原 `extractBlockers` 用 `break` 只提取**第一个智能体**的卡点段（8/12 材料只提 3 条）→ 改为多段提取（修复后 40 条，**漏提 92% 的严重 bug**）
- **异常归属精确化**：`anomalyAgentId()` 从异常文本提取 registry 中的涉及方 id（mc-dev-earth），而非汇报人（mc-dev）

## 三、接入点

`lib/daily-meeting.js` Phase 4.5（例会管理组小会后自动调用）：

```js
const r = closeLoop.runFullCloseLoop(materialFile, {
  peerReview: true,
  peerReviewReporterIds: 全员大会实际出席者,
});
```

CLI 手动：`node lib/meeting-close-loop.js <meetingFile> [--dry-run] [--force] [--no-peer]`

## 四、验证（模拟例会全要素）

**模拟材料** `scratch/meeting-sim-2026-08-13-material.md`（twin/server-admin/mc-dev/learning-officer 4 人，含卡点×4+明日计划×4+经验教训+空转异常）：

| 验证项 | 结果 |
|---|---|
| 四通道提取 | 卡点 4 / 计划 4 / 异常 1 / 学习 2 ✅ |
| 卡点路由 | patrol→learning-officer、CNB 桥→night-worker ✅ |
| 计划归属 | twin/mc-dev/learning-officer 各归各人 ✅ |
| 异常归属 | mc-dev-earth 长期空转 → **mc-dev-earth**（非汇报人 mc-dev）✅ |
| 真实转派 | 12 条任务 + 4 条互评 + 清单落盘 + 学习信号落盘 ✅ |
| **端到端** | HK butler 自动捡起模拟任务并真实执行（.PID/.DONE 产生）——调度链全通 ✅ |
| 幂等 | 重跑 10 条全跳过 ✅ |
| 旧入口兼容 | runCloseLoop 仍工作 ✅ |
| 空材料安全 | 无卡点/无计划/无异常不炸 ✅ |
| 单测 | `test/meeting-close-loop.spec.js` **22/22 通过** ✅ |

**真实例会材料回归**（2026-08-12-material.md，22 智能体）：卡点 40 条（原 3 条）/ 计划 63 条 / 异常 6 条 / 学习 19 条——多段提取修复后卡点漏提率从 92% 降到 0。

**模拟任务已清理**（37 文件归档 `scratch/meeting-sim-cleanup/`，幂等状态已删模拟键，inbox 0 残留），清单/学习信号文件保留为验证证据（`knowledge/meetings/meeting-close-loop-meeting-sim-2026-08-13.md`、`meeting-learn-meeting-sim-2026-08-13.md`）。

## 五、部署（HK 生产 = 例会实际运行端）

- 本机→HK 同步：`lib/meeting-close-loop.js`（新增）+ `lib/daily-meeting.js`（Phase 4.5 升级）+ `butler.js`（URGENT_MARKERS）+ **补齐 HK 缺失 6 模块**（agent-rescue/anomaly-fallback/exec-completeness/knowledge-inject/related-agents/session-reuse——butler 启动缺依赖崩溃的根因，顺带修复）
- HK butler 已重启加载新代码（systemd org-butler，PID 3088102，active）
- 部署前备份：`daily-meeting.js.bak-full-close-loop-20260813` / `butler.js.bak-full-close-loop-20260813`
- HK 侧 dry-run 与真实例会材料结果与本机一致

## 六、产出清单

| 文件 | 说明 |
|---|---|
| `lib/meeting-close-loop.js` | 五通道完整闭环（+8 函数：extractPlans/extractAnomalies/extractLessons/dispatchPlanTask/dispatchAnomalyTask/dispatchLearningBatchTask/dispatchPeerReviewTasks/anomalyAgentId/runFullCloseLoop） |
| `lib/daily-meeting.js` | Phase 4.5 升级为完整闭环（+互评） |
| `butler.js` | URGENT_MARKERS 追加 meeting-*（防任务风暴） |
| `test/meeting-close-loop.spec.js` | 单测 22/22 |
| `knowledge/meetings/meeting-close-loop-meeting-sim-2026-08-13.md` | 模拟验证清单（保留） |
| `knowledge/meetings/meeting-learn-meeting-sim-2026-08-13.md` | 模拟学习信号（保留） |
| 本报告 | artifacts/meeting-full-close-loop.md |

## 七、遗留/边界说明

1. **例会=群聊形态**：本次落地为「例会文件群聊」——全员发言汇聚材料（互相可见）+ 例后互评任务（互相@提建议）+ 日常 ask 通道（inbox/ask-<id>.md）。**聊天室真群聊**（HK new-api group conversation API 已存在：`POST /api/chat-room/conversations/groups` + members + messages）需要 xxsx-gateway 建"智能体+根用户"群并给智能体 bot 发言身份——**另开任务转派 xxsx-gateway**（已 ask）。
2. **计划任务量**：63 条计划全部转派是设计意图（每条都有销号），但会占排队——已用 priority: low + 自动派发类缓解；若用户嫌多可加 `--no-plan` 开关（未实现，需要再加）。
3. **异常检测词表**：ANOMALY_RE 基于关键词（空转/无任务/低产出等），有边界情况（如"无任务"用于描述正常等待）——已用"条目行+信号词"双重过滤控制误报，后续可按例会发现漏报/误报迭代词表。
