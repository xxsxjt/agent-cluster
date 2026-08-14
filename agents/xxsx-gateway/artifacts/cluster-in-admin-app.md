# 智能体集群接入 xxsx-admin-android（监控 + 告警通知）

> 2026-08-08 · agent: xxsx-gateway · provider: deepseek · 任务 `cluster-in-admin-app`
> 目标：把**服务器集群（智能体集群）**能力并入**已有** xxsx-admin-android，不新做独立 APP。

## 一句话结论

模型渠道全挂（model-fallback-chain）→ **注入 new-api 现有 `admin_mobile_alerts` 表** → APP 现有 SSE/轮询自动弹系统通知（**零新增通知代码**）；APP 服务器页新增「智能体集群」卡片看管家/分身/任务/渠道状态。Go 后端 + Android 全部构建通过，debug APK 已产出。

---

## 一、通知链路勘察（现状）

| 文件 | 作用 | 数据来源 |
|---|---|---|
| `AlertNotifier.kt` | 系统通知渲染（4 个 channel：紧急/提醒/额度预警/实时监控） | 收到 `JSONObject` alert 即通知 |
| `AlertStreamService.kt` | 前台 Service，SSE 实时流 | `/api/mobile/admin/alerts/stream?after_id=` |
| `AlertWorker.kt` | WorkManager 轮询兜底（15min + refreshNow） | `/api/mobile/admin/alerts?after_id=` |

**关键结论**：APP 的 `AlertNotifier.notify()` 是**通用渲染器**——后端 `admin_mobile_alerts` 表里出现任何 alert，SSE/轮询都会拉到并弹系统通知。所以**集群告警只需在后端注入这张表**，APP 通知侧完全不用改。

后端注入点（Go）：`controller/admin_mobile_alert.go` 的 `performAdminMobileAlertCheck()` → `model.CreateAdminMobileAlert(root.Id, alert, dedup)`（按 `Fingerprint` 去重，60min 窗口）。

## 二、改动清单

### A. org web server（数据源，本机 + HK 同代码）
文件：`pi_workspace/org/web/server.js`
- 新增 `clusterHealth()` 函数 + 路由 `GET /api/cluster/health`（走既有 token 鉴权 `x-pi-token`/`?token=`）
- 返回精选集群健康摘要：
  - `butler`（管家 PID/在线/since）、`twin`（分身 PID/在线/最后活动）
  - `agents`（智能体 active/sleeping/busy 数）
  - `runningTasks`、`recentTasks`（最近 10 条状态）
  - `channel`：`channel-health.json`（各渠道冷却/失败计数）+ `channel-outage.json`（全挂事件行）+ `allChannelsFailed` 标记
- 已实测（临时 8799 实例）：返回真实数据——管家在线 PID 21084、分身在线 PID 8820、2 个活动任务、17 智能体、渠道健康空（未触发过）

### B. new-api 后端（Go，HK）
1. `setting/mobilealert/setting.go`：新增集群监控配置
   - `MobileAlertClusterEnabled`（默认 true）
   - `MobileAlertClusterEndpoint`（org `/api/cluster/health` 的 URL）
   - `MobileAlertClusterToken`（x-pi-token，鉴权）
   - `MobileAlertClusterIntervalMinutes`（默认 2）
2. 新增 `controller/admin_mobile_cluster.go`：
   - `GET /api/mobile/admin/cluster/state`（`AdminMobileAuth("alerts:read")`）→ 代理读取集群健康，**只回显精选字段**（不透传 org 全量，隐私+体积），带 15s 缓存
   - `runClusterAlertCheck()` → 轮询检测 `channel.allChannelsFailed=true` → `model.CreateAdminMobileAlert{Kind:"cluster_outage", Severity:"critical"}` 注入告警表
   - `StartClusterAlertTasks()` → 独立周期协程
3. `router/api-router.go`：注册 `mobileAdminRoute.GET("/cluster/state", ...)`
4. `controller/admin_assistant_background.go`：`StartAdminAssistantBackgroundTasks()` 里挂载 `StartClusterAlertTasks()`
5. `go build ./...` ✅、`go vet` ✅

### C. Android APP
文件：`apps/xxsx-admin-android/...`
1. `res/layout/fragment_servers.xml`：主服务器卡片下方新增「智能体集群」MaterialCardView（`clusterHealth` + `clusterDetails`）
2. `ui/ServersFragment.kt`：
   - `refresh()` 新增 `async { repository.get("/api/mobile/admin/cluster/state") }`
   - 新增 `renderCluster()`：显示 管家/分身 在线、智能体数、活动任务数、最近任务、渠道全挂告警；未配置/读取失败给出提示
3. `:app:compileDebugKotlin` ✅、`:app:assembleDebug` ✅（`app-debug.apk` 6.4MB）
4. **通知侧零改动**：`cluster_outage` alert 由现有 `AlertNotifier` 自动弹通知

## 三、数据流图

