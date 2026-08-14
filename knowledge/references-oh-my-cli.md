# 参考：oh-my-cli（qwen-code-dev-bot/oh-my-cli，Apache-2.0）— 自托管 code-agent CLI

> 2026-08-05 学习记录（⚠️ 2026-08-11 发现本文件曾为空 0 字节，此处补录关键要点；深挖见 reference-repos.md ⭐⭐⭐ 行）。
> 自托管 code-agent CLI：安全护栏 + 会话管理 + headless 模式。Apache-2.0（Copyright 2026 qwen-code-dev-bot contributors）。

## 核心可借鉴（对虚无框架）
1. **进化治理（AUTONOMY.md）**：自主度分级/授权边界文件化——agent 什么能自主做、什么需审批，用文档约束而非代码硬编码。对应我们 pi-evolution 的"先草稿、后审批"治理。
2. **安全边界铁律**：AI 操作的安全护栏——破坏性/外部操作设阈值，越界触发确认。
3. **证据链**：操作留痕（做了什么/为什么），可追溯审计。对应我们 org/logs 审计。
4. **预算控制**：token/成本预算上限，防失控。

## 落地映射
- AUTONOMY.md 分级 → 我们的"用户授权/自我繁衍审批"机制可参考
- 证据链 → butler/hub 操作日志已接近，可补"决策理由"字段

## 学习来源
- https://github.com/qwen-code-dev-bot/oh-my-cli（Apache-2.0，保留 LICENSE）
