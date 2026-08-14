# 产品经理智能体（pm）加入管家域组 — 落地报告

> 2026-08-08 落地。用户 2026-08-07 02:29 要求"管家组加一个产品经理"，8/8 确认落地。

## 一、调研参考（知识库 + GitHub）

参考库 `org/knowledge/reference-repos.md` 原有仓库均为 agent/框架方向，无产品规划/需求分析类，故从 GitHub 补找并评估 2 个高质量项目（均确认 LICENSE 合规）：

| 仓库 | 协议 | Stars | 定位 | 可借鉴 |
|---|---|---|---|---|
| doncheli/don-cheli-sdd | Apache-2.0 ✅ | 57 | SDD（Specification-Driven Development）框架，内置 **PRD Generator**，6 阶段流水线 + 质量门禁 | 需求→可执行闭环：specify(idea→Gherkin)→clarify(消除歧义)→tech-plan→breakdown(TDD 任务拆解)→implement→review；质量门禁（覆盖率≥85%、零 TODO 桩） |
| nanagajui/agentic_prd | MIT ✅ | 11 | Agentic PRD 生成器（LLM 自动出需求文档） | PRD 结构化：目标/范围/用户故事/验收流程的拆解与自动生成 |

**结论**：采用 don-cheli-sdd 的"需求→拆解→验收"闭环思想塑造 pm 职责（clarify 消除歧义 → breakdown 可验证任务包 → review 评审），并吸收 agentic_prd 的 PRD 结构化模板。两个项目已加入 reference-repos.md ⭐⭐ 参考段。

## 二、节点构建

org.json 新增 `pm` 节点：
- **id**: pm | **label**: 产品经理（PM）| **parent**: grp-coo（管家域组）| **spawnType**: pi（默认 deepseek 官方渠道链）
- **keywords**: 产品规划、需求分析、PRD、方案设计、项目规划、需求拆解
- **status**: active（按需 lazy 唤醒）

## 三、身份/技能沉淀

- `agents/pm/identity.json` — 完整身份（persona / capabilities / keyPaths / collaboration / notes）
- `agents/pm/AGENTS.md` — 职责与协作链路（web 面板判定"可对话智能体"的依据）

**职责**（只做三件事，不写业务、不写代码）：
1. 需求结构化：把用户想法/分身判断转成无歧义 PRD（目标/范围/用户故事/验收标准/边界）
2. 任务拆解：PRD → 可派发可验证的任务包（P0/P1/P2 排序）
3. 方案评审：从"是否满足原始需求"角度评审落地结果

## 四、协作关系（写入 identity.collaboration）

```
用户想法 → 分身(twin)转交 → PM 出 PRD/任务拆解 → 管家(coo)派发
        → 业务/技术智能体执行 → 结果回流 PM 评审 → 分身(twin)验收
```
- **twin**：需求源头。接需求/澄清，PRD 回流 twin 决策验收
- **coo**：执行派发。PM 只出拆解，不直接派活，由 coo 路由
- **night-worker**：技术实现评审。出方案前咨询可行性/成本；落地后 night-worker 技术评审，PM 需求评审

## 五、验证结果

- ✅ org.json 解析正常（node -e require 通过，version 5.0）
- ✅ registry 注册正常（pm 节点，parent=grp-coo）
- ✅ grp-coo.children 已含 pm
- ✅ 控制台可对话列表出现 pm（web server /api/state chatAgents 含 pm，dialogueable=true，grp-coo 下渲染）
- ✅ identity.json / AGENTS.md 解析正常
- ✅ 未改动其他节点

## 改动清单
- `org.json` — 新增 pm 节点 + grp-coo 无改动
- `org/knowledge/reference-repos.md` — 新增 2 个 PM 参考仓库
- `agents/pm/identity.json`、`agents/pm/AGENTS.md` — 新建
- `agents/night-worker/artifacts/pm-agent.md` — 本报告