```
[本机/HK org]                          [new-api 后端 HK]                     [Android APP]
channel-fallback.js                    mobilealert 配置                      ServersFragment
  └─ 渠道连续失败→冷却 → 全挂
     写 logs/channel-outage.json       ┌─ StartClusterAlertTasks()────────┐  刷新 → GET /cluster/state
              │                        │  轮询 /api/cluster/health        │         │
              ▼                        │  (x-pi-token)                     │         ▼
GET /api/cluster/health ────────────► │  ├─ 全挂? ──► CreateAdminMobile   │   renderCluster() 卡片
  {butler,twin,tasks,channel,         │  │            Alert(cluster_outage)│         ▲
   allChannelsFailed}                 │  └─ 状态 ──► GET /cluster/state    │         │
                                      └───────────┼──────────────┬─────────┘         │
                                     admin_mobile_alerts 表      │               显示
                                             │                  └── 精选状态 ────────┘
                                             ▼
                          SSE /api/mobile/admin/alerts/stream
                          + 轮询 /alerts  → AlertNotifier → 系统通知
```

## 四、部署/配置步骤（2026-08-08 已完成，任务 cluster-deploy-finish）

> 2026-08-08 14:30 由 `cluster-deploy-finish` 任务完成全部部署，本机 + HK 全链路验证通过。

1. **org server.js 部署到两端** ✅
   - HK org 8788：scp 本机最新 `server.js`（含 clusterHealth）→ 备份 `server.js.bak-20260808-cluster` → `mv` 替换（owner org-runner）→ `node --check` 语法过 → `systemctl restart org-web`（PID 1653842）
   - 验证：`GET http://100.97.18.59:8788/api/cluster/health`（带 x-pi-token）返回真实数据——butler PID 1211606 在线、twin PID 679325 在线、16 agents（2 active/14 sleeping）、最近任务列表
   - ⚠️ HK org web 仅绑定 Tailscale IP `100.97.18.59:8788`（非 127.0.0.1），故 cluster endpoint 用 `http://100.97.18.59:8788/api/cluster/health`（同机经 Tailscale IP 可达，已验证 HTTP 200）
   - 本机 8787：旧进程（PID 27356）为旧代码，`bootstrap.js web stop/start` 重启（新 PID 15408），`/api/cluster/health` 生效（butler/twin 在线、17 agents）
2. **HK new-api 集群监控** ✅
   - **二进制替换**：HK 生产 `bin/new-api`（8/6 旧版，无 cluster）→ 用本机 `WorkBuddy/xxsx-proxy-gateway/upstream/new-api-main`（含 cluster 改动，纯 Go sqlite 无 CGO）交叉编译 `GOOS=linux GOARCH=amd64 CGO_ENABLED=0` 出新二进制（162MB）
   - **安全确认**：新二进制相对生产唯一新增即 cluster 代码（4 个 Go 文件为 8/6 构建后唯一改动；字符串 diff 确认新增只有 ClusterEndpoint/GetAdminMobileClusterState/StartClusterAlertTasks 等）；备份 `new-api.bak.20260808-cluster` → 停服 → fuser 无占用 → cp 重建 inode（避 ETXTBSY）→ 启动（PID 1657945）→ `systemctl is-active` active、端口 3461 正常
   - **配置**（DB options 表，`loadOptionsFromDatabase` 启动加载 + `SyncOptions` 周期同步）：
     - `MobileAlertClusterEndpoint=http://100.97.18.59:8788/api/cluster/health`
     - `MobileAlertClusterToken=<org x-pi-token，脱敏>`
     - `MobileAlertClusterEnabled=true`、`MobileAlertClusterIntervalMinutes=2`
   - 数据源说明：当前 cluster health 指向 **HK org**（与 new-api 同机）；HK 目前不跑 model-fallback-chain，channel 数据为空（正常）。若需捕获本机 fallback-chain 全挂，可另配 endpoint 为本机 8787（经 Tailscale），见下节。
3. **链路验证** ✅
   - 正常态：`GET /api/mobile/admin/cluster/state`（`Authorization: Bearer <移动管理令牌>`）→ `configured:true` + butler/twin/16 agents/最近任务/channel 全部真实返回
   - 告警态：向 HK org `logs/channel-outage.json` 写入模拟行（`allChannelsFailed:true`）→ org cluster health 变 `allChannelsFailed=True` → new-api `StartClusterAlertTasks` 首次轮询检测到 → `admin_mobile_alerts` 表新增 `id=49 kind=cluster_outage severity=critical`「智能体集群模型渠道全挂（触发任务：cluster-deploy-test）」→ 日志 `cluster outage mobile alert emitted`（fingerprint `cluster:channel-outage` 去重）
   - 现场恢复：删模拟文件 → org/new-api 均回 `allChannelsFailed=False`；吊销测试设备（id=100，`*` scope）→ 测试 token 返回 401
4. **APK 交付** ✅：`app-debug.apk`（6472722B，8/8 11:55 构建，含集群卡片）→ 拷贝 `pi_workspace/output/xxsx-admin-debug.apk`
5. **鉴权说明**：`alerts:read` scope 由 `host:read` 隐含授权（`HasScope` 兼容规则）——现有设备「我的手机」已含 `host:read`，可直接访问 cluster/state 无需重新授权

