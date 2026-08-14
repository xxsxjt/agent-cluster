# recall-officer 职责落地（回忆官，learning-officer，2026-08-11）

> 用户 2026-08-11 20:0x 明示：回忆不只是用户问——智能体要**喜欢回忆**：定期回望过去（对话/决策/成功/失败/纠正），像人翻旧日记一样**重新收获**（新视角/遗漏/关联/改进启发）——收获进入进化体系。职责归 learning-officer。

## 完成内容

### 一、被动回忆（用户问"上次那个XXX"）
**开发 `agents/learning-officer/tools/recall.js`**（多库检索核心）：
- **多库检索**：knowledge/*（meetings/reviews/corrections/artifacts）+ work_record.md + chat-signals.jsonl + pi 会话（~/.pi/agent/sessions/ 按 mtime 取活跃目录）+ user-profile references
- **检索维度**：关键词（多词任一命中）+ 时间范围（--days）+ 实体词；输出结构化（来源库/文件/行号/内容片段）
- **限量铁律**：grep 定位命中文件 → 每文件只取命中行片段（220 字符截断），绝不 cat 全文/全盘 find；会话文件巨大按目录最新 mtime 取活跃目录 + 每目录最新 15 个 jsonl
- 支持 `--json` 结构化输出、`--sources` 指定库

用法示例：
```
node tools/recall.js search --q terraria --days 30 --max 8
node tools/recall.js search --q cnb 回收 --days 7 --max 6
node tools/recall.js search --q APP 发布 --days 4 --sources sessions
```

### 二、主动回忆（像人一样）
recall.js 内置 3 个子命令：
1. **每日轻回顾 `reflect`**：读当天 chat-signals + knowledge meetings + inbox .DONE → 生成 memory/reflections/<date>.md → 由执行智能体填 1-3 条真实"收获"（非流水账）
2. **每周深回顾 `week`**：生成进化草稿到 evolution-drafts/pending/week-recall-<date>.md（重读 1-2 周前关键决策 → 重新收获 → 走进化流程）
3. **任务联想**：复盘时用 recall.js 检索过去类似任务（"这让我想起 X 的 Y"）借鉴/避坑

### 二.5、多角色论证回忆（精神分裂式多角色）
recall.js `argue` 子命令生成工作单（memory/argue/）：5 个角色（执行者/现在的我/用户视角/批评者/关联者）各自独立用 recall.js 检索相关记忆 → 各写回忆陈述 → 交叉论证 → 综合产出（共识/分歧/存疑标注）→ 进 reflections + 进化草稿。复用服务器聊天室多频道论证模式。

### 三、触发接入
- **auto-schedule 加 `daily-reflection` 调度**：每日 23:00 例会前 dispatch 给 learning-officer，自动写 inbox/daily-reflection-<date>.md
- 每周深回顾：手动/定时（可参考 daily 的 hour 配置加 weekly）

## 验证

### ✅ 1. 被动回忆场景（"上次那个 terraria 的事"）
```
node tools/recall.js search --q terraria --days 30 --max 8
→ 命中 10 条，跨 knowledge(pitfalls/channel-intelligence) + work_record + chat-signals + reviews/daily-material，每条约 30 天，来源行号可查
```

### ✅ 2. 每日轻回顾 → reflections 文件（有收获非流水账）
`node tools/recall.js reflect --date 2026-08-11` → memory/reflections/2026-08-11.md，含 3 条真实收获：
1. "重跑成功"≠"根因消除"（cnb-usage-restore 软超时 bug 被成功掩盖）
2. 失败判定机制是框架高频故障族（孤儿进程/PID/软超时/误判重派）
3. 执行载体向 HK/CNB 迁移方向（hk-exec-hub 落地）

### ✅ 3. 多角色论证（主题：8/9 cnb-usage-restore 卡死决策）
`node tools/recall.js argue --topic "8/9 的 cnb-usage-restore 卡死决策" --days 15 --max 4` → 工作单 → 填成完整报告 memory/argue/argue-20260811-cnb-usage-restore.md：
- **5 角色各陈述**：执行者（当时判卡死→重派，根因=软超时看错日志）、现在的我（升级视角：是判据 bug 非运气）、用户视角（要的是打通结果）、批评者（纠错：假闭环，8/11 improve 又卡死）、关联者（孤儿进程/误判重派同族）
- **交叉论证**：批评者纠错执行者成立；关联者扩展问题边界；两处存疑标记（不强行统一）
- **综合产出**：3 条共识 + 2 处分歧 + 3 条新收获

### ✅ 4. 每周深回顾 → 进化草稿
`node tools/recall.js week --date 2026-08-11` + 检索 8/4~8/8 信号 → evolution-drafts/pending/week-recall-2026-08-11.md（3 条重读收获 + 建议走进化流程条目）

### ✅ 5. 调度触发
`node lib/auto-schedule.js force daily-reflection` → inbox/daily-reflection-2026-08-11.md 成功生成

## 遗留
- 每日回顾调度 23:00 触发依赖但管家正常跑（butler 每分钟 check auto-schedule）
- 每周深回顾目前手动触发；可后续加 weekly 定点调度
- 任务联想（四）依赖 review-loop 复盘时主动调用 recall.js——已在 recall.js 提供检索能力，接入 review-loop 属可选增强

## 产出清单
- `agents/learning-officer/tools/recall.js`（检索核心 + reflect/week/argue 子命令）
- `agents/learning-officer/memory/reflections/2026-08-11.md`（每日回顾，含收获）
- `agents/learning-officer/memory/argue/argue-20260811-cnb-usage-restore.md`（多角色论证完整报告）
- `evolution-drafts/pending/week-recall-2026-08-11.md`（每周深回顾进化草稿）
- `lib/auto-schedule.js` + `config/auto-schedule.json`（daily-reflection 调度）
- `inbox/daily-reflection-2026-08-11.md`（自动调度任务，可跑真实验证闭环）
