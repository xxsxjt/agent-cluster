# 资产清单（assets.md）

> 维护者：学习进化官（learning-officer）
> 铁律：**skill 存在 ≠ 渠道可用**。所有渠道以"实测记录"为准，标注 ✅ 可用 / ⚠️ 不稳定 / ❌ 不可用。
> 更新规则：任何智能体实测新渠道/发现渠道变化 → 汇报 learning-officer 更新本文件（或写自己 diary 并投递提醒）。

## 一、模型 API 渠道（pi models.json 配置）

| 渠道 id | 端点 | 模型 | 状态 | 实测记录 |
|---|---|---|---|---|
| xxsx | http://100.97.18.59:18082/v1 | Agnes 2.0 Flash / Mistral Large(海外) / Mistral Code(海外) / Big Pickle / DeepSeek V4 Flash Free / MiMo v2.5 Free | ✅ | 自建中转（tailscale），key 在 pi models.json |
| deepseek | https://api.deepseek.com/v1 | DeepSeek V4 Flash | ✅ 但默认不用 | 用户 8/4 指令：官方渠道默认不使用（省成本）；蒸馏大消耗活走 free 版 |
| opencode-go-anthropic | https://opencode.ai/zen/go | GLM 5.2 (go/anthropic) / DeepSeek V4 Flash (go/anthropic) | ✅ | 2026-08-05 余额恢复（原 wrk_01KWP7NXZSWX5NVV7J20QQ71A9 故障），流式+非流式实测 OK；供 claude 系用 anthropic-messages 协议 |
| opencode-go | https://opencode.ai/zen/go/v1 | DeepSeek V4 Flash (go) | ✅ | **路由只用 deepseek-v4-flash**（openai 协议） |
| aliyun-tokenplan | https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1 | Qwen3.8 Max / DeepSeek V4 Flash 0731(海外) | ✅ | preview 已下架删（2026-08-06）；正式版非低价，**仅细活显式指定用**（fine 路由），杂活默认 deepseek-flash |
| sub2-luna | http://100.116.125.13:8080/v1 | GPT 5.6 Luna (max思考) | ✅ | tailscale 内网中转 |
| omniroute-free | http://127.0.0.1:20128/v1 | DeepSeek V4 Flash Free / MiMo V2.5 Free(视觉) | ✅ | 本地 omniroute 中转；免费池第一优先（路由 small=omniroute-free） |

## 二、图片 / 视频生成渠道

| 渠道 | 端点/位置 | 模型 | 状态 | 实测记录（2026-08-05） |
|---|---|---|---|---|
| agnes | apihub.agnes-ai.com，key 在 `D:\dx\projects\agnes\providers.json`（10 keys + 1 cpk） | agnes-image-2.1-flash / agnes-image-2.0-flash 文生图；agnes-video-v2.0 视频；agnes-2.0-flash 文本 | ✅ 文生图 | 文生图实测成功；图生图 edits 端点存在但**上游 503 不稳 ⚠️**（"春江改虚无"不可用，需文生图重做） |
| redfox.hk | 指向 image-gen / seedream / seedance 等 skill | — | ❌ 无 key | **没配 key，模板不可用**。教训：skill 存在 ≠ 渠道可用，用前必须验 key |
| 阿里 wan2.7-image | aliyun-tokenplan key | wan2.7-image | ❌ | token-plan key 只支持 chat/completions，**不能调图片** |
| opencode mimo（视觉） | omniroute-free | MiMo V2.5 Free | ❌ | Webshare socks5 代理池 TLS 出口全挂；opencode-go mimo-v2.5-pro go 端点不支持图片输入（404） |

## 三、外部平台账号 / 数据资产

| 资产 | 位置 | 用途 | 备注 |
|---|---|---|---|
| webshare 代理池 | proxy-manager skill | 爬虫/代理出口 | socks5 TLS 出口 2026-08-05 实测全挂，用前先验 |
| 微信 WCDB 读取 | wechat-automation skill | 聊天记录读取/发送 | **隐私数据：可信渠道读取**（8/8 放宽：正规大平台 deepseek官方/opencode/阿里云 + 自有基础设施 XXSX 自建中转可信；禁第三方小中转） |
| 红狐 API 系 | 各平台 feed skill | 抖音/B站/小红书/公众号数据 | 有 key，按 skill 文档调用 |
| 阿里百炼 Token Plan | aliyun-tokenplan | 模型调用 | 仅细活（qwen3.8-max）与备用（deepseek-0731）；杂活默认 opencode-go |

## 四、路由默认值（优先级）

1. 免费池：opencode free（本地 omniroute，deepseek-v4-flash-free）
2. opencode go（deepseek-v4-flash，直连标准名）
3. aliyun-tokenplan qwen3.8-max（仅细活显式指定，非低价非杂活池）
4. deepseek 官方：默认不用（用户 8/4 指令，省成本）
5. 大消耗活（蒸馏等）→ free 版 deepseek（用户 8/4 明确豁免）

## 五、游戏/服务器资产（2026-08-07）

| 资产 | 位置 | 配置 | 备注 |
|---|---|---|---|
| 泰拉瑞亚服务器 | HK 服务器 | 专家大世界；密码 2287；6 人；无注册制 | 用户和朋友玩（芙芙）；短密码用户自定可接受；操作前先查玩家在线 |

## 2026-08-13 新增
- **CNB 空间 4/5 及后续更多仓库**：统一用法=项目仓库（推代码——机器人框架等——4 已初始化 https://cnb.cool/xxssxx.top/4——5 同用法）
- **分享站 aff 新增**：beishaoidc —— https://www.beishaoidc.cn/aff/FHFVYYPI（推广链接——记录待用）
- **规划**：补 2 个机器人框架服务器（微信机器人 + QQ 机器人——框架选型见会话）
