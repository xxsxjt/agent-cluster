# app-notify-detail-fix — 通知/告警中心体验修复（补验完善）

- 任务：app-notify-detail-fix-improve（night-worker / workspace 重派）
- 时间：2026-08-11 17:0x
- 源任务失败原因：**`.FAILED: 全部渠道不可用`** —— 当时所有模型渠道不可用（渠道问题，非代码问题），任务未执行完成。本次 HK 可达、渠道恢复，重跑并补足验证证据。

## 用户反馈背景（2026-08-11 15:0x 两张截图）
1. 通知栏**太杂**：checkpoint 进度快照（每 30 分钟）全推用户——技术细节（progress.jsonl 路径/补验证据）看不懂；点击不跳转
2. 告警详情页**不明确**：标题超长看不出任务/智能体；正文全技术术语——需要"哪个任务/哪个智能体/人话摘要"

## 改动清单

### 一、后端（本机 org 框架）—— 通知分级 + 人话标题 + 深链数据
**1. checkpoint 进度快照不推用户通知（核心）**
- `butler.js` `notifyTaskEvent()`：新增 `isProgressSnapshotTask()` 过滤 `checkpoint-` 前缀任务，**完成后跳过用户通知**（只写内部日志 `logs/<task>.progress.jsonl`）。
- 只推用户四类：任务**完成/失败/异常恢复失败/渠道限额**（与 notify-tier 机制一致，`config/cluster-notify.json` notifyDone 配置保留）。

**2. 通知标题人话格式**
- `scripts/hk-alert.js`：标题模板改为 `<任务名> · <智能体名> <状态>`（如 `cnb-sync-p0 · cnb-dev 已完成`），智能体名为可选项（无则回退）。
- `butler.js` `notifyTaskEvent(name, ok, doneText, agentId)`：从 active entry 取 agentId 传给 hk-alert，让人话标题显示智能体名。

**3. 深链数据字段**
- `scripts/hk-alert.js`：告警 payload 增加 `task`、`agent` 字段，供 APP 详情页一眼看出"哪个任务/哪个智能体"。

### 二、Android 管理端 APP（v1.7.18/52）
**4. 详情页明确化（新 AlertDetailSheet）**
- 新增 `ui/dialogs/AlertDetailSheet.kt` + `res/layout/sheet_alert_detail.xml`：
  - 状态（完成绿/失败红/进行中蓝/警告橙）+ 来源分类标签 + 时间
  - **任务名大标题**（一眼看出哪个任务）
  - **智能体名标签**（🤖 agent，一眼看出谁干的，无则隐藏）
  - 人话摘要正文
  - **技术细节折叠**（类型/出现次数/指纹，默认折叠，可展开/收起）

**5. 点击告警打开详情页**
- `ui/AlertsFragment.kt` `onAlertClick`：从只 markRead 改为 markRead + 打开 AlertDetailSheet。
- `ui/AlertEntry.kt`：新增 `task`、`agent` 字段解析（fromJson 读后端注入字段）。

**6. 通知点击深链跳详情**
- `notifications/AlertNotifier.kt`：通知 pendingIntent 带 `EXTRA_OPEN_ALERT` + fingerprint/title/message。
- `MainActivity.kt` `handleAlertDeepLink()`：收到通知点击 → 切告警 Tab → setFragmentResult 转发指纹。
- `ui/AlertsFragment.kt`：注册深链 listener，渲染后匹配 fingerprint 自动打开详情（未命中用通知内容兜底）。

## 验证证据

### 后端（本机逻辑）✅
- `node --check butler.js` / `node --check scripts/hk-alert.js` 语法通过。
- 单测 5 用例全过：checkpoint-* 任务完成 → 跳过通知；正常任务完成/失败 → 带 agent 人话标题；无 agent → 无 agent 参数。
- 标题格式实测：`cnb-sync-p0 · cnb-dev 已完成`、`app-fixes-b · xxsx-gateway 失败`、`普通任务 已完成`。

### Android 构建 ✅
- `:app:compileDebugKotlin` + `:app:assembleDebug` **BUILD SUCCESSFUL**（JDK 17）。
- APK `app-debug.apk` 6565734B。
- dex 标记确认：`AlertDetailSheet`（17 处）、`AlertsFragment`（48 处）已编入；strings `alerts_show_detail/hide_detail/detail_title` 已打包。
- aapt 资源确认：`layout/sheet_alert_detail`、`string/alerts_detail_title/show_detail` 均已编入 APK。

### 构建发布 ✅
- 版本 **v1.7.18（versionCode 52）**。
- 上传 HK `/opt/xxsx-api/releases/xxsx-admin.apk`，HK sha256 `f2d70ee…` == 本机一致（6565734B）。
- manifest `xxsx-admin.apk.json` → 52/1.7.18，旧文件已备份 `.bak-v1717`。
- **E2E 验证通过**（`verify-release-20260811-v1718.py`，临时移动 token）：
  - `GET /api/mobile/admin/app-release` → **200** `{available:true, version_code:52, version_name:"1.7.18", sha256:f2d70ee…, size_bytes:6565734}`
  - `/app-release/download` sha256 == 本机一致（6565734B）
  - 临时 token 已吊销，无残留
- release_notes 为 UTF-8 正确中文（终端乱码仅 SSH 显示问题，json 文件正确）。

## 遗留 / 备注
- **butler.js 改动需 butler 重启加载**（当前 butler PID 47300 运行旧代码，且有多活跃任务在跑，未贸然重启以免中断）。源码已就位，等下次自然重启或由主管家调度加载后生效。
- 模拟器禁用（用户明确），验证用代码审查 + 构建交付 + 发布 E2E。
- 通知点击深链：需用户端真机验收（本机无法模拟器）。
