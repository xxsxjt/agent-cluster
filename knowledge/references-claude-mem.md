# 参考：claude-mem（thedotmack/claude-mem，Apache-2.0）— 跨会话记忆

> 2026-08-05 学习记录。Claude Code 的持久记忆压缩系统，也可装到 OpenClaw。

## 核心设计（对虚无"专属记忆"⭐⭐⭐）

### 1. 渐进式披露（Progressive Disclosure）— 关键
记忆检索**分 3 层**，避免一次拉全：
1. **search**：紧凑索引（~50-100 token/结果）——先看有什么
2. **timeline**：感兴趣结果的时间线上下文
3. **get_observations**：只取过滤后的 ID 详情（~500-1000 token/结果，批量取）
→ **~10x token 节省**（先过滤再取详情）

### 2. 记忆压缩系统（Persistent Memory Compression）
- 持续把会话记忆压缩存储
- Web Viewer UI：实时记忆流
- MCP 4 工具（search/timeline/get_observations/其他）+ 3 层工作流

### 3. 集成方式
- Claude Code 插件 / MCP server / OpenClaw 网关 / Claude Desktop Skill

## 虚无落地建议
1. **记忆检索分层**：我们现在的 diary.md 是"全文读"，应进化成"索引→时间线→详情"3 层（省 token，尤其 qwen/opencode 长上下文）
2. **记忆压缩**：diary 超限 → 压缩为结构化观察（obs），保留可检索
3. 实现：文件版可做（index.json + 观察 jsonl + 详情），不必上 DB

## 学习来源
- https://github.com/thedotmack/claude-mem（Apache-2.0）
- docs.claude-mem.ai/progressive-disclosure
