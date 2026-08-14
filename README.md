# 智能体集群（Agent Cluster）— 智能体组织树框架

> 文件系统即架构。每个智能体一个目录，树结构在 org.json 中声明。

## 这是什么

一个**多智能体协作框架**：把一组专职智能体（管家 / 分身 / 学习进化官 / 运维…）组织成树状结构，通过 `inbox/` 任务投递 + 自动化路由 + 定时同步，实现「用户只给方向，集群自主分工、讨论、执行、汇报」的协作闭环。

- **文件系统即架构**——每个智能体一个目录，关系在 `org.json` 声明，改动即结构即源码
- **投递即调度**——`inbox/` 放一个 `.md`，butler 自动路由派发，完成后写 `.DONE`
- **跨机同步**——Git 通道（cnb 私有仓）+ 每 10min 自动 git-sync

## 隐私与安全声明

> 本仓库为**私有仓库**，仅存放**非核心、非隐私**的框架代码与知识文档。
> 以下内容**绝不提交**（`.gitignore` 强制规则）：

- 🔒 **密钥与凭据**：`secrets/`、`*.key`、`*.pem`、`*.clixml`、`config/secrets-index.json` 等
- 🔒 **会话与聊天记录**：`agents/*/sessions*/`、`sessions-archive*/`、`chat/`、微信 / 聊天 json 等
- 🔒 **运行态与日志**：`logs/`、`*.pid`、`sleep-mode.flag`、临时文件

即使私有，也坚持「**不白嫖、干净入库**」——只放值得留的内容，不含任何个人 / 账号敏感信息。

## 目录结构

```
org/
├── org.json              # 树结构元数据（单一真相源）
├── org.js                # CLI 工具
├── butler.js             # 管家（COO）主程序
├── lib/
│   ├── registry.js       # org.json 读写工具
│   └── spawn.js          # 子智能体启动工具（claude -p / pi rpc）
├── inbox/                # 任务投递目录（*.md → butler 自动路由）
├── discussions/          # 分身↔管家重大决策讨论稿（见下方互审协议）
├── logs/                 # 日志（butler.log + 各智能体任务日志）
├── agents/               # 每个智能体一个目录
│   ├── twin/             # 分身/最高智能体
│   │   ├── identity.json
│   │   ├── memory/       # 经验沉淀
│   │   └── tasks/        # 该智能体任务记录
│   ├── coo/              # 管家（COO）
│   └── server-admin/     # 服务器管理主智能体（示例）
└── groups/
    └── server-mgmt/      # 服务器管理组
```

## CLI 用法

```bash
# 查看嵌套树
node org.js tree

# 查看平铺列表
node org.js list

# 查看状态板
node org.js status

# 添加组（--parent 默认 coo）
node org.js add-group <id> <label> [--parent <id>] [--main-agent <id>]

# 添加智能体（--parent 默认 coo）
node org.js add-agent <id> <label> [--parent <id>] [--role <role>]
```

## 安装与启动（正规化）

一键安装（注册开机自启 + 启动管家）：

```bash
# Windows
powershell -ExecutionPolicy Bypass -File scripts\install.ps1

# Linux / macOS（systemd user 单元）
bash scripts/install.sh
```

服务管理（统一入口，跨平台）：

```bash
node scripts/bootstrap.js start      # 启动管家（后台）
node scripts/bootstrap.js stop       # 停止
node scripts/bootstrap.js restart    # 重启
node scripts/bootstrap.js status     # 状态（进程 + 自启）
node scripts/bootstrap.js install    # 注册自启（Win 任务计划 / Linux systemd）
node scripts/bootstrap.js uninstall  # 移除自启 + 停止

# 或快捷命令
bash xuwu.sh status
```

自启说明：Windows 注册任务计划 `pi-xuwu-boot-butler`（登录时启动，隐藏窗口）；Linux 注册 systemd user 单元。

## 管家（butler.js）用法

```bash
# 启动常驻管家（单实例锁，第二个进程自动退出）
node butler.js

# 单轮处理（测试用）
node butler.js --once

# 派生分管某组的分身（独立进程）
node butler.js --spawn grp-server-mgmt

# 输出当前各组摘要
node butler.js --summary
```

## 投递任务

在 `inbox/` 目录放一个 `.md` 文件，butler 自动路由并派发：

```markdown
# inbox/my-task.md

# 任务：检查服务器磁盘空间
检查所有挂载点的磁盘使用情况并报告。
```

可在头部声明显式路由：

```markdown
agent: server-admin     # 指定智能体 ID
# 或
group: grp-server-mgmt  # 指定组（自动找主智能体）
# 或
target: hk             # 投递到 HK 服务器执行（长任务/重活挂远程，本机只跑轻量轮询）
timeout: 3600          # 软超时（2026-08-11 起）：到期不杀，先投 checkpoint 询问；远端日志仍活跃则续期；无回应且停滞才判卡死（可选，默认 7200）
```

完成后 butler 写 `inbox/my-task.DONE`（内容为一行摘要）。

### 圆桌会议（type: meeting，2026-08-07 上线）

框架内开会：分身/用户想讨论议题时，投递一个会议任务，butler 并行召集参会智能体发言，收集后自动 LLM 汇总（分歧/共识/结论），纪要写入 `knowledge/meetings/`，结论可直接转执行任务：

