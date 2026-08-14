# APP 全面检查修复 + 用户端 UI 风格更新 — v1.7.13 / v0.6.4

**时间**：2026-08-09 12:5x
**智能体**：xxsx-gateway（task: app-full-audit）
**管理端**：`D:\dx\projects\xxsx-proxy-gateway\apps\xxsx-admin-android` v1.7.12 → **v1.7.13**（versionCode 46→47）
**用户端**：`D:\dx\projects\xxsx-proxy-gateway\apps\xxsx-user-android` v0.6.3 → **v0.6.4**（versionCode 9→10）
**构建**：管理端 + 用户端 `compileDebugKotlin` + `assembleDebug` 均 **BUILD SUCCESSFUL**
**发布**：管理端 v1.7.13 + 用户端 v0.6.4 已上线更新通道（不发邮件，task_done 通知）

---

## 一、管理端全面检查（v1.7.13）

### 1. 监控界面「集群状态」不对（核心）✅
- **现状问题**：监控页「集群状态」子页（TAB_STATUS）用的是 `OverviewFragment`，只渲染**主机资源**（CPU/内存/磁盘/托管服务），**没有集群状态卡片**——管家/分身/智能体数/活动任务/最近任务/渠道告警全部看不到。集群卡片此前只加在「服务器与账号池」子页的 `ServersFragment` 里，监控页的"集群状态"名不副实。
- **实测依据**：写 `verify-cluster-state.py` 在 HK 造临时移动 token（scopes `*`），实测 `GET /api/mobile/admin/cluster/state` 返回真实完整数据——`configured:true`、`butler{running,pid}`、`twin{running}`、`agents{active:6,agents:21}`、`running_tasks[app-full-audit]`、`recent_tasks[...]`、`channel{allChannelsFailed:false,health}`。**后端数据正常，故障在 APP 渲染层**（监控集群状态页未渲染集群数据）。
- **修复**：
  - `fragment_overview.xml`：新增「智能体集群」MaterialCardView（`clusterHealth` / `clusterDetails` / `clusterDocs` 按钮），置于主机资源卡片上方；补根节点 `xmlns:app` 声明（原缺失导致资源编译失败）。
  - `OverviewFragment.kt`：`refresh()` 并发请求 `overview` + `cluster/state`；新增 `renderCluster()`（管家/分身在线、智能体 active/total、活动任务数、最近任务·状态、渠道全挂告警），字段与后端实测逐一核对匹配；新增集群文档入口 `openClusterDocs()` / `downloadClusterDoc()` / `openDocFile()`（复用 FileProvider + TextDetailsSheet 回退，与 ServersFragment 一致）。
- **验证**：`compileDebugKotlin` 通过；`renderCluster` 字段（butler.running / twin.running / agents.active / running_tasks / recent_tasks / channel.allChannelsFailed）对照后端实测 JSON 完全一致。

### 2. 聊天室混入管理端（移除）✅
- **现状**：管理端无实际聊天室页面，但设置页有「聊天室」功能模块开关（`moduleChatroom` + `ModulePrefs.KEY_CHATROOM`），与"管理端纯管理职责、聊天室=用户端功能"不符。
- **修复**：**移除管理端聊天室相关**——
  - `fragment_more.xml` 删 `moduleChatroom` 开关；
  - `MoreFragment.kt` 删 `moduleChatroom` 监听；
  - `ModulePrefs.kt` 删 `KEY_CHATROOM` 常量及注释。
- **确认用户端**：`apps/xxsx-user-android` 有完整聊天室（`ChatRoomActivity`、`ChatFragment`、`ChatPeopleAdapter` 等），**保留不动**。
- **验证**：全工程 grep `CHATROOM/moduleChatroom/聊天室` 管理端无残留。

### 3. 弹窗 UI 全面统一为 Material ✅
- **现状**：大量弹窗仍用原生 `AlertDialog.Builder`（系统样式），与 Material3 卡片/开关风格不统一。
- **修复**（原生 → `MaterialAlertDialogBuilder` / `MaterialSelectionDialog`）：
  - `OverviewFragment.confirmServiceOperation`（服务启停确认）
  - `AlertsFragment` 3 处（长按告警操作列表 / 时间范围单选 / 已读状态单选）
  - `ServersFragment` 4 处（集群文档列表 + 无文档 + 失败提示 / 号池维护确认 / 副服务器操作确认 / 选择账号分组多选）
  - `AssistantFragment` 2 处（hermes 对话设置 / 集群对话只读信息）
  - `Sub2AccountManagementSheet` 5 处 + `Sub2RecycleBinSheet` 1 处（号池维护/操作确认）
- **保留**：`MaterialSelectionDialog` 内部自用 `AlertDialog.Builder` 是正确的（透明背景 + 自定义圆角卡片视图，圆角 14dp 浮动卡片风格，与集群卡片同源）。
- **验证**：全工程 `AlertDialog.Builder` 仅剩 MaterialSelectionDialog 内部实现，其余全部 Material；`compileDebugKotlin` 通过。

### 4. 设置界面与实际功能对齐 ✅
- 功能模块开关精简为「智能体集群对话 / 号池管理」两项（移除聊天室，见 #2）。
- 号池管理区块（账号池管理 + 账号导入）、故障中心、实时告警、应用更新、安全扫描、管理助手/Omni 入口、断开连接——逐项核对与实际功能一致，无遗留"旧助手"无效项。
- 监控「集群状态」卡片（#1）与设置功能对齐。

