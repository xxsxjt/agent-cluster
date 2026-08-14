# UUMit 技能乱码修复报告（uumit-skill-encoding-fix）

- **时间**：2026-08-12 18:2x
- **执行**：uumit-ops
- **状态**：✅ 全部修复完成

## 问题

用户 UUMit「我的技能」页面 3 个已上架技能名称/描述/标签全部乱码（`SQL ��ѯ�Ŵ����Ż�˵��`），典型 GBK/U+FFFD 乱码——写入的数据本身就是错的。

## 根因

上架时用 `node -e "..."` 在 bash 命令行内嵌中文 JSON payload（见 sessions/2026-08-12T09-57-40-831Z 会话）。**Windows git-bash 以 GBK/CP936 编码把命令行参数传给 node.exe**，node 按 UTF-8 解析源码字符串 → 中文全部变成 U+FFFD 替换符 + 拉丁扩展字符 → `JSON.stringify` 后以 UTF-8 发送 → 服务端存储的就是损坏数据。与通知乱码同族（平台调用链编码坑）。

**关键**：会话 jsonl 落盘是 UTF-8，记录的 payload 是**正确原文**——可完整恢复，无需从乱码猜。

## 修复

对 3 个技能执行 `PUT /api/v1/skills/{skill_id}` 全量更新（rest_request.js --file 传 UTF-8 文件 + MSYS_NO_PATHCONV=1 绕 git-bash 路径转换坑）：

| skill_id | 名称（修复后） | 价格 | audit |
|---|---|---|---|
| 011d88a3-3a00-48a0-8ef7-09a97c877aeb | SQL 查询排错与优化说明 | 500UT | approved |
| cac07911-1939-4aca-9fee-5edd03233c8f | 口语化需求拆解与任务规划 | 600UT | approved |
| c7763882-2598-4f64-a6c6-adb500692742 | JavaScript 工具函数开发与测试 | 500UT | approved |

修复字段：name / description / category / tags / deliverables / input_requirements_text（全部恢复为上架时原文，内容未改动，只修编码）。所有价格、交付时长（72h）、审核状态（approved）均保持原值。

**验证**：`GET /api/v1/skills` 返回 3 个技能 name/desc/tags/deliverables 全部正确中文，`includes('\uFFFD') === false` ✅

## 防复发（已落地）

新增 `tools/skill-manage.js`（技能管理脚本，替代手工 node -e）：

- `list` / `get` / `create <payload.json>` / `update <skill_id> <payload.json>`
- **铁律**：①载荷一律从 UTF-8 JSON 文件读取，禁止命令行内嵌中文；②发送前 U+FFFD 自检（含乱码直接拒绝）；③Content-Type 显式 `application/json; charset=utf-8`；④中文内容先写文件再提交
- 验证：list 显示 3 技能 ✅；构造含 FFFD payload 被拒绝（exit 1）

README（tools/README.md）追加技能管理章节与铁律；diary.md 记录经验。

## 平台 API 编码坑备忘（后续规避）

1. **bash 命令行内嵌中文 → node/curl**：Windows git-bash GBK 传参，中文必坏 → 一律走文件传参
2. **git-bash 路径转换**：`/api/...` 开头的参数会被转成 `C:/Program Files/Git/api/...` → 加 `MSYS_NO_PATHCONV=1` 或走脚本（https.request 不受影响）
3. **PUT /api/v1/skills/{id} 支持全量编辑**（文档只写了 status 切换，实测全字段更新可用）
4. **MCP key 不可用于 REST**（code 1006），REST 用主 key（memory/uumit-auth.json）

## 产出

- 修复 payload 模板：`tmp/skills-fix-payload.json`（3 技能完整正确字段，可复用）
- 管理脚本：`tools/skill-manage.js`
- 验证快照：`tmp/skills-verify.json`
