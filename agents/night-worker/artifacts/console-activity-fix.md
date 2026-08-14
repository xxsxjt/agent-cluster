# console-activity-fix — 控制台显示真实活动 + 学习进化官常驻

日期：2026-08-07 20:1x → 20:3x
执行：night-worker（twin-daemon 并行推进核心改动，night-worker 接力核查修复 + 端到端验证）

## 背景
控制台里分身（twin）/管家（coo）/学习进化官都显示"该智能体还没有任务日志"，用户误以为它们"死"了。
实际：twin-daemon（activity.log 持续写）和 butler（butler.log 持续写）都在跑，是控制台读错了日志源；
学习进化官则确实无常驻（patrol.js 是按需脚本）。

## 一、控制台显示修复

### web/server.js — roleFallbackLog（节点无任务日志时按角色 fallback）
- `twin` → 读 `agents/twin/activity.log`（lib/twin-log.js readActivity 解析 `[ts] [tag] text` 行：
  [巡查]/[对话]/[决策]/[验收] 等 tag；非标记行归 raw 一并展示），format='activity'，最近 N 条
- `coo` / `butler` → 读 `logs/butler.log` 尾部（派发/摘要/巡检），format='text'，最近 100 行
- `learning-officer` → 读 `agents/learning-officer/memory/entity-review-log.md` + `logs/learning-officer-patrol.log`；
  两者都不存在时显示"常驻巡查待启用（patrol.js 尚未产生活动记录，管家每小时会自动拉起）"
- agentDetail 中 `log = pick ? parseLogTail(...) : roleFallbackLog(id, maxEvents)`

### web/app.js — kindLabel 支持 activity 类型
```js
if (e.kind === 'activity') return e.tag || '活动';   // 分身活动流（activity.log）
```
"最新输出"面板走通用 events 渲染（read-only 文本），无需其他前端改动。

## 二、学习进化官常驻（patrol 定时）

### butler.js — 主管家每小时巡检定时器
- 仅主管家挂载（`if (!spawnGroupId)`），分身不重复跑
- `setTimeout(runPatrol, 10s)` 启动 10 秒后首轮 + `setInterval(runPatrol, 5min)` 每 5 分钟检查时间窗（实际每小时一次）
- runPatrol：spawn `agents/learning-officer/patrol.js`（cwd=org 根），stdout/stderr 落盘
  `logs/learning-officer-patrol.log` + 同步写 butler.log（🔬 前缀）
- patrol 自身产出 `memory/entity-review-log.md`（实体审核）+ `tasks/diary.md`（diary 抽查）

## 三、验证（全部通过）
1. **API 层**（web server 重启后，旧进程不加载新代码）：
   - `GET /api/agent?id=twin` → format=activity, 30 条（对话/决策/巡查 tag）
   - `GET /api/agent?id=coo` → format=text, butler.log 尾部（派发/摘要/巡检）
   - `GET /api/agent?id=learning-officer` → format=text, entity-review-log.md + patrol 日志
2. **浏览器 E2E**（真实 Edge 打开 http://127.0.0.1:8787/）：
   - 点击学习进化官 → 显示 entity-review-log.md 7.8KB text（2 条事件：patrol JSON + 实体审核节）
   - 点击分身 → 显示 activity.log 141.5KB activity（120 条真实活动流）
   - 点击管家 → 显示 butler.log 2.0MB text（派发/摘要记录）
3. **学习进化官常驻实测**：butler 重启（20:11:31, PID 46036）→ 20:11:40 首轮 patrol 自动运行（agentsScanned=19, 退出 code=0），`logs/learning-officer-patrol.log` 已生成

## 改动文件
- `web/server.js`（roleFallbackLog + agentDetail 接入）
- `web/app.js`（kindLabel activity 分支）
- `butler.js`（学习进化官每小时巡检定时器，主管家挂载）

## 踩坑
- **web server 不重启不生效**：改 server.js 后旧进程（PID 12584）继续返回旧逻辑（log=null）；
  需 Stop-Process 强杀再 `node server.js --port 8787` 重启（taskkill 杀不掉的问题按记忆用 PowerShell）
- **浏览器缓存旧前端**：控制台 tab 需刷新才加载新 app.js（`?v=20260806` 版本参数未变，靠强刷）
- selftest 4 个失败为 pre-existing 过期断言（model-router 8/6 改过路由、selftest 8/5 旧期望），与本次改动无关，未动

## 备注
- 分身活动流中除标记行外有大量 raw 行（主会话直写文本、但ler-bridge 转发等），readActivity 保留展示，信息更全
- 巡检定时器随但ler 重启重置 lastPatrolAt，重启后 10s 立即补跑一轮（幂等无害）
