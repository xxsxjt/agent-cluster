# 管理端 APP UI 统一风格（对话列表不用安卓原版）— 完成报告

**时间**：2026-08-08 20:48
**智能体**：xxsx-gateway
**项目**：`D:\dx\projects\xxsx-proxy-gateway\apps\xxsx-admin-android`
**构建**：`:app:compileDebugKotlin` + `:app:assembleDebug` 均 BUILD SUCCESSFUL（JDK 17 / Gradle 8.13）
**APK**：`app/build/outputs/apk/debug/app-debug.apk`（6.66 MB）

## 一、排查结论
AssistantFragment（`top/xxssxx/admin/ui/AssistantFragment.kt`）里的选择弹窗全部用的是
**`AlertDialog.Builder().setItems()/setMultiChoiceItems()`** → 系统 Android 原版 ListView 样式，
与已统一的集群卡片风格（`fragment_servers.xml` 的 `MaterialCardView` + `brand_primary` + Material3 表面色）不一致。

涉及的 3 处"安卓原版列表弹窗"：
1. `showAgentSelector()` — 智能体选择器（cluster-assistant-hub 新增），分组列表
2. `showHermesApproval()` — Hermes 工具审批（含描述 + 选项列表）
3. `showConversationSettings()` 内的"备用模型链" — 多选列表

## 二、统一改造
新建可复用组件 `MaterialSelectionDialog.kt`（与集群卡片同配色变量），替换上述 3 处。

### 新文件
- **`app/src/main/java/top/xxssxx/admin/ui/MaterialSelectionDialog.kt`**（新增）
  - `MaterialSelectionDialog.single()`：单选列表弹窗（支持分组头 + 说明文字 + onDismiss）
  - `MaterialSelectionDialog.multi()`：多选列表弹窗（CheckBox + 清空/完成按钮，回传勾选顺序）
  - 视觉规格：
    - 浮动 `MaterialCardView`，圆角 14dp、elevation 16dp
    - 表面色 `?attr/colorSurface`、文字 `colorOnSurface`、次级文字 `colorOnSurfaceVariant`、
      行背景 `colorSurfaceVariant`（全部走 Material3 DayNight 自适应 → 深浅色跟随主题）
    - 分组头/标题强调色 `brand_primary`（白天 `#176B51`，夜间 `#5EE6B0`）
    - 行点击水波纹 `colorControlHighlight`，圆角行背景

### 修改文件
- **`app/src/main/java/top/xxssxx/admin/ui/AssistantFragment.kt`**（仅改视觉，业务逻辑不动）
  1. `showAgentSelector()` → `MaterialSelectionDialog.single()`，保留分组（`—— 分组 ——` 头）
  2. `showHermesApproval()` → `MaterialSelectionDialog.single()`，description 走 `message` 参数；
     原 `setOnCancelListener` 语义用 `onDismiss` 保留（关闭后允许再次弹同一审批）
  3. 备用模型链多选 → `MaterialSelectionDialog.multi()`，保持勾选顺序，清空/完成逻辑原样
- 未改动：`showConversationSettings()` 本身（已是自定义表单，非系统列表），不涉业务逻辑

## 三、截图对比说明
本机未启动模拟器，无法实机截图。按渲染逻辑说明前后差异：

| 弹窗 | 改造前 | 改造后 |
|---|---|---|
| 智能体选择器 | 系统灰底 ListView、无圆角、主题跟随系统 | 圆角 14dp 浮起卡片、brand_primary 分组头、surfaceVariant 圆角行、深浅色自适应 |
| Hermes 审批 | 系统列表 + 描述文字 | 描述文字 + 圆角卡片选项行，与智能体选择器同风格 |
| 备用模型多选 | 系统多选列表 | CheckBox 圆角行 + 清空/完成按钮，同配色 |

## 四、改动清单（汇总）
- 新增：`app/.../ui/MaterialSelectionDialog.kt`
- 修改：`app/.../ui/AssistantFragment.kt`（3 处弹窗改用统一组件）
- 构建产物：`app-debug.apk`

## 五、共存说明
与 cluster-assistant-hub 已完成的智能体选择器共存——本任务只把其弹出的系统 AlertDialog 列表换成统一 Material 卡片风格，未改选择逻辑、未动 API 调用。
