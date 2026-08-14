# UUMit API 工具封装（uumit-tools）— 完成

日期：2026-08-11
执行者：uumit-ops

## 背景
用户已生成 MCP key（channel=mcp_only，独立于 Skill 主 key），pi 不支持标准 MCP 客户端，需要 API 脚本封装供集群智能体调用（bash/node 直调，替代 MCP 客户端）。

## 产出
- **脚本**：`agents/uumit-ops/tools/uumit-cli.js`（Node，自包含，无外部依赖）
- **使用说明**：`agents/uumit-ops/tools/README.md`
- **鉴权文件（私有，脚本读）**：`agents/uumit-ops/memory/uumit-mcp-auth.json`（MCP key + platform_user_id）；回退 `memory/uumit-auth.json`；env `UUMIT_API_KEY`/`UUMIT_USER_ID` 可覆盖。脚本无明文 key。

## 三个命令（统一 JSON 输出）
1. `discover` — 拉 MCP 发现代理，列出 6 个稳定工具 + Agent Card + serverInfo
2. `call <tool> '<json-args>'` — 调 MCP 工具
3. `a2a <method> '<json-params>' [idempotencyKey]` — A2A JSON-RPC（写操作带幂等键）

## 核心实现难点（已解决）
MCP 发现代理（`GET /mcp/discovery/sse`）是 **SSE 会话式 + 负载均衡**：
- discovery SSE 首个事件 `endpoint` 返回 `/mcp/discovery/messages/?session_id=X`
- POST JSON-RPC 到该 endpoint，响应**回传到 SSE 流**（POST 返回 202 空 body）
- **坑**：POST 是独立连接，可能打到**不含该会话的后端** → 偶发 404 `Could not find session`（先前任务卡死根因）
- **解决**：`_postUntilAccepted` 对每次 POST 最多重试 24 次（每次新连接换后端），仍失败自动换新 SSE 会话重连重试；响应按 JSON-RPC `id` 从 SSE 事件流匹配取出。

## 验证结果（真实端到端，多次跑通）
| 命令 | 结果 |
|---|---|
| `discover` ×3 | ✅ 全部 ok，server=UUAgent-Discovery v1.27.2，6 工具：capability_search / capability_sources / capability_list / capability_explain / capability_quote / capability_invoke |
| `call capability_sources '{}'` | ✅ 返回 9 类能力来源（playbook 9 / marketplace_api 7831 / platform 134315 / skill 51718 / digital_asset 93580 / compute_share 242 等） |
| `call capability_search '{"query":"AI 智能体接单","limit":2}'` | ✅ 返回 2 条候选能力卡（含 capability_id/pricing/match_score） |
| `a2a agent/authenticatedExtendedCard '{}'` | ✅ 200，返回认证扩展卡 + authenticated_user_id=b875e67a… |
| `a2a tasks/list '{}' 'test-idem-key-001'` | ✅ 200，返回 `{tasks:[]}`，幂等键已透传 |
| `a2a agent/info`（非法方法） | ✅ 正确返回服务端 JSON-RPC 错误 -32601（验证错误路径） |

## A2A 支持方法（来自 Agent Card supportedInterfaces）
`message/send`、`tasks/send`、`tasks/get`、`tasks/list`、`tasks/cancel`、`tasks/sendSubscribe`、`tasks/subscribe`、`tasks/pushNotification/set|get|list|delete`、`agent/authenticatedExtendedCard`。

## 集群智能体怎么调
```bash
cd C:/Users/du_ji/pi_workspace/org/agents/uumit-ops
node tools/uumit-cli.js discover
node tools/uumit-cli.js call capability_sources '{}'
node tools/uumit-cli.js a2a tasks/list '{}' 'idem-key'
```

## 备注
- 网络从本机出（api.uumit.com 可达），未走 CNB。
- MCP key 存私有 memory 文件，未写入公开仓库/日志明文。