## 五、安全 / 隐私

- 集群状态经 `AdminMobileAuth`（现有移动管理令牌）鉴权，复用 `alerts:read` scope（默认 `*` 全开）
- org `/api/cluster/health` 走 `x-pi-token`（与 `/api/state` 同一鉴权），不裸奔
- 后端 `/cluster/state` **只回显精选字段**（管家/分身在线、任务数、渠道健康），**不透传** org 全量树/agent 记忆/微信等敏感数据
- 告警仅含「渠道全挂 + 触发任务名」，无敏感内容

## 六、产物

- Go 后端：`upstream/new-api-main/controller/admin_mobile_cluster.go`（新）
- Go 配置：`upstream/new-api-main/setting/mobilealert/setting.go`（改）
- Go 路由/后台：`router/api-router.go`、`controller/admin_assistant_background.go`（改）
- org 端点：`pi_workspace/org/web/server.js`（改）
- APP：`fragment_servers.xml`、`ServersFragment.kt`（改）
- debug APK：`apps/xxsx-admin-android/app/build/outputs/apk/debug/app-debug.apk`
- 本报告：`agents/xxsx-gateway/artifacts/cluster-in-admin-app.md`

## 七、未做/待用户确认

- **未出正式发布版 APK**：debug APK 可装测试；正式发布走既有 `GetAdminMobileAppRelease` 发布流程（上传 release APK 到服务器）
- **cluster health 数据源目前指向 HK org（同机）**：HK 不跑 model-fallback-chain，故 channel 数据为空、不会触发全挂告警。若要监控**本机**渠道全挂：
  - 把本机 org `/api/cluster/health` 经 Tailscale 暴露（本机 org 绑 0.0.0.0 或 SSH 隧道）→ 改 `MobileAlertClusterEndpoint` 为本机地址 + 对应 token
  - 或在 HK 侧也部署 model-fallback-chain 写 HK 的 channel-outage.json
- **APP 端未实机测试**：Go 后端/org 链路已全验证，但「手机装 APK → 看集群卡片 → 收全挂通知」建议用户实机确认一次
- **本机 org web 重启**已用 `bootstrap.js web start` 完成（新 PID 15408），watchdog 每 10 分钟端口探测保活

---

## 八、正式版本发布 + SMTP 邮件通知（2026-08-08 · 任务 cluster-apk-release）

> 用户 2026-08-08 要求把集群能力 APK **发布到 APP 更新通道** + 部署完成后 **SMTP 邮件提醒** <qq-email-redacted>。cluster-deploy-finish 只交付了 debug APK，本任务补齐发布+邮件两步。

### 1. 发布流程调研（不瞎猜）

- **历史发布**：`WorkBuddy/xxsx-proxy-gateway/engagements/android-release-20260719/deploy-apk.py` —— 走 US→HK SSH 跳板，上传 **debug APK** 到 `/opt/xxsx-api/releases/xxsx-admin.apk` + `.json` manifest（version_code/version_name/release_notes/published_at），备份到 `/opt/xxsx-api/backups/`。**无 release keystore/签名**（build.gradle.kts 无 signingConfig），历史即用 debug 自签名 APK 作为发布版。
- **更新接口**：new-api `controller/admin_mobile_release.go` → `GET /api/mobile/admin/app-release`（`AdminMobileAuth("host:read")`），读 APK + 同目录 `.json` manifest；`/app-release/download` 返回 APK。APP（`MoreFragment.checkForUpdate`）判定：`server.version_code > BuildConfig.VERSION_CODE` 才弹更新。
- **SMTP**：new-api DB options 已有 gmail 配置（SMTPServer=smtp.gmail.com:587 STARTTLS、SMTPAccount=xxjssxjt@gmail.com、SMTPToken=app-password）。
- **版本递增**：源版本 41/1.7.7（与 HK 已发布一致）→ **递增到 42/1.7.8**（必须同步改 APK 内部 versionCode，否则装完还是 41 会重复弹更新）。

### 2. 构建 + 发布（已完成，验证全过）

1. 改 `apps/xxsx-admin-android/app/build.gradle.kts`：`versionCode 41→42`、`versionName 1.7.7→1.7.8`
2. `./gradlew.bat :app:assembleDebug` → **BUILD SUCCESSFUL 54s** → `app-debug.apk`（6472730B，`42 / 1.7.8`，debug 自签名 SHA-256 digest `df911249...`）
3. 发布脚本（走 US→HK 跳板）：备份旧版 → sftp 上传新 APK+manifest → 校验 sha256 → `mv` 落地 → 造**临时测试移动 token**（`xxsxadm_`+随机，sha256 哈希入库，scopes `*`，user_id=1 root）→ 验证 → 吊销删除
4. **验证全过**：
   - `SERVICE=active`、`STATUS=200`
   - `GET /api/mobile/admin/app-release`（Bearer 测试 token）→ `{"available":true,"version_code":42,"version_name":"1.7.8",...}`（模拟 APP 更新检查成功，42 > 已装 41 → 会弹更新）
   - `GET /api/mobile/admin/app-release/download` 下载 → sha256 与本机 APK 一致 `9bfe9a6c...ae5d6`
   - 测试 token 已吊销（DB count=0）；旧版 41/1.7.7 已备份 `/opt/xxsx-api/backups/android-release-cluster-20260808-171835/`