```markdown
type: meeting
meeting: 服务器部署方案          # 议题（或 topic:）
participants: server-admin, night-worker   # 参会智能体（别名 attendees:）
initiator: twin               # 主持人（可选，默认 coo）
timeout: 1800                 # 会议总超时秒数（可选，默认 2700）
---
（正文 = 议题详情，给参会者看）
```

- 每个参会智能体收到 `inbox/meeting-<id>-<agent>.md` 发言任务（含其职责背景），完成后内容即为发言
- butler 自动并行派发；`knowledge/meetings/<议题slug>-<日期>.md` 含各方观点/分歧/共识/结论
- 纪要中「结论与建议执行任务」可直接照抄为 `inbox/` 新任务投递执行
- web 面板：`GET /api/meetings` 会议列表（纪要内容用 `/api/file?p=knowledge/meetings/xxx.md` 读）
- 手动重跑总结：`node lib/meeting.js <会议任务.md>`（发言已齐时幂等，自动补 LLM 总结）

### HK 远程投递（target: hk）

`target: hk` 任务由 `scripts/hk-task.js` 桥自动处理：scp 到 HK `/data/agent-cluster/inbox` → HK butler 捡起执行（hk-exec/pi）→ 轮询 `.DONE` 拉回本地。任务正文可含 ```` ```sh ```` 代码块；结果约定写入 HK `/data/agent-cluster/logs/<任务名>.result`，完成时自动拉回本地 `logs/<任务名>.hk.result`。手动模式：`node scripts/hk-task.js inbox/xxx.md --wait`。

### 决策委托分身（2026-08-08 上线）

任务执行中遇到**决策点**（注册测试账号 / 继续挖还是换面 / 任务拆解方式 / 方案 A/B / 预算内分配 / 非敏感数据使用）**不卡用户**，由分身（twin 大脑，user-twin 人格）代为决策。子智能体/管家只需写决策请求文件：

```markdown
# 决策请求：<简述>
- 源任务: <源任务名>
- 问题: <具体要决策的问题>
- 上下文: <决策背景，供分身理解>
- 选项: A. ... B. ...
```

写入 `inbox/decisions/<ts>-<任务名>.md` 即可。分身巡查自动捡起：

- **决策点** → 分身大脑代做决策 → 写 `inbox/decisions/<ts>-<任务名>.decision.md` → butler 读取后恢复任务（源任务可插嘴则直接 steer，否则重派 `<源>-resume` 注入决策继续）
- **红线**（花钱/付费、永久删除/破坏、法律风险/超授权、隐私出圈、真实资金操作）→ 分身**不代决策**，升级用户待确认
- **超时兜底**：分身 30 分钟无决策 → 记录「决策超时待用户」，不无限等

与 `discussions/`（重大决策互审讨论稿）的区别：**讨论稿=事前主动评审**，**决策委托=任务执行中被动请求**，后者由分身自动代答。


## 树结构规则

- **org.json nodes** 支持两种类型：`agent`（智能体）和 `group`（组）
- 组下可再分组（递归无上限）
- 智能体状态：`active`（激活）/ `sleeping`（休眠）/ `retired`（退役）
- `onlinePolicy`：`always`（永远在线）/ `on-demand`（有活即在）/ `lazy`（按需唤醒）
- `parent` 字段记录继承关系

## 重大决策互审协议（分身 ↔ 管家，2026-08-05 立）

**适用范围**：删数据 / 花钱 / 改框架结构 / 动生产服务——这四类属重大决策。

1. **先讨论稿，后执行**：管家遇到重大决策，先写 `discussions/<日期>-<主题>.md`
   （必含四节：背景 / 方案 / 风险 / 建议），分身批复后才执行。
2. **日常小事**：不必讨论稿，事后汇报即可（inbox 摘要 / butler.log / 面板）。
3. **紧急先斩后奏**（分身补充条款）：讨论稿超过 **4 小时**无批复且任务紧急时，
   管家可按建议方案执行，但必须在原稿件标注「**先斩后奏 + 原因**」，事后同步分身。
4. 分身主动发起的想法同样先落讨论稿，管家侧认同则直接实装，不认同则在同一稿件
   写明分歧留给用户（CEO）裁决。

## 单实例锁验证

```bash
# 第一个实例
node butler.js &
# 第二个实例（应立即退出，输出"管家(COO) 已在运行"）
node butler.js
```

## 生命周期

- 休眠智能体：identity.json 状态为 `sleeping`，工作空间保留
- 唤醒：butler 收到任务 → 路由到目标智能体 → 惰性启动进程 → 任务完成后自动回到 sleeping
- 管家分身：`butler.js --spawn <group-id>`，分身信息写入 org.json，独立 PID 锁

## 睡前模式（完成即关机）

- 前端头部「🌙 睡前模式」一键开关：全部任务终结后 120 秒自动关机，90 分钟卡死保护。
- 守护脚本：`shutdown-after-done.js`（web 端 arm 后 detached 运行，PID 存 `shutdown-guard.pid`）。
- API：`POST /api/shutdown/arm` / `POST /api/shutdown/disarm` / `GET /api/shutdown/status`。

## 模型定时路由（仅阿里渠道默认值）

- `lib/model-router.js`：22:00-08:00 → qwen3.8-max-preview·max（夜间 2 折+10 倍加量）；
  其他时间 → deepseek-v4-flash-0731·max。
- **默认非强制**：重大任务按智能判断选模型；任务文件头部可用
  `provider:` / `model:` / `thinking:` 显式覆盖（butler 解析后透传给 spawn）。
