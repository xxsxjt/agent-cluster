# reference-deeplearn 产出（2026-08-11，learning-officer）

## 完成内容
1. **深学产出**（补齐 2 份）：
   - `knowledge/references-learn-claude-code.md`：Harness 工程最佳实践。核心 8 机制——上下文四层压缩（snip/micro/tool_result_budget/LLM 摘要+熔断+reactive，顺序不能换）、记忆四类+文件索引、Skill 两层按需加载、System Prompt 运行时组装、错误恢复、文件收件箱+队友线程、自治 WORK→IDLE→SHUTDOWN 看板认领、任务依赖图+worktree 隔离。附"抄进框架"优先级表（P0：上下文压缩+文件锁）。
   - `knowledge/references-oh-my-pi.md`：增强版 pi。四维度——secret obfuscation（provider 前混淆+执行前还原）、Agent Hub 看护（roster/revive/kill/steering）、advisor 双模型评审、task 返回 schema 对象；前端/ACP/collab 简述。附落地优先级（P0：secret 混淆+Agent Hub）。
2. **清单检查**：reference-repos.md 全部 14 仓库 LICENSE 逐一实测确认（MIT/Apache-2.0/自研许可全部与清单一致，无违规）。can1357/oh-my-pi 确认 MIT。
3. **新工具占位**：UUMit 生态 WorkBuddy/LobsterAI/Marvis 三占位（地址待用户提供，给了补进清单标学什么）。
4. **可借鉴评估**：3 个最值得抄进框架的能力写入 PRODUCT-VISION 第六节（知识图谱差距分析 P1 / 上下文四层压缩 P0 / Secret 混淆 P0）+ 附带 Agent Hub 看护/advisor 双模型/task schema。

## 额外发现并修复
- `references-oh-my-cli.md` 标记"已产出"但实际 **0 字节空文件** → 已补录关键要点（AUTONOMY 进化治理/安全边界/证据链/预算控制）。

## 说明
- oh-my-pi 的 VENDOR-PLAN 原存 scratch/，本次未找到（疑似已清理），本文档即补齐产出。
- 深学前已确认 LICENSE；两仓库均只读 README/docs/关键文件，未 cat 大文件。
