# 管理组补全报告（manage-group-complete）

- **执行智能体**：night-worker（deepseek-v4-flash）
- **时间**：2026-08-08 20:3x
- **状态**：✅ 完成

## 一、任务概述

用户 2026-08-08 20:1x 明确三点：
1. **管家组 → 管理组**（改名）
2. **补齐管理组缺的智能体**：参考 ai-agent-playbook 的 `AI_MULTI_AGENT_COLLABORATION.md` supervisor 监督者角色（=审核）+ pending-user-tasks.md 里 8/7 用户规划的「信息搜集智能体」（未做）
3. **业务域补全**：只补「之前有做过的」（QQ 巡逻器 qq-watcher-bot 已常驻，归入 auto-bots 即可，不新建）；**不开发新业务**

## 二、改动清单

### 1. org.json 修改
- `grp-coo` label：`管家域` → **`管理组`**（id 保持 grp-coo 内部引用不动，只改显示 label）
- `grp-coo.children` 新增 `reviewer`、`intel-gatherer`（现共 11 个子节点，含 3 个业务域组）
- `grp-coo.keywords` 补充 审核/验收/质量门禁/情报/信息搜集
- `grp-coo.notes` 更新为管理组说明（分身唯一大脑 + 7 个管理职能 + 业务域组）
- `pm.notes` 同步「管家域组」→「管理组」
- `updatedAt` 更新为 2026-08-08T20:30:00.000Z

### 2. 新增智能体节点（org.json + 身份文件）

**审核官（reviewer）**
- id: `reviewer` / label: 审核官 / parent: `grp-coo` / spawnType: `pi`
- keywords: 审核、验收、质量、门禁、review、approval
- 职责：任务成果验收（DONE 质量/过审门禁/防谎报，对应「任务完成校验」理念 + Darwin 质量门禁思想）；分身(twin)验收的「执行手」（分身定标准，审核官跑验收：报告完整性/证据/回归）；发布前审核（APP 发布/文档发布）
- 文件：`agents/reviewer/identity.json` + `agents/reviewer/AGENTS.md` + `memory/`

**信息搜集官（intel-gatherer）**
- id: `intel-gatherer` / label: 信息搜集官 / parent: `grp-coo` / spawnType: `pi`
- keywords: 信息搜集、情报、微信、备忘、频道讨论、情报官
- 职责（按 pending-user-tasks.md 8/7 用户规划）：①搜集微信聊天记录信息（自己备忘→转交分身检查是否完成；与别人聊天内容含反馈想法→更新分身素材）②对接服务器聊天频道讨论（HK coordinator）③合理共享进度记录（不混乱不重复——统一 inbox 任务 + knowledge 沉淀）
- ⚠️ **隐私铁律**：identity 注明「涉及微信/个人数据任务必须显式 provider: deepseek」，不派第三方模型
- 文件：`agents/intel-gatherer/identity.json` + `agents/intel-gatherer/AGENTS.md` + `memory/`
- 微信读取通道（wechat-automation skill：WCDB 读取）已具备，identity 已引用，本期身份先行不实现通道

### 3. 业务域补全（不新建）
- QQ 巡逻器 `qq-watcher-bot`（pi_workspace/qq-watcher，已常驻）→ **归入 auto-bots 自动化机器人智能体**，已更新 `agents/auto-bots/identity.json` notes 注明归属；不新建智能体。

## 三、管理组完整性自查（参考 AI_MULTI_AGENT_COLLABORATION.md）

管理组最终成员（全部覆盖任务要求）：

| 职能 | 节点 | 角色 |
|---|---|---|
| 分身（唯一大脑） | twin | 决策/定标准/最终验收 |
| 管家执行器（系统组件） | coo | 任务调度/进程管理/watchdog |
| 产品经理 | pm | 需求结构化/拆解/评审 |
| **审核官** | reviewer | 成果验收/质量门禁/防谎报/发布审核 |
| **信息搜集官** | intel-gatherer | 微信+频道情报采集/素材供给 |
| 渠道管理 | channel-manager | 渠道健康/模型路由/配额 |
| 学习进化官 | learning-officer | 知识库维护/经验沉淀/坑库 |
| 框架开发 | night-worker | 集群自身搭建优化 |

**监督者角色对应**：`AI_MULTI_AGENT_COLLABORATION.md` 中的 supervisor 监督者角色 = **审核官（reviewer）**——审核官承担了监督/质量门禁职责；多代理协作中的「流水线模式」（Agent A 生成 → Agent B 审查 → Agent C 优化）正好映射「执行者 → 审核官 → 返工」。

**缺口评估**：
- **知识管理**：✅ 已被学习进化官（learning-officer）覆盖（维护 org/knowledge/ 四件套），**不重复建**。
- **成本核算**：⚠️ 无专职节点。channel-manager 管渠道健康/配额（含成本侧面），pm/coo 可顺带做成本把关，但无专职 token/费用核算。因用户明确「不开发新业务、不重复建」，且此前未规划过成本核算智能体，**本期不新建**，记入报告建议：若未来成本压力大，可考虑在 channel-manager 下扩展成本核算能力，而非新建独立智能体。
- **其余无明显缺口**：管理组 8 职能齐备，满足任务预期的「分身 + 执行器 + PM + 审核官 + 情报官 + 渠道 + 进化官 + 框架开发」。

## 四、参考来源

- `C:\Users\du_ji\.agents\skills\ai-agent-playbook\references\AI_MULTI_AGENT_COLLABORATION.md`（supervisor 监督者角色 = 审核官；流水线模式映射）
- `C:\Users\du_ji\pi_workspace\org\knowledge\pending-user-tasks.md`（8/7 用户「信息搜集智能体」规划——数据源 a/b/c/d、隐私铁律、分组建议）
- Darwin 质量门禁思想（9 维评估、证据导向）用于审核官身份设计
- 模板：agents/pm（管理组已有 pi 智能体）、agents/learning-officer（身份结构）

## 五、验证

1. ✅ org.json JSON 解析正常（node require 通过）
2. ✅ `node org.js tree`：管理组下出现 审核官(reviewer) + 信息搜集官(intel-gatherer)
3. ✅ web 端 E2E：临时启动 web server（127.0.0.1:8789）curl `/api/state` → `grp-coo.label=管理组`、children 含 reviewer+intel-gatherer、两者 parent=grp-coo / spawnType=pi（web server 每次请求实时读 org.json，label 自动生效，无需改前端/后端代码）
4. ✅ 新 agent identity.json / auto-bots identity.json JSON 均解析正常
5. ✅ 测试 web server 已关闭（无残留监听）

## 六、遗留/建议

- **成本核算**：本期不新建（用户原则：不开发新业务、不重复建），建议后续在 channel-manager 下扩展成本核算能力。
- **信息搜集官通道实现**：本期身份先行，微信读取/服务器频道对接通道后续实现（wechat-automation skill 已具备）。
- **审核官纳入流程**：建议后续让 coo/butler 在执行者写 .DONE 后，对关键任务自动投递审核任务给 reviewer 走验收门禁。