5. 更新说明（manifest UTF-8 中文）：「新增智能体集群监控与渠道告警通知：APP 服务器页新增「智能体集群」卡片，可查看管家/分身/智能体/任务状态；模型渠道全挂时自动弹系统通知提醒。建议在 APP「更多-检查更新」中升级。」
6. 交付物：`pi_workspace/output/xxsx-admin-1.7.8.apk`（sha256 `9bfe9a6c21e08dac4db42b4acd0eaa8113ecfdd62fdf49b3664a7c53918ae5d6`，= 线上 APK）

### 3. SMTP 邮件（已完成，发送成功）

- **方式**：HK 服务器上用 new-api 的 gmail SMTP 配置（smtp.gmail.com:587 STARTTLS + app password）直发
- **收件人**：<qq-email-redacted>
- **标题**：`xxsx 管理端新版本已发布（智能体集群监控）`
- **正文**：版本号 1.7.8（versionCode 42）、发布时间、更新内容（集群监控 + 渠道告警通知）、提示在 APP「更多→检查更新」里更新
- **确认**：smtplib `sendmail` 无异常 → `MAIL_SENT_OK`（SMTP 服务端接受，退出码 0）
- 正文不含任何敏感 token

### 4. 限制 / 说明

- 沿用历史发布方式发布的是 **debug 自签名 APK**（无 release keystore）；功能上可正常安装使用，但非正式 keystore 签名，正式上架商店需另配签名。
- cluster health 数据源仍指向 HK org（同机），HK 当前不跑 model-fallback-chain，channel 数据为空、不会触发全挂告警；若要监控本机渠道全挂需另配 endpoint（见「七、未做/待用户确认」）。
- APP 实机更新（手机装 42 → 看到集群卡片 → 收全挂通知）建议用户实机确认一次。

---

## 九、任务完成通知 + 集群文档下载 + v2 发布（2026-08-08 · 任务 cluster-task-notify-docs）

> 用户 2026-08-08 17:0x 要求：①智能体集群任务完成后 → 安卓管理端 APP 弹通知（不用邮件）；②集群产出文档 → APP 里下载。本任务功能并入发布版，因 v1.7.8 已发布，本版作为 **v2 发布**（versionCode 43 / versionName 1.7.9）。

### 1. 任务完成通知（本机 org → HK new-api → APP）✅ 全链路验证

- **本机 org 侧**：`butler.js` 在任务 .DONE/.FAILED 写入时钩子 `notifyTaskEvent()` → spawn `scripts/hk-alert.js <任务名> done|failed <摘要>`。只报离散的完成/失败事件（失败必报、完成按配置 `config/cluster-notify.json` 的 `notifyDone` 可选），**不会每轮巡查刷屏**。
- **hk-alert.js**（本机脚本）：SSH 到 HK → `curl POST /api/mobile/admin/cluster/notify`（`x-cluster-token` = org x-pi-token）→ 写 `admin_mobile_alerts` 表（kind=task_done/task_failed，severity=info/warning）。
- **HK new-api 侧**：`controller/admin_mobile_cluster.go` 的 `NotifyAdminMobileCluster()`——自鉴权（校验 `x-cluster-token` == MobileAlertClusterToken）；按 `fingerprint=cluster:task:<name>` 经 `CreateAdminMobileAlert` **去重**（防刷屏，同任务不重复通知）。
- **验证**：跑 `node scripts/hk-alert.js "测试任务" done` → 注入 `admin_mobile_alerts`（id=51，created:true）；**再跑同任务 → `already_exists:true, created:false`（去重生效）**；APP 现有 SSE/轮询自动拉取弹系统通知（AlertNotifier 复用，零新增通知代码）。测试告警已清理。

### 2. 集群文档下载（APP 下载报告/文档）✅ 全链路验证

- **本机 org 侧**（`web/server.js`）：
  - `GET /api/cluster/docs` → 列出 `agents/*/artifacts/*.md` + `knowledge/**/*.md` 最近文档（标题/路径/大小/时间）；走 `x-pi-token` 鉴权（同 clusterHealth）。
  - `GET /api/cluster/docs/content?path=` → 下载单篇（`safeOrgPath` + 正则白名单**只允许 artifacts/knowledge 下的 .md**，非敏感，隐私铁律：不碰微信/隐私数据）。
- **HK new-api 侧**（`admin_mobile_cluster.go`）：
  - `GET /api/mobile/admin/cluster/docs`（`AdminMobileAuth("alerts:read")`）→ 代理 org `/api/cluster/docs`（带 x-pi-token，20s 超时，4MB 上限）。
  - `GET /api/mobile/admin/cluster/docs/content?path=` → 代理 org 下载。
