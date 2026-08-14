# 管理端 APP 完全连不上 + 检查更新失败 排查与修复 — app-connectivity-fix

**时间**：2026-08-09 20:1x~20:2x
**智能体**：xxsx-gateway
**任务**：app-connectivity-fix（用户 2026-08-09 19:2x 报告管理端 APP v1.7.13 完全连不上服务器 + 检查更新也检查不了，用户端同步受影响）

---

## 一、APP 实际配置（确认）

- **管理端 baseUrl**（连接页默认）：`https://api.xxssxx.top`（公网域名，Cloudflare 代理 → HK nginx 443 → new-api `127.0.0.1:3461`）。所有请求（含更新检查）都走 `baseUrl + /api/mobile/admin/*`。
- **更新检查 URL**：`https://api.xxssxx.top/api/mobile/admin/app-release`（`MoreFragment.checkForUpdate` → `GET /api/mobile/admin/app-release`，判定 `version_code > 已装版本` 才弹更新）。
- **`MobileAlertClusterEndpoint=100.97.18.59:8788`** 只是 new-api **服务端内部**集群监控轮询的地址（HK org `/api/cluster/health`），**与 APP 能否连服务器无关**（APP 不直连 8788）。故本任务根因与"8788 只绑 Tailscale"无关，被排除。

## 二、公网视角验证（分层定位断层）

| 层 | 测试 | 结果 |
|---|---|---|
| DNS | `api.xxssxx.top` | 解析到 Cloudflare（104.21.69.181 / 172.67.211.5 / IPv6）✅ |
| 公网 | `https://api.xxssxx.top/api/mobile/admin/*` | ❌ 返回 OpenAI 风格 `Invalid URL (GET /api/mobile/admin/app-release)` type `invalid_request_error` |
| HK nginx | `--resolve ...:127.0.0.1` 走 nginx | ❌ 同样 `Invalid URL` |
| 直连 | `curl http://127.0.0.1:3461/api/mobile/admin/app-release` | ❌ 同样 `Invalid URL`（**断层在 new-api 进程本身**） |

> Cloudflare 隧道、nginx 均正常（active）；故障 100% 定位到 new-api 后端：`/api/mobile/admin/*` 路由 **未注册**（返回 404 Invalid URL），而 `/api/status` 正常 200。

## 三、根因

**new-api 二进制在 2026-08-09 13:39 被覆盖成了不含自定义移动端/集群控制器的标准重建版。**

- new-api 进程 13:39:15 重启，`/opt/xxsx-api/bin/new-api`（207MB）被 `new-api.new`（13:38 上传，207MB，md5 相同）覆盖。
- 该 207MB 构建 **缺失** `app-release` / `mobile/admin` / `cluster/state` 全部路由（`strings` 计数=0），即标准上游 new-api 重建，**不含 xxsx 自定义的 admin_mobile + cluster 控制器补丁**。
- 现有备份中：
  - `new-api.bak.20260808-cluster`（162MB，8/8 13:30）：有 app-release/mobile/admin，无 cluster/state
  - `new-api.bak.20260808-docs`（162MB，8/8 17:37）：**含全部路由**（app-release=3, mobile/admin=3, cluster/state=1）——即今日 12:58 验证 v1.7.13 时仍在运行的工作版本 ✅
  - `new-api.twin.tmp`（229MB）：无路由
- 触发方式：`/opt/xxsx-api/bin/deploy-hk.sh`（标准部署脚本：备份→停服→`cp new-api.new new-api`→起服）。即 13:38-13:39 有人上传了无补丁的 `new-api.new` 并跑了 deploy 脚本。

**结论**：APP 连不上/检查不了更新 = new-api 后端换了不含移动端路由的二进制，与 Cloudflare/nginx/token/8788 均无关。

## 四、修复（已完成并验证）

1. **备份坏二进制**：`/opt/xxsx-api/bin/new-api` → `new-api.bak.20260809-207MB-noroutes`
2. **恢复工作版**：`new-api.bak.20260808-docs` → `/opt/xxsx-api/bin/new-api`（停服避 ETXTBSY → cp 重建 inode → 起服），md5 `41eb19791e9497ff0509d1574185c1ff`，app-release 路由数=3
3. **防复发**：把坏构建 `new-api.new` 重命名 → `new-api.new.UNUSABLE-noroutes-20260809`，使 `deploy-hk.sh` 无法再误部署（可逆）

**端到端验证（铸造临时移动 token，走 nginx 443 模拟公网链路，验后吊销）**：

| 端点 | 结果 |
|---|---|
| `/api/mobile/admin/app-release` | **200** `{available:true, version_code:47, version_name:"1.7.13", ...}` ✅ 更新检查恢复 |
| `/api/mobile/admin/overview` | **200** ✅ |
| `/api/mobile/admin/cluster/state` | **200**（cluster 数据完整）✅ |
| `/api/mobile/admin/incidents` | **200** ✅ |
| `/api/mobile/admin/app-release/download` | **200**，大小 6540143，sha256 `4683ec4e...` 与预期一致 ✅ |
| 公网 Cloudflare 视角 `/api/mobile/admin/overview` | **401**（路由可达、需鉴权，正常）✅ |

服务 `xxsx-api-mi` active、nginx active、cloudflared active。临时 token 已吊销。

## 五、踩坑 / 注意事项

1. **token 长度校验**：`AdminMobileAuth` 要求 token 前缀 `xxsxadm_` 且总长 ≥ 40（`len(prefix)+32`）。测试 token 太短会 401（`middleware/admin_mobile.go` 先做长度检查再查库）。本次最初用短 token 误判为"鉴权异常"，实际路由已恢复。
2. **DB 双路径**：`/opt/xxsx-api/upstream/new-api-main/data/xxsx-new-api.db` 与 `/data/xxsx-api/new-api-data/xxsx-new-api.db` 硬链接同源，写入任一路径均生效。
3. **复发风险（重要）**：移动端/集群路由是 **xxsx 自定义补丁，不在标准 new-api 上游**。今后任何用 `deploy-hk.sh` 部署的标准重建 new-api 都会再次打掉这些路由 → APP 再次失联。**下次部署前必须确认 `new-api.new` 包含 admin_mobile + cluster 控制器补丁（`strings new-api.new | grep -c app-release` 应 >0），或直接把自定义补丁合入重建流程。**
4. 备份清理：`new-api.bak.20260809-207MB-noroutes`（坏版）与 `new-api.new.UNUSABLE-noroutes-20260809`（坏版）可后续删除，但建议保留一周用于排查。

## 六、产物

- 修复动作：HK `/opt/xxsx-api/bin/new-api` 恢复为 `-docs` 工作版；坏构建改名加保护；服务重启。
- 本报告：`agents/xxsx-gateway/artifacts/app-connectivity-fix.md`
