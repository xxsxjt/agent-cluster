# 双集群互联 · 现状探索与落地方案

- 任务：dual-cluster-explore（只探索+出方案，未做任何修改）
- 执行：night-worker · 2026-08-06 凌晨
- 蓝图：`pi_workspace\hub\VISION-v6.md`
- 保密：全文不含任何明文 key/token（服务器 env/DB 只记录变量名与结构）

---

## 一、5 件事的现状结论

### 1. ai助手是什么 ✅ 已查清

- **就是 `xxsx-hermes.service`**（systemd enabled，2026-07-27 起跑至今）：`python -m hermes_cli.main gateway run --external-supervisor`，专用低权限用户 `xxsx-hermes`，内存上限 1.2G、CPU 150%，systemd 沙箱加固很全（NoNewPrivileges/ProtectSystem 等，可作为 org 服务单元范本）。
- **技术栈**：Python 3.13 venv；软件本体是 **Nous Research 开源的 hermes-agent 0.19.0**（editable 安装），源码树在 `/opt/xxsx-hermes/releases/d71033a4…/`。个人 AI agent：SOUL.md 人格 + memories + skills + sessions + kanban.db + cron，gateway 支持 ~20 个聊天平台。
- **运行位置/数据**：gateway 监听 `127.0.0.1:3588`（API server，env 里有 `API_SERVER_KEY`/`OPENAI_BASE_URL`/`OPENAI_API_KEY`，已脱敏不录）；数据全在 `/var/lib/xxsx-hermes/home/`（config.yaml、SOUL.md、memories/、skills/、sessions/、state.db、response_store.db）。
- **模型配置**：config.yaml `model.default=gpt-5.4-mini`，`provider=custom:xxsx-newapi`（走自家 new-api 中转）。
- **备用模型机制**：hermes 原生支持 **fallback 链** —— config.yaml 顶层 `fallback_providers`（列表，每项 `{provider, model, base_url?}`），主模型遇限流/过载/连接错误时按序尝试；CLI `hermes fallback add/remove/list`（源码 `hermes_cli/fallback_cmd.py`、`fallback_config.py`）。⚠️ 当前线上 config **未配置** fallback；且这是**实例级单链**（hermes 是单 agent），不是 per-channel。

### 2. Tailscale 现状 ✅ 双端已装、已直连，零组网工作

- **本机**：tailscale 1.98.10，节点 `node` = `100.103.204.86`（windows），active。
- **HK**：tailscaled 运行中，节点 `xxsx-main-hk` = `100.97.18.59`，与本机 **direct 直连已建立**（UDP 打洞成功）。同一 tailnet（xxsxjt@），另有 `xxsx-sub2-us` 在线、一台 android 离线。
- **结论**：组网已完成，任务只剩"服务绑定到 tailscale 接口 + 访问策略"。SSH 走 100.97.18.59:43891 全程畅通（本探索即走 Tailscale）。

### 3. HK 承载 org 框架的条件 ⚠️ 可行，资源偏紧

- **运行时**：node v22.23.1、git 2.52、rsync 3.2.5、systemd 均可用。org 的 butler.js / twin-daemon.js / web/server.js 均为**纯 Node 标准库零依赖**，node 22 直接可跑。
- **资源**：内存 3.8G，当前可用约 1.7G（hermes 上限 1.2G + new-api + podman 4 容器）；磁盘 `/data` 剩 9.7G（77% 已用）、`/` 剩 14G → org 目录放 `/data`，需限日志体积。
- **关键缺口**：HK **没有 pi / opencode / claude / codex CLI** → 服务器端 org 无法 spawn pi 型子智能体，除非安装 pi CLI 并配渠道；建议服务器端 agent 定位为"轻执行 + API 调用型"（走 new-api/hermes），重活仍派回本地或纯 API 完成。
- **自启**：照 xxsx-hermes.service 风格写 systemd unit（专用用户 + 资源上限 + 沙箱）。

### 4. 聊天室频道智能体的备用模型机制 ❌ 现在没有，需改 new-api 代码

- **表结构**（chat_room_topic_agents，9 频道在役，全部 `opencode/mimo-v2.5-free`）：现有字段 = source/channel_key/bot_handle/display_name/**model_name**/role/**context_window_messages、context_token_budget、context_character_budget、system_prompt**/context_summary*/topic & visit 认领槽位/last_error。**没有任何 fallback 字段**。
- **调用链**：`controller/chat_room_topic_agent.go` 4 个调用点 → `adminassistant.CallInternalModel`（service/adminassistant/service.go，进程内 relay，单模型、失败直接返回错误，无 fallback）。
- **已有先例**：内容审查路径**已实现 fallback**——选项 `ChatRoomModerationFallbackModels`（boundedCSV ≤4 个模型），`chat_moderation.go` 对 candidates 逐个尝试、逐模型收集错误。可直接复用此模式。
- **要改什么**（fork 源码在**本地** `D:\dx\projects\xxsx-proxy-gateway-chat-assistant\upstream\new-api-main`，带 github/x 频道的最新分支；HK 上 `/opt/xxsx-api/upstream/new-api-main` 是不含 topic-agent 的旧 upstream 镜像）：
  - 方案 A（全局，小改）：新增选项 `ChatRoomTopicFallbackModels`，4 个调用点包一层"主模型失败 → 遍历 fallback 链"。
  - 方案 B（per-channel，符合愿景）：表 + spec 增 `fallback_models` 字段，每频道独立配置。**注意：EnsureChatRoomTopicAgents 每 30s 按 spec 覆写字段，fallback 必须进 spec 才能持久**（已知坑）。
  - "多模态自调 mimo"：CallInternalModel 目前纯文本 messages，图片输入需调用路径加多模态支持 —— 同样要改代码。