### 5. 其他走查
- 对话中心（AssistantFragment）：集群对话弹窗 Material 化、只读信息对齐集群调度（twin-daemon）、聊天室内附件渲染正常，未发现问题。
- 告警页（AlertsFragment）：分类/时间/已读筛选 + 颜色语义完整，弹窗已 Material。
- 导航（MainActivity）：4 Tab（对话/监控/告警/设置）+ 功能模块可见性联动正常，聊天室开关移除后无悬挂引用。
- 连接设置（SetupFragment）：Material 布局（TextInputLayout OutlinedBox + MaterialButton），逻辑正常。

---

## 二、用户端 UI 风格更新（v0.6.4，仅视觉，功能零改动）

- **现状**：用户端已具备完整 Material3 深色设计系统（MaterialToolbar/MaterialCardView/MaterialButtonToggleGroup/TextInputLayout/ShapeableImageView/MaterialCheckBox），弹窗全部 `MaterialAlertDialogBuilder`，配色统一（cyan/magenta/gold 品牌三色 + ink/surface 深色）。本次做**统一与精致化**，向管理端 Material 卡片风格看齐。
- **改动**：
  1. **统一圆角语言**：`bg_badge.xml` 徽章圆角 6dp → **8dp**，与气泡(8dp)/头像(8dp)/composer(8dp)/卡片(8dp) 完全一致。
  2. **「我的」页卡片化**：`fragment_profile.xml` 三个平直背景区块升级为 `MaterialCardView` 圆角 8dp 卡片——「均耗」区块、「账号信息」区块、「应用更新」区块（原来用 LinearLayout 纯背景，视觉平直，现与管理端 fragment_servers.xml 卡片风格统一）。
- **保留**：用户端品牌配色（cyan/magenta/gold，管理端为绿色系，二者属不同产品定位，未强行统一配色以免破坏品牌）；聊天室/创作/图库等功能**全部不动**，仅视觉。

---

## 三、发布

### 管理端 v1.7.13（47）
- 构建：`assembleDebug` → `app-debug.apk`（6540143B），APK `pi_workspace/output/xxsx-admin-1.7.13.apk`，sha256 `4683ec4eba3f036e9fa0de62353a84ed2d4aae48b0a29e3ec00a970bce9089b7`。
- 发布：`engagements/release-20260809-v1713/deploy-v1713.py`（直连 HK，沿用 v1.7.8~1.7.12 流程）→ 备份旧版 46/1.7.12 → 上传 APK+manifest → sha256 校验 → mv 落地。
- 验证：`verify-v1713.py`（临时移动 token）→ `GET /api/mobile/admin/app-release` 返回 `version_code:47, version_name:1.7.13, sha256:4683ec4e…, size_bytes:6540143`；`/app-release/download` sha256 == 本机一致；测试 token 已吊销。另实测 `cluster/state` 200 返回完整集群数据。
- **邮件**：不发（软件更新由 task_done 自动通知覆盖）。

### 用户端 v0.6.4（10）
- 构建：`assembleDebug` → `app-debug.apk`（8254588B），APK `pi_workspace/output/xxsx-user-0.6.4.apk`，sha256 `2838043db249a165f48001d9769118726c047328350e07bcc2de233a3cafdbf2`。
- 发布：`engagements/release-20260809-user-v064/deploy-user-apk-only.py`——仅更新 HK `/opt/xxsx-api/releases/xxsx-user.apk` + `.json`（setup.exe/guide 未变不动；nginx 仅 sed 更新下载文件名版本 0.6.3→0.6.4）。**发现并补齐线上缺失的 `xxsx-user.apk`**（此前仅 manifest 存在，APK 缺失）。
- 验证：nginx active；`curl https://api.xxssxx.top/downloads/xxsx-api-android.apk` sha256 == 本机 `2838043db…`；manifest 含 `version_code:10`。

---

## 四、产物

- 代码改动（管理端）：`OverviewFragment.kt` / `AlertsFragment.kt` / `ServersFragment.kt` / `AssistantFragment.kt` / `MoreFragment.kt` / `ModulePrefs.kt` / `dialogs/Sub2AccountManagementSheet.kt` / `dialogs/Sub2RecycleBinSheet.kt` / `build.gradle.kts`
- 布局改动（管理端）：`fragment_overview.xml`（集群卡片）/ `fragment_more.xml`（去聊天室开关）
- 代码改动（用户端）：`build.gradle.kts`
- 布局改动（用户端）：`fragment_profile.xml`（卡片化）/ `bg_badge.xml`（圆角统一）
- 发布/验证脚本：`engagements/release-20260809-v1713/{deploy-v1713.py, verify-v1713.py, verify-cluster-state.py}`、`engagements/release-20260809-user-v064/{deploy-user-v064.py, deploy-user-apk-only.py}`
- APK：`pi_workspace/output/xxsx-admin-1.7.13.apk`、`pi_workspace/output/xxsx-user-0.6.4.apk`
- 本报告：`agents/xxsx-gateway/artifacts/app-full-audit.md`

## 五、边界 / 说明
- 仍为 debug 自签名 APK（无 release keystore，沿用历史发布方式）。
- 监控集群卡片数据源为 HK org（同机），channel 数据为空属正常（HK 当前不跑 model-fallback-chain）；渠道全挂告警在配置本机数据源后生效。
- 用户端视觉统一为圆角语言 + 个人页卡片化，功能零改动；若需进一步把用户端与管理端配色/明暗模式完全统一，建议单独评估（当前保留用户端品牌色）。
- 真机渲染建议用户安装后确认一次（监控集群卡片 + 设置页无聊天室 + 弹窗 Material）。
