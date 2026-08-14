# web/ — v5 组织总览（Vue 前端）

组织树 + 各智能体最新输出 + 管家小结，三栏一屏看全。桌面三栏，手机单栏 + 底部 tab。

数据全部来自本地文件，**只读**：`org.json` / `agents/*` / `inbox/` / `logs/`。
零第三方依赖（只用 Node 内置模块），Vue 也已放在 `vendor/`，断网可用。

## 启动

```bash
# 本机（默认 127.0.0.1:8787）
node web/server.js
# 或
web\start-web.cmd            # Windows
bash web/start-web.sh        # Git Bash / WSL

# 换端口
node web/server.js --port 9000

# 手机看（同一个 WiFi）：监听全网卡 + token
node web/server.js --host 0.0.0.0 --token 自己设一串
```

启动后终端会打印可访问的地址，`--host 0.0.0.0` 时连局域网 IP 一起打印，手机直接开。

> ⚠️ `--host 0.0.0.0` 且不带 `--token` 时，同网段任何设备都能读到 org 目录里的内容
> （含各智能体日志原文）。所以只在可信网络用，或者带上 `--token`。
> token 可以放 URL 里（`/?token=xxx`），第一次访问后会存 cookie，后面不用再带。

## 界面

| 区域 | 内容 |
| --- | --- |
| 左 | 组织树，按 `org.json` 递归渲染。组可折叠（折叠状态记在 localStorage）。状态点：绿=正在干活、蓝=active、灰=sleeping |
| 中 | 选中智能体的**最新输出**。默认跟它最近有日志的那个任务，多任务时可手动切。另有「任务 / 文件 / 身份」三个子页 |
| 右 | 管家小结：统计卡 + 状态总览 + 活动任务 + 收件箱 + `butler.log` 尾部 |

顶栏可切「实时 / 暂停」和刷新间隔（2/5/10/30 秒）。标签页切到后台时自动停轮询，切回来立刻拉一次。
`⤓` 是新输出自动滚到底的开关。

中栏的输出是解析 `logs/<任务名>.log` 得来的。这些日志是 `claude -p --output-format stream-json`
的 JSONL，按类型渲染成：回复 / 思考 / 工具 / 结果 / 系统 / 结束。
其中 `thinking_tokens` 这类纯遥测行会被滤掉（顶部会写「已滤 N 条遥测」），否则真正的输出会被淹掉。

## 任务归属怎么认的

日志文件按**任务名**存（`logs/<task>.log`），不带智能体信息，所以按两个来源反查：

1. `butler.log` 里的 `🚀 派发 [任务] → 智能体` 行
2. `inbox/<任务>.md` 头部的 `agent:` / `group:` 声明（`group:` 取该组 `mainAgent`）

任务状态：`running`（有 `.PID` 且进程活着）/ `done` / `failed`（`.DONE` 里带 `.FAILED`）/
`stale`（有 PID 但进程没了）/ `pending`。

## 接口

全部 GET、只读：

| 路径 | 说明 |
| --- | --- |
| `/api/state` | 组织树 + 任务列表 + 各智能体活动 + 管家小结（本地算，无副作用） |
| `/api/agent?id=&task=&events=` | 单智能体详情 + 最新输出 |
| `/api/summary` | 同上小结；加 `?real=1` 则真跑 `node butler.js --summary`（30 秒缓存） |
| `/api/butlerlog?lines=200` | `butler.log` 尾部 |
| `/api/file?p=<org 内相对路径>` | 读单个文本文件，限制在 org/ 内 |

右栏「跑真实 --summary」按钮走的是 `?real=1`。默认不走它，因为 `butler.js --summary`
会往 `butler.log` 追加日志，属于副作用，只在手动点的时候才触发。

大日志不会整体读进内存：只读尾部 512KB，会话元信息（model/cwd）另外从文件头 64KB 取一次并缓存。

## 自检

```bash
node web/selftest.js
```

不需要浏览器，会做四件事：用 Vue 编译器编译两段模板、检查 class 与 CSS 是否对得上、
扫 app.js 里有没有调用未定义的函数、起一个临时服务把所有接口打一遍（含目录穿越拦截）。
全通过退出码 0。

## 文件

```
web/
├── index.html      页面 + Vue 模板（含递归树节点组件）
├── app.js          Vue 3 应用（Options API，无构建步骤）
├── style.css       深色主题，@media 900px 切手机布局
├── server.js       零依赖只读后端
├── selftest.js     自检脚本
├── start-web.cmd   Windows 启动脚本
├── start-web.sh    Bash 启动脚本
└── vendor/
    └── vue.global.prod.js   Vue 3.5.40（含编译器，离线可用；缺失时页面回退 CDN）
```
