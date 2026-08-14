# 控制台服务器端分组树视图（T3）— 完成报告

## 背景
VISION-v6 T3：本地控制台并排展示 HK 服务器端 org 分组树（双树）。前置 T1 已完成（HK /data/agent-cluster 部署 org 框架，web 8788 tailscale+token），T2 探索确认方案（本地 server.js 代理 HK /api/state）。

## 实现

### 1. 后端代理 `GET /api/remote/state`（web/server.js）
- 经 Tailscale 转发 HK org web `http://100.97.18.59:8788/api/state`，请求头带 `x-pi-token`
- **token 不入代码**：存于 `web/remote-config.json`（`{url, token, name}`，token 与 HK `/etc/org-agent-cluster/web.env` 一致，从 HK 经 SSH 读取落盘）；环境变量 `PI_REMOTE_URL/PI_REMOTE_TOKEN/PI_REMOTE_NAME` 可覆盖
- 安全设计：
  - **15s 缓存**（本地前端 5s 轮询不每次都打 HK）；`?force=1` 强制刷新
  - **8s 超时**（探索报告指出 Tailscale DERP 中继兜底延迟高，必须设超时保护）
  - 失败返回 `{ok:false, code, error}`：`NO_CFG`（未配置）/ `HTTP_xxx` / `TIMEOUT` / `NET` / `BAD_JSON`，不挂起、不污染主界面
  - 错误只置前端 `remoteError`，主界面正常
- `remote-config.json` 不在 server.js 静态白名单内（STATIC_OK 仅 index/app/style/favicon/vendor），不会被 HTTP 直接暴露

### 2. 前端双树（web/index.html + web/app.js + web/style.css）
- 左栏改为 `.dualtree` 双列并排：**本机** 树（原逻辑不动）+ **服务器集群** 树，各带 `.tb-title` 统计条；窄屏（≤900px）上下堆叠各限高 42vh
- 远端树**复用 `tree-node` 组件**（同一 Vue 组件），数据源 `remoteRoot/remoteNodes/remoteActivity` 直接吃远端快照同构字段；`chat-ids` 传空（远端不可对话，不显示 💬）
- 折叠状态独立（`remoteCollapsed`，localStorage 持久化）；选中状态 `remoteSel` 同样持久化
- 点击远端节点 → 中栏切换为**远端节点信息卡**（属性表 `remoteFlatNode` + 远端活动：任务数/正在干活/最近活动 + 🖥️ 来源徽标 + 「返回本机」按钮）；无远端日志/任务文件（数据来自快照而非本地文件）
- `tick()` 末尾并行 `loadRemote()`，失败仅置 `remoteError`，不影响主流程（error 横幅与 busyReq 互不干扰）

### 3. 配置文件
`web/remote-config.json`（不入代码、不入公开仓库；HK 部署目录 /data/agent-cluster 下不需要此文件）

## 验证（全部实测通过）

### 后端
| 用例 | 结果 |
|---|---|
| `GET /api/remote/state?force=1` | ✅ HTTP 200，14KB，0.19s；`orgRoot=/data/agent-cluster`，21 节点，root=CEO（你） |
| 二次请求（15s 窗口内） | ✅ `cached:true`，不打 HK |
| HK 不可达（改坏端口模拟） | ✅ `{ok:false, code:NET, error:'connect ECONNREFUSED…'}`，配置还原后立即恢复 ok:true |
| 本地 /api/state 等原有接口 | ✅ 不受影响 |

### 前端（真实 Edge 浏览器 DOM 实测，非仅 API）
- ✅ 双树并排：`本机 16 智能体 · 6 组` + `服务器集群 15 智能体 · 6 组`，root 均为 CEO（你）
- ✅ 远端树展开正常：虚无圣灵（分身）/ 管家域 8 / 管家（COO）/ 学习进化官 / 框架开发…（22 行节点）
- ✅ 点击远端「管家（COO）」→ 中栏显示信息卡：标题+chips（coo/sleeping/🖥️ 服务器集群）+ 14 项属性（id/type/label/role/status/onlinePolicy/parent/agentDir/spawnType/spawnScript/lastTaskAt/lastDoneAt…）+ 远端活动区 + 「返回本机」按钮
- ✅ 状态点/折叠/选中高亮与本地树同款组件表现一致

### 回归
- `node --check` server.js / app.js 通过；web/selftest.js **81 通过 / 5 失败**——5 个失败均为 model-routing「夜间=aliyun-tokenplan」过期断言（8/5 用户已改夜间渠道为 opencode-go，selftest 未同步更新），**与本次改动无关的既有失败**；web 相关（shutdown/chat/trace/api）全部 ✓

## 注意事项
1. **HK 端代码待 T6 同步**：本地 web 四件套（server.js / app.js / index.html / style.css）已改，HK /data/agent-cluster 仍是旧版。同步时**不要带 remote-config.json**；HK 端同步后需 `systemctl restart org-web` 生效（node 无热加载）。HK 端前端会显示「⚠ 远端未配置」属正常（HK 自身即远端，可忽略或后续隐藏）
2. `web/remote-config.json` 含 HK web token，**禁止提交公开仓库**（org 目录若建 git 需加 .gitignore）
3. 施工踩坑记录：server.js 加代理时 edit 误把 agentDetail 函数截断成两份（701 截断版+791 完整版），语法检查 `Unexpected end of input` 定位后已删除截断副本——**大段 edit 后必须 node --check**
4. 测试用 8899 端口已清理；8787 主控制台未动（如需线上生效重启即可）

## 产出物
- `web/server.js` — 代理模块（+68 行）与路由、文档注释
- `web/index.html` — 左栏双树 + 中栏远端节点信息卡
- `web/app.js` — remote 数据层（data/computed/methods/persist/tick 集成）
- `web/style.css` — .dualtree/.treebox/.tb-title + 窄屏堆叠
- `web/remote-config.json` — 远端配置（token，本地私有）
- 截图：`pi_workspace/scratch/console-remote-tree-1.png`（双树页面）

## 下一步（VISION-v6）
- T6 双端同步：以上四件套 → HK（排除 remote-config.json），重启 org-web，验证 HK 端