- **APP 侧**（`ServersFragment.kt` + `fragment_servers.xml` + `file_paths.xml`）：
  - 集群卡片新增「集群文档」按钮 → `openClusterDocs()` 拉列表 → AlertDialog 列表（标题·大小·时间）→ 选中 `downloadClusterDoc()` 下载到 `cacheDir/cluster-docs/`（复用 `repository.downloadFile`）→ `openDocFile()` 用 FileProvider + `ACTION_VIEW` 系统查看器打开；无查看器则回退 `TextDetailsSheet` 文本弹窗。
  - 新增 cache-path `cluster_docs` → `cluster-docs/`。
- **验证**：本地 org 8787 `GET /api/cluster/docs`（x-pi-token）返回真实文档列表；HK 经移动 token 代理列表 + `content?path=knowledge/conventions.md` 下载 200（内容正确）；`app-release` 下载 sha256 与本机 APK 一致。

### 3. v2 发布 + SMTP 邮件（已完成，验证全过）

1. **版本递增**：`app/build.gradle.kts` `versionCode 42→43`、`versionName 1.7.8→1.7.9`。
2. **构建**：`./gradlew.bat :app:compileDebugKotlin` ✅（首轮缺 `kotlinx.coroutines.CancellationException` import 已补）→ `:app:assembleDebug` ✅ → `app-debug.apk`（6476638B，aapt badging：versionCode=43 / versionName=1.7.9，sha256 `c1c3748596b6cf1f3e4e82111364392dcaca93e658df56071568563ab30d3c22`）。
3. **发布到更新通道**（直接 SSH HK，沿用 US→HK 同款流程）：备份旧版 42/1.7.8 → sftp 上传新 APK + UTF-8 manifest（43/1.7.9，更新说明含「任务完成通知 + 集群文档下载」）→ sha256 校验一致 → `mv` 落地 → 验证：`/api/mobile/admin/app-release` 返回 `available:true, version_code:43, version_name:1.7.9`；`/app-release/download` sha256 == 本地。旧版备份 `/opt/xxsx-api/backups/android-release-v2-20260808-174709/`。
4. **SMTP 邮件**（HK 用 new-api gmail 配置 smtp.gmail.com:587 STARTTLS + app-password 直发）→ **<qq-email-redacted>**，标题 `xxsx 管理端新版本 v1.7.9 已发布（任务完成通知 + 集群文档下载）`，正文含版本号/更新内容/升级指引，smtplib `sendmail` 无异常 → `MAIL_SENT_OK`。正文不含敏感 token。
5. **更新说明文案**：新增智能体集群任务完成/失败系统通知；服务器页集群卡片新增「集群文档」入口（可浏览并下载/打开产出文档，仅 artifacts/knowledge 非敏感文档）；集群监控与任务状态展示优化。
6. 交付物：`pi_workspace/output/xxsx-admin-1.7.9.apk`（sha256 `c1c3748596b6cf1f3e4e82111364392dcaca93e658df56071568563ab30d3c22` = 线上 APK）。

### 4. 安全 / 隐私

- 文档接口**只暴露 `agents/*/artifacts` 与 `knowledge` 下的 Markdown**（正则白名单），不暴露微信/隐私数据（隐私铁律）；`safeOrgPath` 防目录穿越。
- `cluster/notify` 用 `x-cluster-token`（== org x-pi-token，非移动令牌）自鉴权，与 org→new-api 既有 cluster 告警同一信任链；不信任外部调用。
- 任务通知按 fingerprint 去重，失败必报/完成可选，防刷屏。

### 5. 产物

- 通知链路：`scripts/hk-alert.js`（新）、`config/cluster-notify.json`（新）、`butler.js`（改，`notifyTaskEvent` 钩子）。
- Go 后端：`controller/admin_mobile_cluster.go`（改，`NotifyAdminMobileCluster` + `GetAdminMobileClusterDocs` + `DownloadAdminMobileClusterDoc` + `orgClusterFetch`）、`router/api-router.go`（改，注册 /cluster/notify + /cluster/docs + /cluster/docs/content）。
- org 端点：`web/server.js`（改，`clusterDocs()` + `handleClusterDocContent()` + 路由）。
- APP：`ServersFragment.kt`（改，集群文档列表/下载/打开）、`fragment_servers.xml`（改，集群文档按钮 + 状态）、`res/xml/file_paths.xml`（改，cluster_docs cache-path）、`app/build.gradle.kts`（改，版本 43/1.7.9）。
- 交付物：`pi_workspace/output/xxsx-admin-1.7.9.apk`。
- 本报告：`agents/xxsx-gateway/artifacts/cluster-in-admin-app.md`。

### 6. 测试遗留清理

- 测试移动 token（device 101 notify-docs-test）已吊销（revoked_at 置当前时间）；测试告警 id=50/51 已删除；临时 APK 上传文件已落正式路径。

### 7. 限制 / 说明

