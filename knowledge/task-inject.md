# 任务注入规范速查（task-inject.md）

> 维护者：learning-officer / night-worker（2026-08-12 乱码根治建立）
> 用途：butler 派发任务时自动把本文件内容注入任务 prompt（lib/knowledge-inject.js）。
> **执行任务的智能体在收到任务时，下面的规则自动生效，无需额外查找。**
> 规则更新：直接改本文件，下一次任务派发自动携带最新版（实时读取，无缓存）。

## 编码铁律（UTF-8，2026-08-12 用户强调"乱码一直没根"）

1. **所有文件读写一律 UTF-8**——Windows 上 python 默认 GBK 写文件（乱码根源），**python 写文件必须显式 `encoding='utf-8'`**（open(path, 'w', encoding='utf-8')），读文件同理（读取乱码文件时 errors='replace' 容错）
2. **写 DONE/标记/日志/知识文件**：优先用官方工具
   `node C:\Users\du_ji\pi_workspace\org\scripts\write-done.js <任务名> "<一行摘要>"`
   （node 默认 UTF-8，自带 UTF-8 校验，写坏即删除拒绝）
3. **文件名**不得含 U+FFFD 替换符（乱码特征）；任务名/摘要中文一律 UTF-8 落盘
4. **禁止**在脚本里用 `print > file`、PowerShell `Set-Content`（默认 ANSI/GBK）、python 裸 `open(p,'w')` 写中文
5. 验证自己产出的文件：`file <文件>` 应显示 UTF-8，或用 `python -c` 读回确认无 `\ufffd`

## 知识库（必读顺序）

1. 全局规范：`C:\Users\du_ji\pi_workspace\org\knowledge\conventions.md`（组织公约，改配置/行为前必读）
2. 踩坑经验：`C:\Users\du_ji\pi_workspace\org\knowledge\pitfalls.md`
3. 用户愿景/产品方向：`C:\Users\du_ji\pi_workspace\org\knowledge\PRODUCT-VISION.md`
4. 本组/个人记忆：`org\groups\<组id>\memory\group-diary.md` → `org\agents\<id>\memory\diary.md`（后覆盖前）
5. 涉及历史/领域问题：先查对应智能体的 `artifacts/`（三序：记忆→源码→问用户）

## 执行完整性（过程异常与处理——2026-08-12 用户+魇. 共识，机制强制）

1. **过程异常必须记录**：执行中遇到任何异常/失败/绕行（连不上、超时、报错、被拒、绕道完成等）——**不许静默绕过**——任务产出必须写明：遇到什么 / 怎么绕的 / 能不能修 / 修了没 / 需不需要问用户。
2. **异常处理链**：修得了就修（最小改动）→ 修不了 → **记录 + 问用户**（写 inbox/ask-<对方>.md 或 DONE 里明确「需用户决策」）——不是「换下一个」完事。
3. **沉淀强制**：完成前自查「这轮有没有该沉淀的坑」——有 → 写 artifacts/或追加 knowledge/pitfalls.md（格式：场景/错误/根因/解法/时间/踩坑者）；框架机制类的坑在 artifacts 里留痕即可。
4. **DONE 摘要格式**：正常任务一行摘要；**有过程异常的任务**摘要末尾追加 `[过程异常: <一句话处理结论>]`（如 `[过程异常: 目标端口连不上→已降级备用通道，已修复]`），详情写 artifacts。
5. **butler 自动审计**（2026-08-12 起）：任务内容含异常特征词但 DONE 无过程记录 → 记入 logs/exec-completeness-violations.jsonl 并告警；异常有处理记录 → 自动捕获为沉淀候选（knowledge/pitfalls-inbox.md，待 learning-officer 合并）。

## 任务规范

- 完成任务写 `inbox/<任务名>.DONE`（一行摘要）；失败写 `.FAILED: <原因>`（内容首词须为 .FAILED）
- 任务文件头部声明 `agent:` / `group:` / `provider:` / `model:` / `target:` 等路由参数
- 一个任务只做一个目标；多目标拆多个任务
- 共享资源标注 `writes:` / `reads:`（见 conventions 资源锁）

## 纪律速查

- 上下文铁律：禁止全量 cat/读取大文件（jsonl/日志/数据库导出）——grep/head/tail/wc 精准取片段
- 禁止全盘 find/全盘 grep
- 进程拉起必须隐藏（bootstrap.js / vbs 包装）
- 桌面重操作（启动应用/模拟器/装软件/重启服务）先问用户
- 汇报格式：短标题 + 详情（标题 ≤15 字）
- 隐私铁律：微信数据/user-profile 只走可信渠道（deepseek 官方/自有基础设施）
