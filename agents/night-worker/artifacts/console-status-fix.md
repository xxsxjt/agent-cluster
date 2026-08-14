# 控制台状态标志语义修复（console-status-fix）

日期：2026-08-08 10:30
执行者：night-worker（deepseek-v4-flash）

## 需求（用户 2026-08-08）
控制台树节点状态标志语义与用户预期对齐：
- **在跑（busy）= 蓝色闪动**
- **已完成 = 绿色**
- **空闲（无活动）= 灰色**
- **失败 = 红色**
- **休眠 = 暗灰**

## 实现状态
代码（app.js / server.js / style.css）在本轮已完整就位，工作区含全部修复，web 服务（PID 27356，10:18 启动晚于 server.js 修改 02:36）已加载新代码。逐项核对：

### 1. 树节点状态优先级重构（app.js `st` computed + style.css）
优先级：**在跑蓝闪 > 疑似在跑蓝闪 > 最近失败红 > 最近完成绿 > 休眠暗灰 > 空闲灰**
- busy → `d-running`（蓝闪 `--run:#58a6ff` + pulse 动画）statusText「正在干活：任务名」
- 最近失败（10 分钟内，latestFailMs>latestDoneMs）→ `d-failed`（红 `--bad:#f85149`）「失败：任务名」
- 最近完成（10 分钟内）→ `d-done`（绿 `--ok:#3fb950`）「已完成：任务名」
- 休眠 → `d-sleeping`（暗灰 `--fg3` + opacity .55）「休眠」
- 空闲 → 新 class `d-idle`（灰 `--fg3`）「空闲」
- 超时回落：完成/失败仅最近 10 分钟标色，超时回落空闲/休眠，避免永久绿/红误导

原问题 #1 已消除：`d-active` 从 app.js 移除（改发 `d-idle`），CSS `.d-active` 兜底灰。

### 2. busy 数据兜底（server.js agentActivity）
进程状态探测失效（管家崩/权限/PID 缺失）导致 running 被误判 stale/pending 时：
- 用「任务日志最近仍在写入（<90s）」判定 `busyUnknown=true` + `runningFallback=任务名`
- 前端渲染为 `d-running` 蓝闪「疑似在跑：任务名（数据不完整）」——宁可信在跑也不显示灰空闲

### 3. icon 调整（语义一致）
- busy ⚡（蓝闪语义）、失败 ✖、完成 ✓、空闲 🤖、休眠 💤、组 📂/📁

## 验证（浏览器真实 DOM 实测，Ctrl+F5 后）
web: http://127.0.0.1:8787/（tab 1010064224）

### 真实任务验证（live 状态）
| 节点 | class | statusText | 图标 | 判定 |
|---|---|---|---|---|
| 框架开发（night-worker，本任务在跑）| `d-running` | 正在干活：console-status-fix | ⚡ | **蓝闪 ✓** |
| 网络安全智能体 | `d-running` | 正在干活：ppsrc-startup | ⚡ | **蓝闪 ✓** |
| 服务器运维智能体 | `d-done` | 已完成：org-watchdog | ✓ | **绿 ✓** |
| 虚无圣灵 / 产品经理 | `d-idle` | 空闲 | 🤖 | **灰 ✓** |
| 其余智能体 | `d-sleeping` | 休眠 | 💤 | **暗灰 ✓** |

### 兜底路径实测
页面初载时（busy 数据尚未就绪）框架开发显示 `d-running`「疑似在跑：console-status-fix（数据不完整）」——**busy 兜底蓝闪生效，未误显示灰空闲** ✓

### 构造测试（绿/红，验证后已清理）
- `zzs-green`（agent: copywriting + .DONE）→ 公众号文案智能体 `d-done`「已完成：zzs-green」**绿 ✓**
- `zzs-red`（agent: novel + .FAILED）→ 番茄小说智能体 `d-failed`「失败：zzs-red」**红 ✓**
- 清理 zzs-* 文件后：番茄小说/公众号文案回落到 `d-sleeping`，恢复常态 ✓

## 改动文件
- `web/app.js` — `st` computed 状态归一化（busy/busyUnknown/failed/done/sleeping/idle 优先级 + 图标）
- `web/server.js` — agentActivity 计算 busyUnknown/runningFallback/latestDoneMs/latestFailMs/failedCount 等
- `web/style.css` — `d-running` 蓝闪、`d-done` 绿、`d-idle` 灰、`d-failed` 红、`d-sleeping` 暗灰
- `web/index.html` — app.js?v=20260808-status 版本戳

## 备注
- 测试任务 zzs-green/zzs-red 已完成清理（.md/.DONE/.FAILED/log 全部删除），不污染生产
- 完成约定：失败任务的完成标记是 `.DONE` 文件内容含 `.FAILED`（非 `.FAILED` 单独文件）
