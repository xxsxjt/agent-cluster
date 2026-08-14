# 控制台任务会话插嘴功能（console-interject）

**日期**：2026-08-07
**执行者**：night-worker
**状态**：✅ 完成（E2E 验证通过）

## 背景

用户要求"直接在对应的会话里面插嘴"（任务运行时干预 agent）。此前 butler spawn 的 pi 子进程在 3 秒发一次 prompt 后无持续交互通道，任务一旦开跑只能等它结束。

## 架构

子进程 stdin 句柄无法跨进程传递（Windows 匿名管道），因此采用 **共享表 + 文件队列** 通道：

```
┌────────────┐  POST /api/task/<name>/interject {message}   ┌────────────┐
│  前端控制台 │ ──────────────────────────────────────────▶ │ web server │
│  (插嘴输入框)│                                              └─────┬──────┘
└────────────┘                                                     │ ①查共享表 logs/active-tasks.json
                                                                    │   （任务在跑？可插嘴？）
                                                                    ▼
                                                           ②原子写 inbox/interject/<name>.json
                                                                    │
                                                                    ▼  fs.watch 秒级捡起
                                                            ┌──────────────┐
                                                            │   butler.js   │
                                                            │  sendRPC → pi 子进程 stdin
                                                            │  {type:'prompt', streamingBehavior:'steer'}
                                                            │  写 <name>.ack 回执
                                                            └──────────────┘
```

- **共享表** `logs/active-tasks.json`：butler 每次 active 表变化落盘（dispatch/收尾/每轮轮询兜底），字段 `{agentId, pid, startedAt, interjectable, channel}`。server.js 据此校验任务是否在跑、是否可插嘴。
- **请求队列** `inbox/interject/<name>.json`：server 端 tmp+rename 原子写，butler fs.watch + 2s 兜底轮询捡起，sendRPC 送入 pi 子进程，写 `<name>.ack` 回执后删请求。
- **仅 pi RPC 会话可插嘴**：claude -p / hermes 的 stdin 已 end、node 分身无 RPC 协议、HK 桥在远端——只有 spawnType=pi 的任务 `interjectable: true`。

## 改动文件

| 文件 | 改动 |
|---|---|
| `butler.js` | `persistActive()` 共享表落盘；`watchInterject()` + `handleInterjectFile()`；dispatch 的 entry 加 `interjectable`（pi 类型）；checkActive 收尾后刷新共享表；常驻模式启动 watch（仅主管家，分身不挂避免表互相覆盖） |
| `web/server.js` | `readActiveTable()`；listTasks 附加 `interjectable` 字段；`POST /api/task/<name>/interject`（查表→原子写队列→等 ack ≤5s→返回 delivered） |
| `web/index.html` | logbar 加插嘴输入框（任务 running && interjectable 时显示），Enter 发送 |
| `web/app.js` | `interjectTarget` computed（选中任务可插嘴判断）+ `sendInterject()` + 状态字段 |
| `web/style.css` | `.interject` 输入框/按钮/回执提示样式 |

## 验证（E2E 实测）

测试任务 `interject-e2e`（pi 类型：night-worker/deepseek-v4-flash）设计为 20s 循环检查 trigger 文件：

1. **共享表**：派发后 `logs/active-tasks.json` 出现 `interject-e2e → {agentId: night-worker, interjectable: true, channel: pi-rpc}` ✅
2. **API 可见**：`/api/state` 返回任务 `status: running, interjectable: true` ✅
3. **POST 插嘴**：`curl POST /api/task/interject-e2e/interject {"message":"trigger 文件已创建，内容为 HELLO-INTERJECT-E2E…"}` → **0.28s 返回 `{ok:true, delivered:true}`**（butler fs.watch 秒级捡起并确认送入）✅
4. **消息进入 agent 上下文**（决定性证据，logs/interject-e2e.log）：
   - `{"type":"queue_update","steering":["trigger 文件已创建，内容为 HELLO-INTERJECT-E2E…"],"followUp":[]}`
   - `{"id":"interject-1786086552921","type":"response","command":"prompt","success":true}`（steer 注入生效）
5. **影响行为**：agent 收到插嘴后立即检查 trigger → 内容 `HELLO-INTERJECT-E2E` 原样写入 `interject-e2e.result` → 写 .DONE 完成 ✅

## 使用方式

- **API**：`POST /api/task/<name>/interject` body `{"message":"..."}`；返回 `{ok, delivered, ts, message, agentId}`
- **前端**：选中运行中的 pi 任务 → 输出栏右上"插嘴"输入框 → Enter/按钮发送，旁侧显示 ✅/⚠ 回执
- **不支持的场景**：任务已结束（404）、非 pi 类型任务（409）、butler 未运行（404/502）

## 踩坑

1. **旧 web server 进程杀不掉**：`taskkill //PID //F` 返回 0 但进程存活（PID 9340），改用 PowerShell `Stop-Process -Force` 才杀掉——旧进程占着 8787 导致新 server 静默换到 8788，首次验证 API 打到了旧代码上（interjectable 缺失暴露了这个问题）。
2. **共享表必须防但管家重启**：butler 重启后 active 表为空、.PID 存活的遗留任务不可插嘴——写空表反而准确（stdin 句柄在旧进程里已死）。
3. **原子写防半截**：server 端 tmp+rename，否则 fs.watch 可能读到写了一半的 JSON 导致解析失败。
4. **分身不挂 watch**：--spawn 分身与主管家共用同一共享表文件会互相覆盖，插嘴通道只挂主管家。

## 后续可做

- 插嘴回执实时推给前端（当前靠 API 等 ack，5s 内同步返回，已够用）
- 支持对 claude 类型任务插嘴（需 claude -p 换成可流式交互的启动方式）
- HK 远端任务的插嘴（经 hk-task 桥转发到 HK butler 的 interject 队列）
