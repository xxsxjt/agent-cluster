# 执行完整性机制落地（execution-completeness）

> 执行者：workspace ｜ 时间：2026-08-12 23:5x ｜ 依据：conventions.md 第 11 条（用户+魇. 对话共识）
> 目标：把「过程异常记录/修复/沉淀」从自觉规范变成**机制强制**——不找最短路径。

## 背景：AI 通病（用户 2026-08-12 21:3x 认同）

- 只追目标，过程问题不记录不沉淀（"光顾着眼前干活，甚至都不写进去的"）
- 连不上直接试下一个——不修不问（"没有去修复干活中遇到的问题"）
- 用户纠正不留口头（"说了她也没强行记进去"）→ 要强制落地
- 找最短路径，能通就行（"寻找最短路径解决问题"）

conventions 第 11 条已写规范——**本任务把它变成机制**。

## 落地内容（4 层机制）

### 1️⃣ 任务模板强制注入（新任务自带该段，不靠人工提醒）
- `knowledge/task-inject.md` 新增「执行完整性（过程异常与处理）」章节（5 条）：
  ① 过程异常必须记录（遇到什么/怎么绕的/能不能修/修了没/需不需要问用户）——不许静默绕过
  ② 异常处理链：修得了就修（最小改动）→ 修不了 → 记录+问用户（ask 通道）——不是"换下一个"完事
  ③ 沉淀强制：完成前自查"这轮有没有该沉淀的坑" → pitfalls.md / artifacts
  ④ DONE 摘要格式：有异常的任务摘要末尾追加 `[过程异常: <一句话处理结论>]`
  ⑤ 说明 butler 自动审计会检查（威慑+兜底）
- `lib/knowledge-inject.js` 回退块同步核心规则（注入源损坏时规范不丢）
- 生效方式：butler 每次派发任务实时读取注入（lib/knowledge-inject.js 无缓存）——**无需重启即对后续所有任务生效**

### 2️⃣ butler 自动审计（lib/exec-completeness.js，新模块）
- `audit(name, taskContent, doneContent)`：任务内容含**异常特征词**（连不上/失败/超时/报错/绕行/error/refused/ECONN/404/429…）
  → DONE 无**过程记录特征**（过程异常/修复/绕行/沉淀/问用户…）= 违规（静默绕过嫌疑）
- `scanAndAudit(inbox, logs, knowledge)`：扫描 inbox 新增 .DONE：
  - 违规 → 写 `logs/exec-completeness-violations.jsonl`（含任务名/命中词/DONE 摘要）+ 控制台告警
  - 合规且有异常处理 → 自动捕获为沉淀候选 → `knowledge/pitfalls-inbox.md`（待 learning-officer 审核合并）
- 幂等：cursor（logs/exec-completeness-cursor.json）按 文件名+mtimeMs 去重，不重复处理
- 安全：.FAILED 跳过（失败原因本身即记录）；无任务文件对照的跳过（不误报）

### 3️⃣ butler.js 挂载
- `cycle()` 中新增执行完整性审计块（仅主管家、节流 60s、try/catch 不崩管家）
- ⚠️ butler 是常驻进程（require 缓存）——已预约 `restart-butler-on-idle.js` 空闲重启加载新模块（见下）

### 4️⃣ 验证闭环（真实投递）
- 投递 `inbox/verify-exec-completeness.md`（演练任务：模拟连不上 mock 端口 → 绕行本地方案 → DONE 必须含 [过程异常: ...]）
- 预期：执行者收到注入规范 → DONE 含过程异常记录 → 空闲重启后审计捕获为沉淀候选（pitfalls-inbox.md）→ 全链路闭环

## 验证结果

| 检查项 | 结果 |
|---|---|
| 单测 test/exec-completeness.spec.js | 17/17 通过（判定逻辑 8 + hitWords 1 + 集成 8，含幂等/边界/不误伤） |
| butler.js / lib 语法 | node --check 全过 |
| 模板注入 | task-inject.md 章节就位，下次派发自动携带 |
| 真实闭环 | ✅ 投递 verify-exec-completeness 演练任务（模拟 mock 端口连不上 → 绕行本地方案）→ 执行者 DONE 完整记录五要素（遇到什么/怎么绕的/能不能修/修了没/沉淀自查）→ 审计捕获为沉淀候选（pitfalls-inbox.md） |
| 捕获精确性 | 分层判定后重扫：历史 925 条 cursor 记住不重复，仅捕获 verify 1 条 |

### 历史洪峰数据（机制价值佐证）
首次审计 632 个含异常特征的历史任务：**445 个 DONE 无过程记录（70%）**——实证了用户判断"过程问题普遍不记录"；已一次性写入 logs/exec-completeness-violations.jsonl（作为基线证据），cursor 幂等保证今后只审计新任务。

### 分层判定（2026-08-12 收尾优化）
- **违规判定**（RECORD_PATTERNS 宽）：异常任务 DONE 无任何处理痕迹 → 违规
- **沉淀捕获**（CAPTURE_PATTERNS 严）：DONE 明确含"过程异常/沉淀/坑" → 才捕获候选——避免"修复 bug"类任务 DONE 误入捕获池（首版误捕 187 条 → 收紧后仅精确捕获）

## 文件清单

- `knowledge/task-inject.md` — 新增「执行完整性」章节（任务模板强制）
- `lib/knowledge-inject.js` — 回退块加核心规则
- `lib/exec-completeness.js` — 审计模块（新）
- `butler.js` — cycle() 挂载审计（60s 节流）
- `test/exec-completeness.spec.js` — 单测（新）
- `knowledge/pitfalls-inbox.md` — 沉淀候选暂存区（审计自动生成，learning-officer 审核合并）

## 后续动作

- [x] 验证任务闭环（模板注入 → 执行者记录 → 审计捕获沉淀候选）全链路完成
- [x] 历史基线：445 条违规已入 violations.jsonl（cursor 幂等，不重复）
- [ ] butler 空闲重启（已预约 restart-butler-on-idle.js，max-wait 120min）→ 审计随管家常驻生效
- [ ] learning-officer 定期合并 pitfalls-inbox.md → pitfalls.md
