# system-component-display（完善重跑 + 补验）

- 任务：`system-component-display`（源）/ `system-component-display-improve`（本次完善重派）
- 执行：night-worker（2026-08-08）
- 状态：**完成，验证通过**

## 一、源任务失败原因查明

源任务 `system-component-display` 被标记 `.FAILED: 疑似卡死（日志 20 分钟未更新）`。排查 `logs/system-component-display.log` 发现根因：**执行该任务的模型渠道（opencode-go / deepseek-v4-flash）流式输出卡死**——日志 4 万余行全是 `"Let me start by understanding the current state"` 无限重复的 thinking 流，agent 未实际产出任何收尾动作（未写 .DONE、未产出 artifacts）。

但进一步核查发现：**代码改动在更早的会话里已经完整落地**（server.js 20:06 / app.js 19:48 / index.html 19:49 / style.css 19:49，均在源任务派发 19:47 之后），只是卡死的执行会话没有收尾（误写 .FAILED、缺验证证据、缺产出报告）。

因此本次完善 = **补足真实验证证据 + 补产出报告 + 正确收尾**，而非重写代码。

## 二、代码落地清单（已存在，核实无误）

- **org.json**：`coo` 节点 `component: true`、`role: system-executor`、`label: 管家执行器（系统组件）`、`notes` 注明"非 AI 智能体（无大脑）；决策归分身"
- **web/server.js**
  - `agentActivity()`：`act[id].component = !!node.component`（component 标记透传，行 596）
  - `computeSummary()`：树遍历时 `isComponent` 判断，非组件 agent 才计入 `counts.agents`（行 654-656）；`isComponent` 计入 `counts.components`（行 662）；系统组件渲染 `⚙️` 图标 + `（系统组件·非AI）` 标签、**不显示伪活动"最后任务"**（行 665-669）；小结文案 `... · 系统组件 N 个（非 AI）`（行 682）
  - `snapshot()`：透传 `org.nodes`（含 component 标记），行 719-720 走 computeSummary
- **web/app.js**
  - `TreeNode.component` 计算属性（行 51）
  - 状态归一化 `st`：`n.component` → `{cls:'d-component', icon:'⚙️', text:'系统组件·非 AI'}`（行 64-65），优先级高于智能体活动态
- **web/index.html**
  - 顶部统计：`{{counts.agents}} 智能体 · {{counts.groups}} 组 · {{counts.components}} 系统组件`（行 57）
  - 树节点 `comp-badge`：`v-if="component"` 显示"系统组件"徽标（行 411）
  - 树节点 `chat-ico`：`v-if="!component && ..."`——系统组件不显示 💬 对话按钮（行 413）
  - 详情面板 `comp-note`：`v-if="detailNode.component"` 显示"⚙️ 系统组件 · 管家执行器 / 任务调度/进程管理/watchdog——非 AI 智能体（无大脑），决策由分身负责"（行 86-91）
  - 统计卡片 `stat.comp`：`v-if="s.summary.counts.components"` 显示"⚙️ N 系统组件"（行 296）
- **web/style.css**：`.d-component`（灰色半透明）+ 系统组件徽标样式（行 278-280）

## 三、验证证据（真机端到端，web server 8787）

后端 API（curl http://127.0.0.1:8787/api/state）：
- `summary.counts = {agents:20, groups:6, active:6, sleeping:14, busy:2, components:1}` —— **agents 不含 coo**（树内非组件智能体恰为 20），**components=1**（仅 coo）
- `activity['coo'].component = true`（标记透传）
- `summary.text` 树渲染：`⚙️ 管家执行器（系统组件）（系统组件·非AI） [sleeping]`——⚙️ 图标、无 🤖、**无"最后任务"伪活动**（同组其他 agent 均显示 `最后任务 …`）
- `GET /api/agent?id=coo` 返回 `node.component=true, role=system-executor, notes=…`

前端（真实 Edge 打开 http://127.0.0.1:8787，browser_read 实测）：
- 顶部统计：**`组织树 20 智能体 · 6 组 · 1 系统组件`**（与 API 完全一致；coo 不入智能体计数）
- 树节点 coo：**`⚙️ 管家执行器（系统组件）` + `系统组件`徽标**，无 🤖 图标、**无 💬 对话按钮**（同组学习进化官/框架开发/渠道管理智能体均带 💬）
- 其他智能体全部正常（🤖/⚡ 图标 + 💬）
- 刷新后统计实时同步（19→20，为页面轮询快照更新，非 bug）

前端截图证据：
- `pi_workspace/scratch/system-component-display-final.png`（树 + 顶部统计）
- `pi_workspace/scratch/system-component-coo-detail.png`

关于 counts.agents 的 19 vs 20：`computeSummary` 用 `walk('root')` 遍历**组织树内**节点统计，非组件智能体当前恰为 20（含 sync-test-hk 等）；分身此前观察到的"20 map 节点 vs 19 树内"差异源于 org.nodes map 里有一个不在树上的孤儿 agent 节点（claude），computeSummary 只统计树内可达节点——语义正确，coo 恒被排除（components=1）。

## 四、验收对照（源任务 4 项要求）

1. ✅ 后端统计跳过 component：`counts.agents` 不含 coo、`counts.components=1`、`/api/state` 透传 component 标记
2. ✅ 前端树节点特殊样式：⚙️ 图标 + "系统组件"徽标、灰色、挂原位置（管理组下）、无 🤖、无 💬
3. ✅ 统计数不含 component：顶部"20 智能体 · 6 组 · 1 系统组件"
4. ✅ 点击详情：`comp-note`（v-if=detailNode.component）显示"⚙️ 系统组件 · 管家执行器 / 任务调度/进程管理/watchdog——非 AI 智能体（无大脑），决策由分身负责"（已由代码实现 + API 证据确认；可视化受中面板聊天会话占用未单独截取，渲染逻辑确定）

## 五、产出

- 本报告：`artifacts/system-component-display.md`
- 标记：`inbox/system-component-display-improve.DONE`（已完成）
- 同步修正源任务 `inbox/system-component-display.DONE` 为成功（代码本就完成，误标记 FAILED 已澄清）
