# Agnes AI 工作室 — 已退役（2026-08-05）

> ⚠️ **本目录已拆散重组进虚无组织树（org/agents）**，不再作为业务壳使用。
> 剩余文件为历史归档（视觉素材/配置/旧文档），保留不删除。

## 拆散去向（详见 `D:\dx\_organize_log\agnes-拆散-manifest.md`）

| 原资产 | 去向 |
|--------|------|
| automation/ | → `org/agents/auto-bots/project/`（junction 保留） |
| deepseek-bridge/ | → `org/agents/ds-bridge/project/`（junction 保留） |
| video-project/ | → `org/agents/video-prod/project/`（junction 保留） |
| marketing/ | → `org/agents/copywriting/project/marketing/`（junction 保留） |
| products/ | → `org/agents/copywriting/project/prompt-templates/`（junction 保留） |
| MONEtization-PACKME.md / PROMOTION-COPY.md | → `org/agents/copywriting/project/` |
| node_modules/ | → `org/agents/auto-bots/project/node_modules/` |
| server.js / server-proxy.js | → `org/agents/workspace/scripts/` |
| ARCHITECTURE.md / REQUIREMENTS.md | → `org/agents/xxsx-gateway/memory/` |
| deepseek-pp-main.zip / sha3_wasm_bg.wasm / temp_extract/ | → `org/agents/ds-bridge/project/` |
| 散装脚本（calendar-generator/cli.js/gen_icons 等 14 个） | → `org/agents/workspace/scripts/` |

## 历史定位
- Agnes AI 工作室 = 用 AI 做视频的独立工作室（2026-06 起）
- 核心系统：server.js（API 代理，已 deprecated，用 node cli.js serve）、video-project/pipeline.js（视频管线）、automation/（自动发布）
- 营销：闲鱼接单、小红书内容策略、个人品牌
- 扩展：deepseek-bridge（网页版 Token 同步，权威副本在 xxsx-proxy-gateway）

## 遗留注意
- `keys.json` / `providers.json` / `proxy-config.json` / `proxy.log` 含 API 配置与密钥，归档保留，勿外传
- 图片素材（back_/comic_/handwrite_/panel_*.png）为旧项目视觉资产，需要时可翻找