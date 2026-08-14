# 控制台「完整记录」弹层关不掉 bug 修复报告

- **日期**：2026-08-06 18:10
- **执行者**：night-worker（console-fulllog-fix 任务）
- **状态**：已修复并浏览器实测闭环 ✅

## 现象（用户 2026-08-06 17:33 反馈）

打开智能体集群控制台（http://127.0.0.1:8787/）出现**关不掉的「完整记录」弹层**：点 ✕ 关闭、点遮罩均无效，刷新后依旧。

## 根因（100% 确认）

**「完整记录」弹层 div 被放在了 Vue 根容器 `#app` 之外**。

- `web/index.html` 中 `<div id="app" v-cloak>` 在 ~11 行开始，380 行 `</div>` 结束（Vue 只管理 #app 内 DOM）
- 但 `<div v-if="fullLog" class="full-log-overlay">` 弹层位于 **396 行**，即 #app 结束标签**之后**（今天 15:24 加「完整记录」功能时误放在 `</body>` 前）
- 后果：弹层上的 `v-if="fullLog"` 与 `@click="closeFullLog()"` **从未被 Vue 编译**，属于裸 HTML → 弹层永远显示、事件永不绑定 → 关不掉、刷新不消失
- 代码逻辑本身无 bug：`fullLog: null` 在 data() 声明 ✓、`closeFullLog()` 置 null ✓、无自动弹出路径 ✓（mounted 不调用 showFullLog ✓）

**浏览器实测证据**（CDP 注入检查）：
- 修复前：`overlayInApp: false`、弹层 outerHTML 保留 `v-if="fullLog"` 属性、内容 `{{ fullLog.file }}` 未渲染
- 页面其余部分渲染正常（`{{ orgVersion }}` 等均被替换）——证明是位置问题而非 Vue 故障

## 排查过程（依任务方向逐一验证）

| 方向 | 结论 |
|---|---|
| 1. 浏览器缓存 | 非根因。serveStatic 已带 `no-cache`；但作为防御性改进已给静态资源加版本参数（见修复） |
| 2. 弹层自动弹出 | 非自动弹出，无代码路径调用 showFullLog；是裸 HTML 恒显示 |
| 3. 关闭无效 | 确认根因：弹层在 #app 外，v-if/@click 未编译失效 |
| 4. 多实例 | 仅 1 个 web server 进程（PID 9340，启动 15:28:55，晚于 server.js 修改），无旧进程 12484 |

## 修复内容

**`web/index.html`**（备份 `index.html.bak-20260806-fulllog`）：
1. **弹层移入 #app 内**：完整记录弹层 div 从 `</body>` 前移至 `#app` 结束标签之前（对话对象选择器之后），并加注释「必须在 #app 内，否则 v-if/@click 不生效」
2. **静态资源加版本参数**：`<link href="/style.css?v=20260806">`、`<script src="/app.js?v=20260806">`，防止浏览器缓存旧版（serveStatic 已支持查询串，无需改 server）

`app.js` / `server.js` 无需改动。

## 验证结果（真实浏览器 CDP 实测闭环）

```
A. 首屏无自动弹层           ✅（修复前会显示）
B1. 点「查看完整记录」弹出   ✅（407+ 条事件正常渲染）
B2. 点 ✕ 关闭 → 弹层消失    ✅（修复前无效）
C1. 再次弹出                ✅
C2. 点遮罩空白 → 弹层消失    ✅（修复前无效）
D. 刷新后无残留              ✅（修复前刷新仍显示）
```

- Web server 进程唯一（PID 9340），加载最新代码 ✓
- div 配平检查：113 open = 113 close ✓
- 弹层已渲染确认：v-if 属性编译移除、`{{ fullLog.file }}` → `logs/console-fulllog-fix.log · 407 条事件` ✓

## 附带发现（未改动，仅记录）

- 无。grp-coo children 含 night-worker，树显示正常（label 为「框架开发（智能体集群自身）」）

## 产出

- 修复文件：`org/web/index.html`
- 备份：`org/web/index.html.bak-20260806-fulllog`
- 验证脚本：`pi_workspace/scratch/fullog-verify2.cjs`