- **结论**：配置不可达，必须改 Go 代码（但有 moderation 现成模式，改动量可控）。

### 5. 本地控制台扩展（服务器端分组树）✅ 改动小

- org/web/server.js 为纯 Node 零依赖 http 服务，已有 `GET /api/state`（组织树+任务+活动，app.js 据此渲染），支持 token 鉴权（`?token=` / `x-pi-token` 头 / cookie，`--token` 参数开启）。
- 扩展方案：本地 server.js 加一个 `GET /api/remote/state` —— 经 Tailscale 转发服务器端 org web 的 `/api/state`（`http://100.97.18.59:8787/api/state`，带 `x-pi-token`）；app.js 用**同一数据结构**并排渲染"服务器集群"树。前置条件：服务器端先跑起 org web（bind tailscale0 接口或 127.0.0.1）。
- 下钻交互（点服务器节点看详情）后续可复用 `/api/agent`、`/api/file` 同样代理，MVP 先做树。

---

## 二、落地路线图（可独立执行的小任务）

| # | 任务 | 目标 | 涉及端 | 依赖 |
|---|------|------|--------|------|
| T1 | **HK 部署 org 框架** | rsync/git 同步 org 核心文件到 `/data/agent-cluster`（排除 inbox 大日志），butler+twin 跑起来，systemd 单元自启，资源上限 | HK | 无 |
| T2 | **HK org web 控制台** | server.js `--token` 模式，bind tailscale0（100.97.18.59:8787），只对内网开放 | HK | T1 |
| T3 | **本地控制台服务器树视图** | server.js 加 `/api/remote/state` 代理 + app.js 双树渲染 | 本地 | T2 |
| T4 | **聊天室 fallback 模型** | new-api 改代码（建议先 A 后 B）：主模型 429/失败 → fallback 链（opencode-go 订阅池）；go test 验证；交叉编译+fuser 检查后部署 | 本地源码→HK 部署 | 无 |
| T5 | **双分身对话通道** | 本地虚无圣灵 ↔ HK 端最高智能体（hermes API 3588 或 HK 端 twin-daemon RPC），走 Tailscale | 双端 | T1 |
| T6 | **框架/分身蒸馏双端同步** | 以本地为权威源单向同步（rsync 白名单：org.json、lib/、web/、user-twin SKILL.md；**排除 secrets/.env/inbox**），写同步脚本+审计 | 双端 | T1 |
| T7 | **API 调用收口** | new-api API 只允许 Tailscale 直连+服务器内部；API 页面保持可看；普通用户走聊天室 | HK（firewall/bind） | 无（建议最后做） |

建议顺序：T1 → T2 → T3（控制台闭环）；T4 独立并行；T5/T6 在 T1 之后；T7 收尾。

## 三、风险点

1. **Key 保密（最高优先）**：hermes env（API_SERVER_KEY/OPENAI_API_KEY）、new-api DB 渠道 key、omniroute 凭据绝不可进同步包/日志/产出文档。T6 同步用**白名单**而非黑名单（只列明要同步的文件），服务器端 org 目录不落地任何生产凭据。
2. **双端分身一致性**：两份 SOUL/user-twin 会漂移。MVP 阶段**本地为唯一权威源、单向推送**；双向合并等蒸馏流水线成熟再说。T5 的分身对话先做"信息互通"，不做"互相改写人格"。
3. **Tailscale**：直连现状良好，但 DERP 中继兜底时延迟会升高，控制台代理接口要设超时；8787/3588 等端口**只监听 tailscale0/127.0.0.1**，严禁绑公网。
4. **HK 资源**：可用内存 ~1.7G、磁盘 9.7G。服务器端 org 限日志大小（butler.log 轮转）、不跑 pi 重活；大模型调用全走 API（new-api/hermes）。
5. **已知部署坑（复用经验）**：① EnsureChatRoomTopicAgents 每 30s 覆写 DB 字段 → 手改无效，必须进 spec/配置；② 替换 new-api 二进制前 fuser 查写句柄，ETXTBSY 时 kill 持有者+cp 重建 inode；③ 部署前必备份（/data/xxsx-api/server-backups/ 惯例）。

---
*边界遵守：本次未修改 new-api 代码、未装/改 tailscale、未动服务器配置，全部为只读探索。*
