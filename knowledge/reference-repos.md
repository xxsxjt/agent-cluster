# 参考仓库清单（高价值，持续更新）

> 2026-08-05 建立。规则：**每次参考前先确认 LICENSE**（见 conventions.md）；本清单记录协议/价值/优先级，仓库会持续更新，learning-officer 定期检查新版本。
> 学习顺序：⭐⭐⭐ 优先深学 → ⭐⭐ 参考 → ⭐ 了解。

## ⭐⭐⭐ 优先深学（与虚无框架直接相关）

| 仓库 | 协议 | 定位 | 学什么 |
|---|---|---|---|
| garrytan/gbrain | MIT ✅ | Agent 大脑层（Garry Tan，YC CEO）：合成层+自布线知识图谱+差距分析，146k 页生产级 | **记忆体系 v2 蓝图**：知识图谱（zero-LLM 实体抽取）、差距分析（知道什么/不知道什么）、公司大脑（多用户分片+隔离） |
| thedotmack/claude-mem | Apache-2.0 ✅ | Claude 跨会话记忆扩展 | **专属记忆实现**：会话记忆持久化/检索 |
| shareAI-lab/learn-claude-code | MIT ✅ | Claude Code harness 工程最佳实践 | 提示词/工具工程/会话管理，框架工程直接可抄 |
| qwen-code-dev-bot/oh-my-cli | Apache-2.0 ✅ | 自托管 code-agent CLI：安全护栏+会话+headless | **进化治理**（AUTONOMY.md）、安全边界铁律、证据链、预算控制 |
| KKKKhazix/human-writing | MIT ✅ | 活人感写作 skill（去 AI 味） | 已安装到 ~/.agents/skills/human-writing/，内容创作组用 |

## ⭐⭐ 参考

| 仓库 | 协议 | 定位 | 学什么 |
|---|---|---|---|
| openclaw/openclaw | MIT ✅ | 多设备个人 AI 助理（Garry Tan 系） | 多端接入+设备协调 |
| NousResearch/hermes-agent | MIT ✅ | Hermes 桌面 Agent | 桌面端形态 |
| openai/codex | Apache-2.0 ✅ | OpenAI 官方 code agent | 官方 agent 架构 |
| anthropics/claude-code | 自研许可 ✅ | Claude 官方 | 官方 agent 架构 |
| anthropics/claude-cookbooks | MIT ✅ | Claude 官方食谱 | 官方示例库 |
| can1357/oh-my-pi（oh-my-pi-main） | MIT ✅ | 增强版 pi（omp） | 前端/协议/加密/多代理（secret obfuscation/Agent Hub/advisor 双模型/task schema 返回——已深学） |
| doncheli/don-cheli-sdd | Apache-2.0 ✅ | SDD（Specification-Driven Development）框架，PRD Generator | **PM 智能体蓝图**：/dc:specify→clarify→tech-plan→breakdown 六阶段流水线 + 质量门禁（Gherkin 验收/覆盖率≥85%）+ 需求→可执行任务闭环（2026-08-08 pm 节点建） |
| nanagajui/agentic_prd | MIT ✅ | Agentic PRD 生成器 | **PRD 结构化参考**：LLM 生成需求文档的拆解/范围/验收流程（2026-08-08 pm 节点建） |

## ⭐ 了解

| 仓库 | 协议 | 定位 |
|---|---|---|
| Alishahryar1/free-claude-code | MIT ✅ | 免费 Claude Code 方案（渠道参考）|

## 学习记录（已产出）
- knowledge/references-oh-my-cli.md：进化治理/安全边界/证据链（2026-08-05）
- knowledge/references-gbrain.md：记忆体系 v2 蓝图（合成层/零 LLM 图谱/隔离审核/差距分析）（2026-08-05）
- knowledge/references-claude-mem.md：渐进式披露 3 层检索/记忆压缩（2026-08-05）
- knowledge/references-learn-claude-code.md：Harness 工程最佳实践（上下文四层压缩/记忆四类/文件收件箱/自治看板/任务依赖图）（2026-08-11）
- knowledge/references-oh-my-pi.md：增强版 pi（secret obfuscation/Agent Hub/advisor 双模型/task schema 返回）（2026-08-11）

## 待收录（用户提到的 UUMit 生态——地址待用户提供）
> 用户 2026-08-11 提到，地址未给，先占位。用户给了就补进清单（标学什么）。
- **WorkBuddy**（占位）— 待地址 → 学：？
- **LobsterAI**（占位）— 待地址 → 学：？
- **Marvis**（占位）— 待地址 → 学：？

## 可借鉴点评估（2026-08-11，结合用户"优势学过来"）
> 详见 PRODUCT-VISION / roadmap。从现有清单提炼 3 个最值得抄进框架的能力：
1. **gbrain 知识图谱 + 差距分析** → 记忆体系 v2 蓝图（零 LLM 实体抽取 + 隔离审核 + "还不知道什么"）——解决 agent 失忆。
2. **learn-claude-code 上下文四层压缩** → 机制化解决 353K 上下文被杀问题（预算落盘 + 旧 tool_result 占位 + LLM 摘要）。
3. **oh-my-pi secret obfuscation** → 隐私隔离铁律机制化（provider 前混淆 + 工具执行前还原），配合 Agent Hub 集群看护。

## 更新机制
- learning-officer 每 2 周检查一次本清单仓库的新版本（git fetch + 看 CHANGELOG/Release）
- 高价值更新 → 更新对应 references-*.md + 通知分身
| alchaincyf/huashu-skills | ? | ���� Skills��ǰ��/����ࡪ���û� 2026-08-12 �Ƽ�����APP/��ҳǰ���޸��ã�| ��ȷ�� LICENSE����ǰ�� skill �� |
| alchaincyf/huashu-design | ? | ������ƣ�ǰ����ƹ淶/�����| ͬ�ϡ���APP UI �޸��ο� |
| alchaincyf/huashu-md-html | ? | MD��HTML ת��/��ʽ | ͬ�ϡ����ĵ�/ҳ�� |
