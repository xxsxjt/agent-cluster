# review-loop v2：加"反省/自我审查"层（2026-08-11，任务 review-loop-v2）

## 背景
用户批评（2026-08-11 12:5x）"总结优化不够全面，应该还有反省、自我审查，是不是能怎么做做的更好"——现有 review-loop 只做任务复盘（做了什么/问题/改进建议），缺**反省层**。本任务把"哪里做错/该问没问/违背原则/下次更好"四问加进每任务复盘，并让例会先看反省再谈改进。

## 落地
文件：`org/lib/review-loop.js`（self-review 层，与 improvement 同模式：规则基线 + 例会 flash 精化，保持轻量）

### 1. self-review 四问（`buildSelfReview`，同步规则基线，诚实模板）
每次任务复盘（DONE 钩子）自动生成，追加到条目 `selfReview` 字段：
- **①哪里做错/走了弯路**：失败→问题根因；成功→"尚未暴露明显错误（须例会核验产物才敢说）"
- **②该问没问**：信息不足硬猜提示（失败时"该先问用户/派对应智能体补齐信息再动手，而非硬跑消耗轮次"）
- **③违背原则**：`detectPrincipleBreach` 规则检测——任务涉及查服务器/版本/状态/日志/SSH 却未派 server-admin → 输出 `❌ 违反分工铁律——应派 server-admin`；否则诚实声明"未见明显违规信号，真伪留例会精化"
- **④下次更好**：一句话可执行建议（核验产物/沉淀经验/先补信息再重跑）

方法标注 `method: 'auto-heuristic'`（规则基线，例会 flash 精化——与 improvement 精化机制一致，避免每个任务多一次异步 LLM 调用，贴合"轻量"要求）。

### 2. 例会材料自我审查优先（`dailyReviewMaterial`）
- 新增 `## 〇、自我审查摘要` 区块置顶：当日 self-review 的 ③违背原则 + ④下次更好 + 关联纠正数
- 检测到违反分工铁律信号 → 加 `⚠️ 请在改进项中明确纠正` 列表
- 每条任务复盘内，**自我审查（反省①-④）排在"问题/改进建议"之前**
- daily-meeting 管理组小会 prompt 本就带 material 文件，改即生效（无需重启）

### 3. 纠正→反省→改进闭环串联（主会话 turn 级，加分项）
- `associateCorrection(taskName, text)`：把用户纠正原文追加到该任务 self-review 的 `corrections` 数组
- CLI：`node lib/review-loop.js link <任务名> "<纠正文本>"`
- 例会材料自我审查摘要展示 `🔗 关联纠正 ×N：<最新纠正>`

## 验证（全通过）
- 内置自检 6 场景全绿（新增场景6：四问生成/成功无违规断言/违反分工铁律检出/条目带 selfReview/纠正关联/材料含自我审查摘要）
- 真实跑 2 个演示任务端到端：
  - `v2demo-fail`（查服务器版本、无 agent、失败）→ selfReview.q3 正确检出 `❌ 违反分工铁律——应派 server-admin`，q1 归纳失败根因
  - `v2demo-succ`（server-admin 部署成功）→ selfReview.q3 无违规断言
  - 例会材料头部正确渲染"自我审查摘要优先 + 反省①-④"
- 修复误报：违反检测正则由 `/❌|违反|违背/` → `/^❌|违反/`（避免"未见明显违背"被误判为违规信号）

## 踩坑
- **并发 butler 重写竞争**：在线 butler 每 5 分钟跑 check，appendReview（追加）与并发进程全量重写交错会导致 jsonl 行截断损坏（实测 cpu-gate 行被截断）。属既有架构并发现象，非本次引入。已手工恢复有效行 + 丢弃损坏行 + 清理演示条目。演示验证时避免依赖长时文件完整性，改为 grep 即时确认。

## 生效方式
- 无需重启 butler（butler 每 5 分钟调 `check()`，改即生效）；新任务 .DONE 后自动带 selfReview 四问
- 例会 21:30 管理组小会材料自动含自我审查摘要（改配置即生效）

## 命令速查
- `node lib/review-loop.js check` 跑一轮（butler 每5min调）
- `node lib/review-loop.js summarize` 手动生成例会材料
- `node lib/review-loop.js link <task> "<纠正>"` 关联纠正到 self-review
- `node lib/review-loop.js test` 内置自检（6 场景）