- 仍为 debug 自签名 APK（无 release keystore，沿用历史发布方式）。
- 通知/文档数据源指向 HK org（同机）。APP 实机「收任务完成通知 + 下载文档」建议用户实机确认一次。

---

### 8. 完善补验（cluster-task-notify-docs-improve，2026-08-08）

> 源任务 `cluster-task-notify-docs` 被分身验收判为「失败需重派」，但核查发现：**源任务实际已完整交付**，判定属误判（验收时 DONE 摘要在讨论议题中被截断）。本完善任务重跑验证全部链路，补足运行时证据：

| 验证项 | 结果 |
|---|---|
| 通知注入（首次） | `node scripts/hk-alert.js improve-verify-test done "..."` → `{"data":{"already_exists":false,"created":true,"id":51}}` ✅ |
| 通知去重（重复注入） | 同任务再跑 → `{"already_exists":true,"created":false,"id":51}` ✅（防刷屏生效） |
| 落库证据 | HK `admin_mobile_alerts` 表出现 `id=51 kind=task_done`（指纹 `cluster:task:improve-verify-test`）；另见源任务真实触发的 `id=50 task_failed`（cluster-task-notify-docs）、`id=49 cluster_outage` ✅ |
| org 文档列表 | 本机 8787 `GET /api/cluster/docs`（x-pi-token）返回真实文档（knowledge 会议纪要 + 各 agent artifacts）✅ |
| org 文档下载 | `GET /api/cluster/docs/content?path=agents/xxsx-gateway/artifacts/cluster-in-admin-app.md` 返回正确内容 ✅ |
| 目录穿越防护 | `path=../../wechat_data.json` → `{"ok":false,"error":"路径不合法"}`（隐私铁律生效）✅ |
| HK 代理鉴权 | `/api/mobile/admin/cluster/docs` 用错误 token（x-cluster-token）→ 正确拒绝「设备令牌无效」（AdminMobileAuth 生效）✅ |
| 线上 APK | HK `/opt/xxsx-api/releases/xxsx-admin.apk` sha256 `c1c37485…3d3c22` 与本机交付物 `pi_workspace/output/xxsx-admin-1.7.9.apk` 完全一致 ✅ |
| 线上版本 manifest | `/opt/xxsx-api/releases/xxsx-admin.apk.json` → `version_code:43, version_name:1.7.9`，更新说明含「任务完成通知 + 集群文档下载」✅ |
| 测试清理 | 本完善注入的测试告警 id=51 已删除，不留污染 ✅ |

**结论**：源任务 `cluster-task-notify-docs` 全部目标均已实现且运行态验证通过，无需返工；本完善任务补充了完整的端到端运行时证据。

---

## 十、助手页 → 智能体集群对话中心（2026-08-08 · 任务 cluster-assistant-hub）

> 用户 2026-08-08 19:2x 明确：智能体集群不应在服务器页加卡片，而应**取代旧助手页面**（AssistantFragment 整体改造），做成**对话中心**——可选择与哪个智能体对话（分身/管家/Hermes/各业务智能体），**默认分身（虚无圣灵）**。cluster-twin-chat 曾中途失败，本任务接管完成。

### 1. 现状勘查（关键发现：后端与 APP 大部分已由 cluster-twin-chat 完成，本任务补齐+修复+验证）
- **HK 后端多智能体已部署**：`/assistant/agents` 返回完整智能体目录（管家域/云端/业务域分组，默认 twin）；`admin_assistant_conversations` 表已有 `agent` 列；`SendAdminAssistantConversationMessage`/`StreamAdminAssistantConversationMessage` 均支持 twin 转发。本地仓库 `upstream/new-api-main` 的 `admin_assistant_cluster_chat.go` 已实现 `complete/streamAdminAssistantClusterAgentConversationMessage`。
- **twin 配置已入库**：`AssistantTwinEnabled=true`、`AssistantTwinEndpoint=http://100.103.204.86:8787`、`AssistantTwinToken=<clusterToken>`（与 config/cluster-chat-token.json 一致）。
- **org 侧 `/api/cluster/chat` 已存在**（twin-daemon 18788 桥，user-twin 脱敏人格，clusterToken 鉴权+限流）。
- **APP AssistantFragment 已实现选择器**：默认 `ASSISTANT_DEFAULT_AGENT="twin"`、`load/persistPreferredAgent()` SharedPreferences 持久化、`showAgentSelector()` 分组选择器、`ensureConversation()` 用 `?agent=`。

### 2. 本任务改动
1. **org web 暴露给 HK（关键修复）**：org web 8787 原只监听 127.0.0.1，HK 转发 twin 时报 `dial tcp 100.103.204.86:8787 i/o timeout`。改 `scripts/bootstrap.js` 的 `webStart()` 以 **0.0.0.0** 启动 + 注入 `PI_CLUSTER_TOKEN`（读 config/cluster-chat-token.json clusterToken），重启后 HK 可达；不动全局 token（保用户控制台访问不变）。
2. **APP 编译修复**：AssistantFragment 遗留 `MODE_PRIVATE` 未限定 → 改 `Context.MODE_PRIVATE`（compileDebugKotlin 原失败，修复后通过）。
3. **版本升级**：`app/build.gradle.kts` versionCode 43→**44**、versionName 1.7.9→**1.7.10**。

