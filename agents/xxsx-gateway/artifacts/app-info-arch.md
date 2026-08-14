# APP 体验重构（告警日志分类/颜色语义/信息架构）— v1.7.10 并入版完成报告

**时间**：2026-08-08 21:11
**智能体**：xxsx-gateway
**项目**：`D:\dx\projects\xxsx-proxy-gateway\apps\xxsx-admin-android`
**构建**：`:app:compileDebugKotlin` + `:app:assembleDebug` 均 **BUILD SUCCESSFUL**（JDK 17 / Gradle 8.13）
**APK**：`app/build/outputs/apk/debug/app-debug.apk`（7.5 MB）
**版本**：v1.7.10 / versionCode 44 —— 因 v1.7.10 改动尚未提交发布，本任务按任务备注**并入 v1.7.10**（不单独升 1.7.11）

---

## 一、信息架构重构（4 Tab 化）

底部导航从 5 Tab（概览/助手/服务器/日志/更多）改为 **4 Tab**：

| Tab | 图标 | 内容 | 来源 |
|---|---|---|---|
| **对话** | 聊天气泡（ic_nav_assistant） | 管理员助手（智能体集群对话中心，**默认进入**） | 原「助手」 |
| **监控** | 仪表盘（ic_nav_monitor，新） | 集群状态（原概览）+ 服务器与账号池（原服务器）+ 请求日志（原日志），顶部子切换 | 原「概览+服务器+日志」合并 |
| **告警** | 铃铛（ic_nav_alerts，新） | 提醒日志：分类 Tab/筛选 + 颜色分级 + 误报处理（**全新页**） | 原散落在设置页的告警列表 |
| **设置** | 齿轮（ic_nav_settings，新） | 维护与设置（连接/模块/通知/更新/故障中心） | 原「更多」 |

### 监控 Tab = 容器（MonitorFragment）
- 新增 `MonitorFragment`：顶部 `ChipGroup` 子切换「集群状态 / 服务器与账号池 / 请求日志」，用 childFragmentManager + show/hide 承载三个子 Fragment（`OverviewFragment`/`ServersFragment`/`LogsFragment`），保留原逻辑，不再单独存在三个 Tab。
- 原「概览」页取消独立入口，并入监控「集群状态」；原「服务器」「日志」并入监控子区块。

## 二、告警日志界面（新「告警」Tab）

新增 `AlertsFragment` + `AlertAdapter` + `AlertEntry` + `AlertLogStore`。

1. **分类**：`AlertCategorizer.categoryOf(kind)` 把后端告警 kind 映射到 5 类：
   - 集群：`task_*`、`agent*`、`assistant*`
   - 渠道：`cluster_outage`、`channel*`、`provider*`、`outage`
   - 号池：`sub2api*`、`quota*`、`model_quota*`
   - 系统：`system*` 及兜底
   - 全部
2. **筛选**：分类 ChipGroup（全部/集群/号池/系统/渠道）+ 时间范围（全部/今天/近7天/近30天）+ 已读状态（全部/未读/已读）+ 显示/隐藏已忽略开关。
3. **颜色语义（统一，与控制台一致）**：`AlertCategorizer.stateOf` 决定状态：
   - **完成 = 绿**（`task_done` / severity success / info）
   - **失败 = 红**（`task_failed` / severity critical / error）
   - **进行中 = 蓝**（running / progress）——新增 `status_info` 色（#2E6FD8 / 夜间 #7AB2FF）
   - **警告 = 橙**（其余）
   卡片左边框 + 状态标签同色，深/浅色自适应。
4. **误报处理**：长按告警弹出菜单 →「标记忽略 / 恢复显示 / 标记已读 / 标记未读」。忽略状态存入本地 `AlertLogStore`（SharedPreferences，指纹去重），本地过滤不再展示，可恢复。「回传配置」为可选增强，因要求「告警数据源不变」且后端无对应接口，本版只做本地过滤（符合「本地过滤 + 可选」表述）。
5. **时间线**：按 `last_seen_at` 倒序展示，每项含时间、出现次数、kind。

### 数据源不变
告警仍来自 `/api/mobile/admin/incidents` 的 `recent_alerts`（与改造前一致），客户端只做分类与着色，**未新增/改动后端 API**。

## 三、关键改动清单

**新增文件（本任务）**
- `ui/MonitorFragment.kt`、`ui/AlertsFragment.kt`、`ui/AlertAdapter.kt`、`ui/AlertEntry.kt`、`ui/AlertLogStore.kt`
- `res/layout/fragment_monitor.xml`、`fragment_alerts.xml`、`item_alert.xml`
- `res/drawable/ic_nav_monitor.xml`、`ic_nav_alerts.xml`、`ic_nav_settings.xml`、`bg_alert_unread_dot.xml`

**修改文件（本任务）**
- `MainActivity.kt`：导航 4 Tab 映射 + 默认进入「对话」；外部导入投递通道加 `PendingImport` 兜底（兼容子 Fragment）
- `ui/ServersFragment.kt`：消费 `MainActivity.PendingImport`（外部账号导入在子 Fragment 场景下的兜底投递）+ 新增 `consumeExternalImport()`
- `ui/MoreFragment.kt`：移除重复的「最近告警」列表与 `alertView`（告警列表已迁往「告警」Tab），保留故障中心检查项
- `res/menu/main_navigation.xml`：4 项
- `res/values/strings.xml`、`res/values/colors.xml`、`res/values-night/colors.xml`：新增导航/告警文案与 `status_info` 颜色

## 四、截图说明（未启动模拟器，按渲染逻辑说明）

| 区域 | 改造前 | 改造后 |
|---|---|---|
| 底部导航 | 5 Tab：概览/助手/服务器/日志/更多 | 4 Tab：对话/监控/告警/设置（齿轮/铃铛/仪表盘语义图标） |
| 首页默认 | 服务器概览 | 智能体集群对话中心 |
| 概览 | 独立 Tab | 并入「监控」→「集群状态」子页 |
| 服务器/日志 | 独立 Tab | 并入「监控」子页（顶部 Chip 切换） |
| 告警 | 散落在设置页、全部堆叠（橙/红混合） | 独立「告警」Tab：分类 Chip + 时间范围 + 已读筛选 + 忽略开关 |
| 告警颜色 | 按 severity 只有 正常绿/故障红/关注橙 | 按语义：完成绿/失败红/进行中蓝/警告橙，边框+标签同色 |
| 误报 | 无 | 长按标记忽略，本地过滤可恢复 |

## 五、风险与说明
- 外部账号导入（分享文件进 APP）在子 Fragment 化后，`setFragmentResult` 可能落在不同 FragmentManager，故加 `PendingImport` 静态兜底通道；若用户已停在「监控→服务器」子页时导入，需切到服务器子页触发消费（受限但可用）。
- 版本并入 v1.7.10（未单独升 1.7.11），与 v1.7.10 未提交改动共存。
