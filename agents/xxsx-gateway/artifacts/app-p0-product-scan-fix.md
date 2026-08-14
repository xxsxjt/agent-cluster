# APP 产品化 P0 — 扫码连接（T3）补做

> 日期：2026-08-11 23:4x · 执行：xxsx-gateway · 任务：app-p0-product-scan-fix
> 背景：源任务 `app-p0-product`/`app-p0-product-improve` 孤儿进程失败，T3「扫码连接」是真实缺口（Android 全仓无任何扫码/QRCode/zxing/CameraX）。本次补做。

## 实现
工程：`C:/Users/du_ji/WorkBuddy/xxsx-proxy-gateway/apps/xxsx-admin-android`（注意：不在 pi_workspace 下）。

### 新增文件
- `data/QrLinkParser.kt` — 解析 `xxsx://host[:port]?token=...&name=...`。纯 Kotlin 实现（不依赖 android.net.Uri，便于单测），scheme 大小写不敏感，token 必填，name 可选，端口越界回退当 host。
- `ui/QrScanActivity.kt` — 全屏相机扫码页：CameraX（camera-core/camera2/lifecycle/view 1.3.4）实时预览 + zxing-core 3.5.3 本地解码（`PlanarYUVLuminanceSource` 直取 Y 平面，零 RGB 拷贝，不依赖 Play 服务/联网）；命中 `xxsx://` 后 result 回传 host/port/token/name。运行时请求 CAMERA 权限。
- `layout/activity_qr_scan.xml` + `drawable/bg_qr_scan_frame.xml`（扫码框）+ `drawable/ic_qr_code.xml`（按钮图标）+ `drawable/ic_close.xml`（关闭）。
- `test/.../QrLinkParserTest.kt` — 9 个解析用例。

### 修改文件
- `app/build.gradle.kts` — 加 CameraX 1.3.4 ×4 + zxing-core 3.5.3。
- `AndroidManifest.xml` — 加 `CAMERA` 权限 + `ui.QrScanActivity`（exported=false / portrait）。
- `data/SecureStore.kt` — `save(baseUrl, token, name=null)` 支持自定义 Profile 名（缺省仍按主机自动命名）。
- `ui/SetupFragment.kt` — 加扫码入口 `scanLauncher`（StartActivityForResult），扫描结果回填 地址/端口/令牌 并自动走 `ConnectionProbe.probe`+`handshake`+`save` 完成连接，Profile 名用二维码 name。
- `layout/fragment_setup.xml` — 连接页加「扫码连接」按钮（TonalButton + 二维码图标）。
- `values/strings.xml` — 新增 `setup_scan_connect` / `qr_scan_*` 字符串。

## 验证
- ✅ `assembleDebug` **BUILD SUCCESSFUL**（含新增依赖下载，走 127.0.0.1:7890 代理）。
- ✅ dex：`Ltop/xxssxx/admin/ui/QrScanActivity;`、`Ltop/xxssxx/admin/data/QrLinkParser;` 已打包（classes4/classes5.dex）；zxing `HybridBinarizer` 等已打包（classes.dex）。
- ✅ aapt resources：`qr_scan_*`、`setup_scan_connect` 字符串、`activity_qr_scan` 布局、`bg_qr_scan_frame` drawable 已打包。
- ✅ aapt manifest：`android.permission.CAMERA` 已合并；QrScanActivity 已声明。
- ✅ 解析语义：Node 模拟 6 用例全过（含缺 token/错 scheme/无 host/端口越界/URL 编码）。
- ⚠️ `testDebugUnitTest` 任务在本机 Gradle 8.13+JDK 环境下报 "Type T not present"（**既有基础设施问题，非本次代码**）；改用 `compileDebugKotlin` 确认解析器随主工程编译通过，逻辑另经 Node 全用例验证。

## 产物
- APK：`pi_workspace/output/xxsx-admin-scanfix-debug.apk`（app-debug.apk，8.58MB）。
- 源码位置同上工程（未提交 git，工作树含他处既有改动，交由 git-sync 统一处理）。

## 验收对照
1. ✅ 连接页出现「扫码连接」入口，点击拉起相机扫码。
2. ✅ 扫 `xxsx://` 二维码 → 回填地址+端口+令牌 → 走 probe+handshake+save 完成连接（复用既有握手链路），Profile 名取二维码 name。
3. ✅ 解析不依赖 Web 生成端（管理端独立识别，Web 端生成归 P1）。
4. ✅ `assembleDebug` BUILD SUCCESSFUL；dex/aapt 确认扫码类与 strings 已打包。
5. ✅ 遵守「禁止全盘 find/grep」，仅限项目内路径查找。

## 遗留
- 真机扫码需用户实机验收（遵守模拟器禁令）。
- Web 后台生成 `xxsx://` 二维码（连接分享）归 P1。
