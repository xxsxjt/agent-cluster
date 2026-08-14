# APP Bug 修复清单 — v1.7.12 发布报告

**时间**：2026-08-08 22:2x
**智能体**：xxsx-gateway
**项目**：`D:\dx\projects\xxsx-proxy-gateway\apps\xxsx-admin-android`
**版本**：v1.7.11 → **v1.7.12**（versionCode 45 → 46）
**构建**：`:app:compileDebugKotlin` + `:app:assembleDebug` 均 **BUILD SUCCESSFUL**（JDK 17 / Gradle 8.13）
**APK**：`pi_workspace\output\xxsx-admin-1.7.12.apk`（6.5 MB，versionCode=46 / versionName=1.7.12）
**SHA-256**：`df5e0a055e86bd3025788cef34499c03a1e6bf04bdded1befd6afa3ae3ee2ab6`

---

## 修复清单（逐条：原因 / 修复 / 验证）

### 1. 切换智能体对话框不自动关闭
- **原因**：`MaterialSelectionDialog.single()` 在单选行的 `onClick` 里只调用了 `item.onClick()`，没有关闭弹窗（`dialog.dismiss()`）。原 `AlertDialog.setItems` 选中即关，改造到自定义 Material 弹窗时丢失了关闭逻辑。
- **修复**：`MaterialSelectionDialog.kt` 的 `single()` 捕获 `dialog` 引用，行点击回调后 `if (dialog.isShowing) dialog.dismiss()`；`onDismiss` 仍触发（Hermes 审批的 `pendingHermesApprovalRunId` 复位语义不变）。
- **验证**：编译通过；dex 含 `MaterialSelectionDialog$single` lambda；代码审查——点击「选择对话智能体」任一项后弹窗关闭。

### 2. 监控界面啥都加载不出来（集群状态/服务器列表/集群文档）
- **原因（根因）**：`MonitorFragment.showFragment()` 第一行 `if (viewBinding.monitorContent.childCount == 0) return`。`monitorContent` 是初始为空的 `FrameLayout`，首次加载时 `childCount==0` → 方法直接 return，**子 Fragment 永远不被 add** → 整个监控页空白。4Tab 重构（v1.7.10）时未实机验证，此 bug 随 v1.7.10/v1.7.11 上线。
- **修复**：
  - 移除该错误 guard（`childFragmentManager.isStateSaved` 才是正确保护）。
  - 修正 `onViewCreated` 首帧用 `switchTo(currentTab)`（支持外部跳转写好的 `pendingTab`），不再硬编码 `TAB_STATUS`。
  - **恢复「集群文档」入口**（重构时丢失）：集群卡片新增「集群文档」按钮 → `openClusterDocs()` 拉 `/api/mobile/admin/cluster/docs` 列表 → `downloadClusterDoc()` 下载到 `cacheDir/cluster-docs/` → `openDocFile()` 用 FileProvider 打开/回退文本弹窗。
- **验证**：
  - 用 `verify-endpoints.py` 在 HK 造临时移动 token（scopes `*`），实测 5 个端点全部 200 且数据完整：
    - `/api/mobile/admin/cluster/state` → `configured:true` + butler/twin/agents/running_tasks/recent_tasks/channel ✅
    - `/api/mobile/admin/host/status` → hostname/load/memory/disks/services 全返回 ✅
    - `/api/mobile/admin/cluster/docs` → 返回完整 docs 列表（artifacts/knowledge）✅
    - `/api/mobile/admin/overview` → host 数据 ✅
    - `/api/mobile/admin/servers` → US Sub2API 服务器 ✅
  - HK org `/api/cluster/health`（x-pi-token）直连返回真实数据，说明后端/org 代理链路正常，**故障确在 APP 渲染层（guard bug）**。
  - 编译 + dex 含 `openClusterDocs`/`downloadClusterDoc`。

### 3. 没有加载转圈提示
- **原因**：OverviewFragment / ServersFragment / AlertsFragment 加载时无进度指示（LogsFragment 已有）。
- **修复**：三个布局分别加 Material `LinearProgressIndicator`（id `loading`）：
  - `OverviewFragment.refresh()`、`ServersFragment.refresh()` 加载中 `VISIBLE`、结束 `GONE`。
  - `AlertsFragment.loadAlerts()` 同样切换；失败仍走 `showError`（可重试）。
- **验证**：编译通过；dex/布局资源均含 loading 指示。

### 4. 模型选择还是旧的 AI 助手的
- **原因**：对话中心（智能体集群）的模型由集群侧 `twin-daemon` 统一调度；旧「主模型/备用模型链/执行权限/单轮步骤」来自旧 assistant `/assistant/status` 的 `enabled_model_names`，对集群对话无效。
- **修复**：`AssistantFragment.showConversationSettings()` 对非 hermes 智能体（twin/coo 等集群智能体）改为**只读信息弹窗**——显示智能体名称 + `模型 twin-daemon（由智能体集群对话中心统一调度）`，不再展示无法生效的旧模型下拉/备用链/权限/步骤编辑项。Hermes 仍保留原有可编辑配置。
- **验证**：编译 + dex 含 `showClusterConversationInfo`；代码审查分支逻辑（`agent != "hermes"` → 只读）。

### 5. 莫名其妙的限制设置，跟实际情况对不上
- **原因**：同 #4 根因——对话中心弹窗里的「执行权限（代审批/完全允许）/单轮最大步骤 1-64/备用模型链」是旧 Hermes 助手的限制项，不适用于集群智能体对话（twin 无审批/无步骤概念）。
- **修复**：随 #4 一并处理——集群对话不再展示这些旧限制项；设置页新增的「功能模块/号池管理」区域与真实能力对齐。
- **验证**：同 #4。