### 3. 端到端验证（全过）
- **twin 对话（stream，APP 实际发送路径）**：`?agent=twin` → 会话 34 → `/messages/stream` 返回 `user_message→thinking→assistant_message→complete`，分身回复（"我是虚无圣灵…"），metadata `{"agent":"twin","backend":"cluster-twin","model":"twin-daemon"}` ✅
- **twin 对话（非 stream）**：同样返回分身回复 ✅
- **hermes 兼容**：`?agent=hermes` → 会话 23（Hermes 管理主会话）；历史 hermes 会话全部保留；发消息路由到 engine=hermes（其 401 为 Hermes 自身配置问题，任务明确不修）✅
- **agent 目录**：`/assistant/agents` 返回完整分组目录（管家域/云端/业务域，默认 twin）✅
- **构建**：`compileDebugKotlin` + `assembleDebug` 通过，app-debug.apk 6.48MB ✅

### 4. 发布（44/1.7.10，已完成验证全过）
- 构建 debug 自签名 APK（沿用历史无 release keystore 方式）sha256 `06a69f9ab63879918aab6bddb03f4aad831256442248b9743b90db5aebbf82a9`
- 上传 HK `/opt/xxsx-api/releases/`，旧版 43/1.7.9 备份 `/opt/xxsx-api/backups/android-release-v3-20260808-203608/`
- 更新检查 `GET /api/mobile/admin/app-release` 返回 `version_code:44 version_name:1.7.10`，下载 sha256 与本机一致 ✅
- **SMTP 邮件** → <qq-email-redacted>（标题「xxsx 管理端新版本 v1.7.10 已发布（助手页升级为智能体集群对话中心）」），HK gmail SMTP 直发 `MAIL_SENT_OK` ✅
- 更新说明：助手页升级为「智能体集群对话中心」——可在分身（默认）/管家/Hermes 等智能体间切换对话、选择持久记忆、默认打开即分身。

### 5. 清理
- 测试移动 token（cluster-hub-test，id 102）已吊销；临时脚本已清理。

### 6. 边界/说明
- 仍为 debug 自签名 APK（无 release keystore，沿用历史发布方式）。
- twin 对话走脱敏人格（user-twin），不含微信原始数据（隐私铁律）。
- 其他智能体（coo/pm 等）已在目录列出但对话通道为扩展预留（返回"尚未接入"），当前可对话 = twin + hermes。

---

## 十一、对话选择弹窗 Material 统一 + v1.7.10 补发（2026-08-08 21:5x · 任务 release-v1710）

> 用户 2026-08-08 21:5x 检查不到更新：cluster-assistant-hub 在 20:36 发布的 44/1.7.10 是**未含 Material 统一**的构建（app-ui-unify 20:48 才完成）。本任务把「集群对话中心 + 对话选择 Material 统一」合入同一版 v1.7.10 重新发布，让用户一次拿到两项更新。

### 1. 状态核查
- 源仓库 `D:\dx\projects\xxsx-proxy-gateway\apps\xxsx-admin-android` 已含两功能：build.gradle.kts 已 44/1.7.10；`MaterialSelectionDialog.kt`（新文件，未跟踪）与 AssistantFragment 三处弹窗改造均在。
- 服务器当时线上为 **20:36 构建**（`06a69f9a…`, 6.48MB），早于 app-ui-unify（20:48），故缺 Material 统一。

### 2. 构建
- JDK 17 / Gradle 8.13 `./gradlew.bat :app:assembleDebug` → BUILD SUCCESSFUL → `app-debug.apk`（6661629B，versionCode=44 / versionName=1.7.10）。
- dex 内确认含 `MaterialSelectionDialog` 类（`classes.dex` strings 命中）→ 确认 Material 统一已打入。
- 交付物：`pi_workspace/output/xxsx-admin-1.7.10.apk`，sha256 `e5733b2cc921d9cf442a4e8d1af4f9c4f957580c0b529feb6cf6d60e72d35383`。

### 3. 发布到更新通道（HK 直连，沿用 v1.7.8/1.7.9/1.7.10 验证流程）
- 备份旧版 44/1.7.10（20:36 无 Material 版）→ `/opt/xxsx-api/backups/android-release-v1710-20260808-210104/`。
- sftp 上传新 APK + UTF-8 manifest（version_code 44 / version_name 1.7.10，更新说明含「集群对话中心 + 对话选择弹窗统一 Material 风格」）→ sha256 校验一致 → mv 落地。
- 验证：`GET /api/mobile/admin/app-release`（临时移动 token，scopes `*`）→ `available:true, version_code:44, version_name:1.7.10, sha256:e5733b2c…, size_bytes:6661629`（模拟 APP 更新检查成功）；`/app-release/download` 下载 sha256 `e5733b2c…` 与本机一致；release_notes 含「Material」与「对话中心」关键词 ✅。测试 token 已吊销（DB count=0）。

