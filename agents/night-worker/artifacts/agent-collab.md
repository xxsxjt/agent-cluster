# 智能体协作机制（agent-collab）— 2026-08-12 落地

> 背景：用户 2026-08-12 多次强调"智能体啊智能体啊……它们都是智能体，工作过程中它们可以交流的"。
> 本机制让智能体在任务执行中**知道找谁协作/避让**，并让互相交流有正式通道。
> 设计原则：轻量——ask 通道已有雏形，核心是"投递附相关智能体提示 + 鼓励交流"。

---

## 1. 投递自动附「相关智能体」（related）

**实现**：`lib/related-agents.js`（butler 派发时自动调用）

任务派发时，butler 从三个数据源自动检索相关智能体，注入任务 prompt：

| 数据源 | 逻辑 | 示例 |
|---|---|---|
| 领域相关 | org.json 组级 keywords（挂到组内 children）+ agents/<id>/identity.json（label/persona/capabilities）文本匹配任务关键词/任务名 | 「服务器检查」→ server-admin / xxsx-gateway |
| 历史相关 | inbox（含 archive）任务文件头部 `agent:` 归属 + 任务名词元重叠（谁做过类似任务） | 「cnb-xxx-verify」→ cnb-test |
| 冲突相关 | resource-lock 活跃写集：本任务 `writes:` 与谁在写同一资源（经 active-tasks.json 映射到 agent） | writes: org.json 与正在写它的任务冲突 |

- 排除：自身、coo（管家）、twin（分身）、组壳节点（组只贡献 keywords 到 children）
- 输出 top 3，prompt 中呈现为：

```
【相关智能体（自动检索，可协作/避让）】
相关: server-admin（领域相关）、cnb-test（历史相关任务）
⚠️ 冲突: org.json 正被 xxsx-gateway（任务 xxx）占用 → 先与对方确认再动，避免覆盖
需要交流时走 ask 通道（见下方说明）；不相关则忽略。
```

- 任务文件头部也可**显式声明** `related: <agent1>, <agent2>`（优先于自动检索，逗号分隔）
- 单测：`test/related-agents.spec.js`（8 用例全过）

## 2. 智能体间交流通道（ask 正式化）

**ask 通道 = `inbox/ask-<对方id>.md`**（已有雏形，本次正式化）：

```
# 问询 → <对方id>
- 来自: <我的id>
- 时间: <ISO 时间>
- 问题: <具体问题>

## 响应 (by <对方id> @时间)
<对方写回的响应内容>
```

**机制**：
1. 发起方（执行中需要协作/信息）→ 写 `inbox/ask-<对方id>.md`（**注意**：ask 文件不会被当任务派发——scanInbox 已过滤 `ask-<已知智能体id>.md`，不占任务槽位）
2. 对方响应 → butler 派发该智能体**任意任务**时，自动检测 `inbox/ask-<agentId>.md` 存在且无响应段落 → 把问询内容附加到其 prompt（【待响应问询】段）→ 对方在任务中抽空响应写回
3. 发起方看到文件末尾有「## 响应」段落 = 闭环

**每个任务的 prompt 都附带交流通道说明**：
```
【智能体交流通道】
- 需要与别的智能体交流：写 inbox/ask-<对方id>.md（# 问询 → <对方id>；- 来自: <你的id>；- 问题: ...）。对方下次任务执行时会收到并响应写回。
- 你自己被 ask（inbox/ask-<你的id>.md 存在）→ 在本任务中抽空响应写回。
- 执行中发现属于别的智能体的活/信息 → 主动投递共享或 ask，不闷头干。
```

**规则**：
- 执行中遇到"别的智能体的活/信息" → 主动 ask 或投递共享，不闷头干
- 被 ask 的智能体：响应写入 ask 文件 + 在任务 DONE 摘要里注明
- ask 悬挂（对方长期无任务）→ ask 文件保留，对方下次任务自动收到（可接受；不做超时打扰）

## 3. 冲突协调

- related 检索会自动标记冲突（同资源写集重叠）→ prompt 提示"先与对方确认再动，避免重复/覆盖"
- 任务文件可显式声明 `writes:`/`reads:`（resource-lock 既有机制）→ 派发前 warn + related 冲突标注
- 同域多智能体（如 mc-dev-* 系列）：related 会列出同域成员，涉及共享代码先确认

## 4. 任务模板引用（投递方怎么写）

```markdown
agent: <执行者>
related: <可选，显式相关智能体，逗号分隔>   ← 不写则 butler 自动检索

# 任务：xxx
...
```

投递方无需手动检索——butler 自动做；显式声明仅在投递方明确知道协作对象时使用。

## 5. 验证记录

- [x] 单测：lib/related-agents.js 8 用例全过（领域/历史/冲突/排除自身/格式）
- [x] butler.js 语法 + 改动点：parseTask 解析 related 头 / dispatch 注入协作段 / scanInbox 过滤 ask 交流文件
- [ ] 端到端（重启后新代码生效）：验证任务 collab-verify-ask-*（night-worker 发起 ask → server-admin）与 collab-verify-respond-*（server-admin 响应 ask）
- [ ] 验证结果由执行方追加到本文件「## 6. 端到端验证结果」

## 6. 端到端验证结果

（待验证任务执行后由对应智能体追加）
