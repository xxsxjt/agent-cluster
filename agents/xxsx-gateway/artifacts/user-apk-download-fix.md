# 用户端 APP 下载 403 修复（user-apk-download-fix）

- 日期：2026-08-12 18:0x
- 执行：xxsx-gateway agent
- 状态：✅ 完成（热修 + 代码兜底 + v0.6.8 发布）

## 根因

用户端 APP 下载 403 的**根因不是 nginx 权限，而是更新清单字段缺失**：

1. 服务器 `/opt/xxsx-api/releases/xxsx-user.apk.json`（公网 `https://api.xxssxx.top/downloads/xxsx-api-android.json`）在 v0.6.6/v0.6.7 发布时**缺少 `download_url`、`size_bytes`、`sha256` 字段**（v0.6.7 发布只改了 `build.gradle.kts` 版本号，未走完整发布脚本，manifest 字段不全）。
2. APP 端 `MainActivity.downloadAndInstall()` 用 `release.optString("download_url")` 取下载 URL → 得到空字符串 → `UserRepository.resolveTrustedReleaseURL("")` 把空串拼成 `store.baseUrl + "/"`（根路径）→ 请求 `https://api.xxssxx.top/` → 403/失败。
3. 即使下载成功，APP 校验 `sha256`/`size_bytes` 也会因字段缺失报错（"更新清单缺少有效 SHA-256"）。

## 修复内容

### 1. 服务器热修（立即恢复 v0.6.7 下载）
- 补全 manifest：`download_url`（`https://api.xxssxx.top/downloads/xxsx-api-android.apk?v=13`）、`size_bytes`（8260544）、`sha256`、`min_sdk`。
- 修复 release_notes 乱码（原发布时编码损坏，含 U+FFFD）。
- nginx Content-Disposition 文件名 0.6.4 → 0.6.7。
- 备份：`/opt/xxsx-api/backups/`（v066 原档保留）。

### 2. 代码兜底（防复发）
`apps/xxsx-user-android/.../data/UserRepository.kt`：
- 新增常量 `APP_RELEASE_DEFAULT_URL = "https://api.xxssxx.top/downloads/xxsx-api-android.apk"`。
- `resolveTrustedReleaseURL()` 在 `download_url` 为空时回退到默认公开静态路径（不再拼根路径）。

### 3. v0.6.8 发布（versionCode 14）
- 版本号 13/0.6.7 → 14/0.6.8。
- debug 构建（与历史一致，同一 debug key 签名，可无缝升级）。
- 部署脚本 `scratch/deploy-user-v068.py`：上传 + manifest + nginx reload + 校验。
- 服务器备份：`/opt/xxsx-api/backups/user-apk-v068-20260812-180135`。

## 验证（全部通过）

| 检查项 | 结果 |
|---|---|
| 公网正确路径 APK 下载 | HTTP 200，8260624 bytes（v0.6.8）✅ |
| manifest 含 download_url/size_bytes/sha256 | ✅ |
| v0.6.7 旧版 APP 流程（manifest→download_url→下载→sha256/size 校验） | ✅ 全通过 |
| v0.6.8 兜底逻辑（download_url 缺失时默认路径） | ✅ 200 |
| 服务器 nginx | active，reload 成功 ✅ |
| 新旧 APK 签名 | 同一 Android Debug key（SHA-256 df9112...）✅ |
| git | 306019a ✅ |

## 遗留说明

- 公网 APK 无参数路径（不带 `?v=`）存在 Cloudflare 缓存（max-age=14400，命中旧版 v0.6.7），4 小时内自动过期；APP 实际走 manifest 的 `?v=14` 参数路径，不受影响。
- 建议：后续用户端发布统一走带完整字段的发布脚本（参考 `engagements/release-20260809-user-v064/deploy-user-apk-only.py`），避免再次出现字段缺失。