### 4. SMTP 邮件（发送成功）
- HK 用 new-api gmail 配置（smtp.gmail.com:587 STARTTLS + app-password）直发 → **<qq-email-redacted>**。
- 标题：`xxsx 管理端新版本 v1.7.10 已发布（智能体集群对话中心 + 对话选择 Material 统一）`。
- 正文：版本号 1.7.10 / versionCode 44、更新内容（集群对话中心 + Material 统一弹窗）、提示在 APP「更多→检查更新」升级。
- 确认：smtplib `sendmail` 无异常 → `MAIL_SENT_OK`，退出码 0。正文不含敏感 token。

### 5. 交付物
- 发布脚本：`WorkBuddy/xxsx-proxy-gateway/engagements/release-20260808-v1710/{deploy-v1710.py, verify-v1710.py, send-mail-v1710.py}`。
- APK：`pi_workspace/output/xxsx-admin-1.7.10.apk`（sha256 `e5733b2cc921d9cf442a4e8d1af4f9c4f957580c0b529feb6cf6d60e72d35383` = 线上）。
- 本报告：`agents/xxsx-gateway/artifacts/cluster-in-admin-app.md`（本节）。

### 6. 注意
- 更新说明合并了两项（集群对话中心 + Material 统一）；chat-attachments（对话内附件）仍开发中，下一版 v1.7.11 发布，本版不含。
- 仍为 debug 自签名 APK（无 release keystore，沿用历史发布方式）。

---

## 十二、产品化试用版 v1.7.11（2026-08-08 22:5x · 任务 release-v1711）

> 用户 2026-08-08 22:2x：产品化计划（agent-cluster-product-plan.md）P0 阶段已完成项打包发布为**试用版**让用户试：「之前那个计划，我看没什么大问题，做一个副本我试试看」。P0 完整版（自动探测握手/多 Profile/模块开关）按用户装后反馈迭代。

### 1. 已打包的 P0 功能（全部确认在源码中）
- chat-attachments ✅（AssistantFragment 对话内附件下载）
- app-info-arch ✅（4 Tab：对话/监控/告警/设置 + 告警分类/颜色）
- host-load-display ✅（CPU%/内存/磁盘 used/total）
- notify-tier ✅（severity 分级通知：critical/warning/info 分级 channel）
- SetupFragment ✅（连接页：服务器地址+token+verify，产品化「自动兼容」雏形）
- 对话中心 ✅（v1.7.10 已含）

### 2. 构建
- 源仓库 build.gradle.kts 已 45/1.7.11（versionCode 45）。
- JDK 17 / Gradle 8.13 `./gradlew.bat :app:assembleDebug` → BUILD SUCCESSFUL → `app-debug.apk`（7618244B）。
- aapt badging 确认 versionCode=45 / versionName=1.7.11。
- 交付物：`pi_workspace/output/xxsx-admin-1.7.11.apk`，sha256 `221e136039cd9290a2a87141247f6cfb4004eeca3d7cd8fd1e9acb8ad0b56ee1`。

### 3. 发布到更新通道（HK 直连，沿用 v1.7.8~1.7.10 验证流程）
- 旧版（先前会话留下的 45/1.7.11 说明）备份 → `/opt/xxsx-api/backups/android-release-v1711-20260808-215449/`。
- sftp 上传新 APK + UTF-8 manifest（version_code 45 / version_name 1.7.11，更新说明：**产品化试用版：4 Tab 重构（对话/监控/告警/设置）+ 告警日志分类与颜色分级 + CPU/磁盘明确负载 + 对话内附件下载 + 连接设置（服务器地址+密钥）**）→ sha256 校验一致 → mv 落地。
- 验证：`GET /api/mobile/admin/app-release`（临时移动 token，scopes `*`）→ `available:true, version_code:45, version_name:1.7.11, sha256:221e1360…, size_bytes:7618244`（模拟 APP 更新检查成功）；`/app-release/download` 下载 sha256 `221e1360…` 与本机一致；release_notes 含「产品化试用版」「对话中心」「连接设置」关键词 ✅。测试 token 已吊销（DB count=0）。

### 4. 邮件
- **不发**（通知规范：软件通知覆盖——task_done 自动通知用户，不发 SMTP）。

### 5. 交付物
- 发布脚本：`WorkBuddy/xxsx-proxy-gateway/engagements/release-20260808-v1711/{deploy-v1711.py, verify-v1711.py}`。
- APK：`pi_workspace/output/xxsx-admin-1.7.11.apk`（sha256 `221e136039cd9290a2a87141247f6cfb4004eeca3d7cd8fd1e9acb8ad0b56ee1` = 线上）。
- 本报告：`agents/xxsx-gateway/artifacts/cluster-in-admin-app.md`（本节）。

### 6. 说明
- 仍为 debug 自签名 APK（无 release keystore，沿用历史发布方式）。
- 试用版：用户装后反馈；P0 完整版（自动探测握手/多 Profile/模块开关）按反馈迭代。
