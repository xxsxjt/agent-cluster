# uumit-cli — UUMit API 工具封装

UUMit 平台 API 的 Node 封装脚本，供集群智能体（uumit-ops 及各 agent）通过 bash/node 直接调用，**替代标准 MCP 客户端**（pi 不支持标准 MCP 客户端）。

## 位置
- 脚本：`agents/uumit-ops/tools/uumit-cli.js`
- 鉴权：`agents/uumit-ops/memory/uumit-mcp-auth.json`（MCP key，优先）→ `memory/uumit-auth.json`（主 key，回退）；环境变量 `UUMIT_API_KEY` / `UUMIT_USER_ID` 可覆盖
- key 从私有文件读，脚本本身不含明文；输出统一 JSON

## 快速调用

```bash
cd C:/Users/du_ji/pi_workspace/org/agents/uumit-ops

# 1) 发现可用工具（6 个稳定工具）+ Agent Card + server 信息
node tools/uumit-cli.js discover

# 2) 调用一个只读 MCP 工具
node tools/uumit-cli.js call capability_sources '{}'
node tools/uumit-cli.js call capability_search '{"query":"AI 智能体接单","limit":3}'

# 3) A2A JSON-RPC（写操作建议传第 3 个参数作为幂等键）
node tools/uumit-cli.js a2a agent/authenticatedExtendedCard '{}'
node tools/uumit-cli.js a2a tasks/list '{}' 'my-idempotency-key-001'
```

## 命令一览

| 命令 | 作用 |
|---|---|
| `discover` | 拉取 MCP 发现代理，列出 6 个稳定工具 + Agent Card + serverInfo |
| `call <tool> <json-args>` | 调用 MCP 工具（如 capability_search / capability_sources / capability_list / capability_explain / capability_quote / capability_invoke） |
| `a2a <method> <json-params> [idempotencyKey]` | A2A JSON-RPC 调用，可选幂等键（写操作用） |

## 6 个稳定 MCP 工具

| 工具 | 用途 |
|---|---|
| `capability_search` | 按用户意图检索候选能力（语义搜索，返回带 match_score 的能力卡） |
| `capability_sources` | 列出能力来源（playbook/marketplace_api/platform/skill/digital_asset 等） |
| `capability_list` | 按 source_type 分页浏览能力目录 |
| `capability_explain` | 查看某个能力详情（capability_id） |
| `capability_quote` | 询价（capability_id + input_data） |
| `capability_invoke` | 调用能力（capability_id + input_data + idempotency_key） |

## 输出格式

统一 JSON 到 stdout，供智能体解析：
- 成功：`{"ok": true, ...}`
- 失败：`{"ok": false, "error": "..."}`（exit code 1）

## A2A 支持的方法（来自 Agent Card supportedInterfaces）

`message/send`、`tasks/send`、`tasks/get`、`tasks/list`、`tasks/cancel`、`tasks/sendSubscribe`、`tasks/subscribe`、`tasks/pushNotification/set|get|list|delete`、`agent/authenticatedExtendedCard`。

## 已知坑（实现要点）
- MCP 发现代理是 SSE 会话式 + **负载均衡**：POST 可能打到不含该会话的后端 → 偶发 404 `Could not find session`。脚本已内置**会话重试**（每次 POST 最多 24 次，仍失败自动换新 SSE 会话重连重试）。
- 响应回传到 SSE 流（POST 返回 202 空 body），脚本按 JSON-RPC `id` 从 SSE 事件里取结果。
- `call` 的参数必须是 JSON 字符串（用单引号包，如 `'{"query":"..."}'`）。

## ���ܹ���������룩�� tools/skill-manage.js

**Ϊʲô**��2026-08-12 �ϼ� 3 �������� `node -e "..."` ��������Ƕ���ģ�Windows git-bash �� GBK ���θ� node����������/����/��ǩȫ�� U+FFFD ������⡣���޸����ñ��ű���������

**�÷�**��
```bash
node tools/skill-manage.js list                          # �б� + �����Լ죨?��ǣ�
node tools/skill-manage.js get <skill_id>                # ����
node tools/skill-manage.js create <payload.json>         # �ϼܣ�payload ������ UTF-8 JSON �ļ���
node tools/skill-manage.js update <skill_id> <payload.json>  # �༭��ȫ�����£�
```

**����**��
1. �غ�һ�� UTF-8 �ļ����Σ�`--file`/·������**��ֹ����������Ƕ���� JSON**��bash ���α���ӣ�
2. ����ǰ�Զ��Լ� U+FFFD��������ֱ�Ӿܾ�
3. Content-Type ��ʽ `application/json; charset=utf-8`
4. �������������ļ����ύ��д�ļ��� write ���ߣ���Ȼ UTF-8��
5. �ο� payload ģ�壺`tmp/skills-fix-payload.json`��3 ���������ֶΣ�
