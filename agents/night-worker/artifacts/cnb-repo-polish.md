# cnb-repo-polish — 仓库完善（README + 内容健康检查）

> 执行：night-worker | 2026-08-11 20:2x | 渠道 opencode-go / deepseek-v4-flash
> 目标：让 cnb 私有仓库"像样"（门面 README + 结构清晰）+ 定期确认内容健康（不白嫖原则：存东西也给仓库留点东西）

## 一、README.md 完善（org 根 README —— 仓库首页）

原 README 已较完善（目录结构/CLI/投递/圆桌/HK 投递/决策委托/互审协议/睡前模式/模型路由），本次**补齐缺失的「隐私与安全声明」章节**，并新增「这是什么」项目简介，使首页成为完整门面：

1. **「这是什么」**——一句话点明多智能体协作框架定位 + 三条核心特性（文件系统即架构 / 投递即调度 / 跨机 Git 同步）
2. **「隐私与安全声明」**——新增章节，明确本仓库**仅放非核心非隐私**内容，列出三类绝不提交项：
   - 🔒 密钥与凭据（secrets/、*.key、*.pem、*.clixml、config/secrets-index.json）
   - 🔒 会话与聊天记录（sessions*/、sessions-archive*/、chat/、微信/聊天 json）
   - 🔒 运行态与日志（logs/、*.pid、sleep-mode.flag）
   - 并注明「即使私有，也坚持不白嫖、干净入库」

## 二、内容健康检查

### ✅ 关键内容抽查（均在仓库）
README.md / butler.js / lib/registry.js / knowledge/PRODUCT-VISION.md / knowledge/conventions.md / scripts/git-sync.js / scripts/cnb-ctl.js —— 全部确认已跟踪。

### ⚠️ 揪出真实健康问题并已修复

**问题 1：会话归档泄漏入库（敏感）**
- `agents/xxsx-gateway/sessions-archive-20260810/` 下 **35 个会话 jsonl（约 11M）** 被 git-sync 意外纳入版本库
- 根因：`.gitignore` 只挡了 `agents/*/sessions/`，未覆盖 `sessions-archive*/` 目录名
- 修复：`git rm --cached` 全部移除（工作区保留）；`.gitignore` 新增 `agents/*/sessions-archive*/`、`agents/*/chat-archive*/`、`*.pid`

**问题 2：运行态 pid 入库（不该入库）**
- `butler.pid`、`twin.pid`、`cloudflared-local.pid`、`cnb-keepalive-local.pid`、`shutdown-guard.pid`、`agents/xxsx-gateway/scratch/tunnel.pid` 共 6 个 pid 被跟踪
- 修复：全部 `git rm --cached`；`.gitignore` 新增通用 `*.pid`

**问题 3：PRODUCT-VISION 含隐私人名**
- 头部元信息引用「与魇. 的集群讨论」——聊天对象人名属隐私细节
- 修复：脱敏为「与友人的集群讨论」；其余内容均为框架理念文档，无个人身份/账号信息

### ✅ org.json 敏感确认
- 检查 `org.json`：无 API key/token/password；其中「xxsx」仅为智能体节点名（xxsx-gateway），不含中转 IP/凭据。安全，正常入库。

### ✅ 最终验证（push 后）
- 已跟踪文件无任何 secrets/*.key/*.pem/*.clixml/wechat/my_msgs/session 泄漏
- 剩余 jsonl 均为合法知识类（config/improvements、knowledge/reviews、agents/security/monitor-state），非会话
- 无 pid 入库

## 三、推送
- commit `a18e232`：README 隐私声明 + 去敏感会话归档 pid + PRODUCT-VISION 脱敏
- `git push cnb master:main` 成功（407171d..a18e232）
- git-sync 每 10min 自动守护，后续自动推送

## 四、遗留/建议
- 本次把已泄漏的 35 个会话 jsonl + 6 pid 从**索引**移除并 push；但这些文件在 git **历史**中仍可能存在（本仓私有，可接受；若需彻底清除历史可用 filter-repo，非必要）
- 建议后续健康检查纳入：butler 定期 `git ls-files | grep 敏感模式` 作为巡检项，防会话归档目录命名变化后再次泄漏
