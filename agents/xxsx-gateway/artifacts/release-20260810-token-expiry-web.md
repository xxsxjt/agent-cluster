# Web 后台令牌时长选择 dist 构建 + 部署 HK（2026-08-10）

**任务**：nextday-2026-08-10-构建-Web-后台令牌时长选择-dist-并部署-HK-141036
**智能体**：xxsx-gateway

## 背景
- src 已实现令牌时长选择 UI（`web/default/src/features/admin-assistant/host-panel.tsx`：7/30/90/365 天/永久 Select，默认 30 天；`api.ts` 支持 `expires_days`），但 dist 仍为 8/8 旧版。
- new-api 前端通过 `go:embed web/default/dist` 嵌入 Go binary，必须重编 binary 才能让新 dist 生效。

## 执行过程
1. **构建 dist**：`.public-release/xxsx-api/web/default` → `npm run build`（rsbuild）成功。
   - 新产物：`static/js/index.ce658fc332.js` + `async/1115.6b373bd7e3.js`
   - 验证 dist 含令牌时长 UI：365 天/90 天/7 天/30 天/永久/expires_days/创建设备令牌 全部命中 ✅
2. **编译 linux binary**（WSL Ubuntu，go1.25.1，`build-newapi-wsl.sh` 流程）：
   - `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build`（.public-release/xxsx-api，嵌入新 dist）
   - 产物 `C:/_dx_serve/new-api-linux-amd64-token-expiry-20260810`（138MB）
   - sha256 `4a767d12570fc59b87c6d28767bca01b5f9a09d225c378108750e2667c643ff5`
3. **部署 HK**（`engagements/release-20260810-token-expiry-web/deploy-token-expiry.py`，US 跳板 → HK Tailscale，复用成熟 deploy.sh：停服务→备份→替换→重启→健康检查→数据完整性校验，含自动回滚保护）：
   - VERSION_TAG=token-expiry-20260810
   - 备份：`/data/xxsx-api/server-backups/token-expiry-20260810-224617`
   - HEALTH=200，USERS=27 / CHANNELS=11 / TOKENS=52 数据完整，BINARY_SHA 匹配

## 端到端验证（HK 本地 127.0.0.1:3461）
- `/api/status` → 200 success（service 正常）
- 线上 binary sha == 部署 sha `4a767d12…` ✅
- index.html 引用新 index `index.ce658fc332.js` ✅
- `async/1115.6b373bd7e3.js` HTTP 200，含全部令牌时长元素：
  365 天=1 / 90 天=1 / 7 天=1 / 30 天=1 / 永久=1 / expires_days=1 / 创建设备令牌=1 ✅
- 后端 `controller/admin_mobile.go` `CreateAdminMobileDevice` 已支持 `expires_days`（本轮 binary 已含）→ Web 端选择时长正确传给后端创建对应期限令牌 ✅

## 结论
令牌时长选择 UI（7/30/90/365 天/永久）已在 Web 后台实际生效，dist 不一致问题解决。