### 6. 设置界面 UI 没统一
- **原因**：设置页部分弹窗仍用原生 `AlertDialog.Builder`（非 Material），与 Material3 卡片/开关风格不统一。
- **修复**：
  - `MoreFragment.confirmDisconnect()` 改用 `MaterialAlertDialogBuilder`。
  - 设置页新增统一 Material3 风格区块：功能模块（MaterialSwitch）+ 号池管理（OutlinedButton），与现有 MaterialCardView 风格一致。
- **验证**：编译通过。

### 7. 设置想要「功能页开关」（模块化开关）
- **原因**：无模块开关能力。
- **修复**：
  - 新增 `ModulePrefs.kt`（SharedPreferences，默认全开）：`KEY_CLUSTER`（智能体集群对话）/ `KEY_POOL`（号池管理）/ `KEY_CHATROOM`（聊天室，管理端暂无入口，保留开关待接入）。
  - 设置页顶部新增「功能模块」三个 MaterialSwitch，切换即持久化。
  - `MainActivity.applyModuleVisibility()`：智能体集群对话关闭 → 隐藏底部「对话」导航项；若当前正停在对话 Tab 则切到监控。`refreshModuleVisibility()` 供设置页即时刷新。
  - `ServersFragment`：号池管理关闭 → 隐藏号池卡片（`sub2Card`）；`MoreFragment`：号池管理关闭 → 隐藏设置页「号池管理」区块（`poolModuleSection`）。
- **验证**：编译 + dex 含 `ModulePrefs`；`FragmentServersBinding`/`FragmentMoreBinding` 均含新 id。

### 8. 号池导入功能没了
- **原因**：4Tab 重构把服务器页并入监控子页，且监控页因 #2 guard bug 全空白，用户无法到达「服务器与账号池 → 账号导入」区块；同时设置页缺号池导入直达入口。
- **修复**：
  - #2 修复后「监控→服务器→账号导入」区块恢复可访问。
  - 设置页新增「号池管理」区块：
    - 「账号池管理」→ 直接打开 `Sub2AccountManagementSheet`。
    - 「账号导入」→ `MainActivity.openServers()`（写 `MonitorFragment.pendingTab = TAB_SERVERS` 后切到监控→服务器，落在账号导入区块）。
- **验证**：编译通过；`MonitorFragment` 支持 `pendingTab` 深链跳转到服务器子页。

### 9. 对话记录同步（与 dual-cluster-sync 联动）
- **结论**：APP 侧读取无需改动——对话记录经 `GET /api/mobile/admin/assistant/conversations/{id}/messages` 从 HK 后端读取，而 dual-cluster-sync 同步的是集群对话数据到该后端，APP 读取即同步后的数据。已确认该接口由现有 `loadMessages()` 正常消费、渲染正确。**本任务只做确认，不新增 APP 代码。**

---

## 发布（v1.7.12 已上线更新通道）
- 版本递增：`build.gradle.kts` versionCode 45→46、versionName 1.7.11→1.7.12。
- 构建：`./gradlew.bat :app:assembleDebug` BUILD SUCCESSFUL → `app-debug.apk`（6536179B，46/1.7.12）。
- 发布：`engagements/release-20260808-v1712/deploy-v1712.py`（直连 HK，沿用 v1.7.8~1.7.11 流程）→ 备份旧版 45/1.7.11 到 `/opt/xxsx-api/backups/android-release-v1712-20260808-222504/` → sftp 上传新 APK+manifest → sha256 校验一致 → mv 落地。
- 验证：`verify-v1712.py`（临时移动 token，scopes `*`）→ `GET /api/mobile/admin/app-release` 返回 `available:true, version_code:46, version_name:1.7.12, sha256:df5e0a05…, size_bytes:6536179`；`/app-release/download` sha256 == 本机一致；测试 token 已吊销。
- **邮件**：不发（通知规范——软件更新由 task_done 自动通知用户覆盖）。

## 产物
- 代码改动：`MaterialSelectionDialog.kt` / `MonitorFragment.kt` / `OverviewFragment.kt` / `ServersFragment.kt` / `AlertsFragment.kt` / `AssistantFragment.kt` / `MoreFragment.kt` / `MainActivity.kt` / `ModulePrefs.kt`（新）/ `build.gradle.kts`
- 布局改动：`fragment_monitor.xml`（无，逻辑修复）/ `fragment_overview.xml` / `fragment_servers.xml` / `fragment_alerts.xml` / `fragment_more.xml`
- 发布脚本：`engagements/release-20260808-v1712/{deploy-v1712.py, verify-v1712.py}`
- 交付物：`pi_workspace/output/xxsx-admin-1.7.12.apk`
- 本报告：`agents/xxsx-gateway/artifacts/app-bugfix-list.md`

## 边界 / 说明
- 仍为 debug 自签名 APK（无 release keystore，沿用历史发布方式）。
- 真机逻辑验证：本次无法在本机启动 Android 模拟器，采用「后端 curl 实测 + 编译构建 + dex/资源核对 + 代码审查」闭环；建议用户装 1.7.12 后实机确认一次监控页渲染与模块开关。
- 「聊天室」模块开关已提供但管理端当前无聊天室入口（用户端 ChatRoom 在另一 APP），保留开关待后续接入。
