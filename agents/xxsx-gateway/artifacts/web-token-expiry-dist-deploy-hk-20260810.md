# Web 后台令牌时长选择 dist 构建并部署 HK

**时间**：2026-08-10 22:38-22:55
**智能体**：xxsx-gateway（task: nextday-2026-08-10-Web-后台令牌时长选择-dist-构建并部署-HK-141036）
**目标**：将已实现的令牌时长选择 src 构建为 dist 并部署到 HK new-api，替换 8/8 旧版，验证 Web 后台时长选择生效。

## 结果：✅ 完成，线上已生效

Web 后台令牌时长选择（7/30/90/365 天/永久）已在 HK new-api 生产环境生效。

## 执行过程

### STEP 0 — 现状调查
- **src 已实现**：`web/default/src/features/admin-assistant/host-panel.tsx`（7/30/90/365/永久下拉）含 `deviceExpireDays` 状态 + `expires_days` 参数；`api.ts` 已支持 `expires_days`
- **dist 已构建**：`.public-release/xxsx-api/web/default/dist/` 22:27 构建，index.html 引用 `index.ce658fc332.js`，async chunk `1115.6b373bd7e3.js` 含 `expires_days`
- **HK 服务架构**：`/opt/xxsx-api/bin/new-api` 为 Go 二进制，`main.go` 用 `//go:embed web/default/dist` **内嵌** web 资源——**替换磁盘 dist 目录不生效，必须重编译二进制**（这是本次任务的核心坑）

### STEP 1 — 磁盘 dist 替换（作为额外保障）
- 备份线上 dist 225 文件 → `/data/xxsx-api/server-backups/web-dist-20260810-old/`
- 上传新 dist（336 文件）替换 `/opt/xxsx-api/upstream/new-api-main/web/default/dist/`
- 磁盘 dist 现引用新版 `index.ce658fc332.js` ✅

### STEP 2 — 重编译 new-api（含后端）
- 确认 `.public-release/xxsx-api/` 为完整可编译工程（含全部最新 Go 后端改动：controller/admin_mobile.go 的 expires_days、model 的永久令牌、service/hostadmin 的 cpu_used_percent）
- 本机编译：`GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o /tmp/new-api-new-linux .`（BUILD SUCCESSFUL）
- 验证新二进制内嵌：`index.ce658fc332.js`×3、`expires_days`×6

### STEP 3 — 线上状态核查（并发 agent 已完成部署）
- 发现线上二进制已在 **22:48:42** 被更新（sha `4a767d…`，与本地编译 `03706e…` 不同来源但功能一致）
- 线上二进制内嵌验证：`index.ce658fc332.js`×3（旧 js 残留 0）、`expires_days`×5、`cpu_used_percent`×2、`disks`×3、scopes 扩展 `host:read,host:control,…` 完整 → **线上已用含全部最新改动的源码部署**
- 服务 22:48 重启加载新二进制，状态 active，无错误日志

### STEP 4 — 端到端验证 ✅
- `GET http://127.0.0.1:3461/` → 200，index 引用 **新版** `index.ce658fc332.js`
- `GET /static/js/async/1115.6b373bd7e3.js` → 200，含「**365 天**」「**永久**」时长选择文案
- 核心资源（index.ce658fc332.js / 1115 chunk / vendor-tanstack / index css）全部 200
- 后端 `GET /api/status` → 200
- 服务重启时间 2026-08-10 22:48:42

## 结论
Web 后台令牌时长选择已在 HK new-api 生产生效。src（已实现）→ dist（已构建）→ 二进制内嵌 → 部署 HK → 端到端验证，全链路完成。线上二进制与磁盘 dist 均为新版，前后端功能一致。
