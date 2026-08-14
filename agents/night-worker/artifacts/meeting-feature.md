# 框架开会（圆桌会议）功能 — meeting-feature

> 执行：night-worker（opencode-go / deepseek-v4-flash）· 2026-08-07
> 任务文件：`inbox/meeting-feature.md` · 状态：✅ 完成

## 一、目标回顾

用户理想架构：想法 → 分身决策 → 管家分配 → 子智能体执行 → 返回 → **讨论环节（开会）**。
现状无开会功能（聊天室频道互聊是另一套），本次实现框架内"议题圆桌会议"：
- 触发：对话说"开会讨论 XX"或任务文件 `type: meeting` 头部
- 流程：分身定议题 + 圈参会智能体 → butler 并行投发言任务 → 收集发言 → 汇总纪要（分歧/共识/结论）→ 结论可转执行任务
- 实现：`lib/meeting.js` + butler.js 集成 + 纪要落盘 `knowledge/meetings/`

## 二、设计

```
任务文件（type: meeting + meeting: 议题 + participants: 名单 + initiator: 主持人）
    │
    ▼ butler.js parseTask 识别 type=meeting
dispatchMeeting() spawn lib/meeting.js（独立协调进程，日志 logs/<name>.meeting.log）
    │
    ▼ meeting.js 主流程
1. 解析议题/参会者/主持人/超时
2. writeSpeechTasks()：为每个参会者投发言任务
   inbox/meeting-<id>-<agent>.md（含该智能体 identity.json 职责背景 + 议题 + 完成标记路径）
   → butler 常驻循环自动捡起，并行派发（各 agent 独立进程）
3. collectSpeeches()：轮询各 .DONE/.FAILED（默认 10s，总超时默认 45min，可头部 timeout: 覆盖）
4. summarizeWithLLM()：best-effort 调 pi rpc 子进程（lib/spawn.js），
   输出三段：分歧 / 共识 / 结论与建议执行任务（15min 超时，失败降级为"待主持人补充"）
5. writeMinutes()：纪要 → knowledge/meetings/<议题slug>-<日期>.md
   （议题/各方观点原文/分歧/共识/结论，结论含可勾选执行任务列表）
6. 主任务 .DONE = 一行摘要（含纪要路径）
```

**幂等性**：发言任务已有 .DONE 则跳过投递 → 会议重跑只补缺，不重复打扰参会者。

**头部字段**（与 butler parseTask 对齐）：`type: meeting` / `meeting:` 或 `topic:` / `participants:`（别名 `attendees:`、`meeting-participants:`）/ `initiator:`（别名 `host:`）/ `timeout:`。

## 三、实现清单

| 文件 | 改动 |
|---|---|
| `lib/meeting.js` | 新增（约 400 行）：解析/投递/收集/LLM 总结/纪要写入；`require.main` 保护 + `module.exports`（可复用）；SUMMARY_TIMEOUT 480→900s；participants 别名含 attendees |
| `butler.js` | `parseTask` 解析 `type:`（已有）；`dispatchMeeting()` 新增：spawn 独立协调进程、流式日志、PID 标记、异常时写 .FAILED；注释修正 participants 字段 |
| `knowledge/meetings/` | 纪要目录（新增） |
| `web/server.js` | 新增 `GET /api/meetings`：纪要列表（标题/时间/参会/状态/排序） |
| `README.md` | 新增「圆桌会议（type: meeting）」用法文档 |

## 四、测试会议实录（E2E 验证）

**发起**：`inbox/terraria-meeting-test.md`
```
type: meeting
meeting: 泰拉瑞亚服务器后续优化方向
participants: server-admin, night-worker
initiator: twin
timeout: 1800
```
**执行**（logs/meeting.log 实录）：
- 14:43:09 会议启动 → 并行投递 2 个发言任务
- 14:43:49 night-worker 发言完成（893 字）
- 14:47:39 server-admin 发言完成（1505 字，含 SSH 实测纠偏：世界已重建为专家+腐化、-worldevil 参数可用、4 人上限已生效）
- 14:47:39 调 LLM 总结 → **首次超时失败**（见踩坑）
- 15:35 修复后重跑总结：**40 秒生成 2404 字结构化总结** → 已并入纪要

**纪要产出**：`knowledge/meetings/泰拉瑞亚服务器后续优化方向-20260807-1443.md`
- 状态：2/2 位发言成功 · LLM 总结已生成
- 分歧 4 条（世界状态裁决以 server-admin 实测为准 / P0 侧重点 / 备份落点 / 监控范围）
- 共识 7 条（7777 公网裸奔是最大风险、备份不可接受、需探活自愈、变更纪律等）
- 结论 T1–T7 可执行任务（P0 超管后门闭环、密码强化+白名单、备份保留 14 天、OOM 加固 1536M、配置自洽、复验、权限细化），可直接照抄为 inbox 任务投递执行

**API 验证**：`GET /api/meetings` 返回会议列表 ✅（web 服务已重启生效，端口 8787）

## 五、踩坑记录（重要）

1. **pi rpc 子进程挂起根因**：测试时向 `pi --mode rpc` 发送 prompt 后调用 `child.stdin.end()`，pi 收到 EOF 后不再处理（agent_start 后无任何输出、8–15 分钟无响应）。**修复**：与 `lib/spawn.js` 一致——发完 prompt **不 end stdin**，保持管道打开。对照实验：不 end → 10–40 秒完成 ✅。
2. **总结超时**：第一次会议 480s 总结超时（deepseek-v4-flash + thinking max + 长发言），**SUMMARY_TIMEOUT 480→900s**；二次重跑撞上限流窗口 15min 无产出，空闲时重跑 40s 完成 → 机制正常，属瞬时池忙。
3. **meeting.js 无 require 保护**：被 require 时 main() 直接执行 → 加 `if (require.main === module)` + exports，函数可复用（本次重跑总结即用 exports 完成）。
4. **字段不一致**：butler.js 注释写 `attendees:`，meeting.js 解析 `participants:` → 统一支持双别名。

## 六、后续建议（未做，标注可后续）

- web 面板前端：会议列表 tab + 纪要渲染（后端 /api/meetings 已就绪，前端 app.js/index.html 未改）
- 对话触发："开会讨论 XX" → 分身自动生成会议任务文件（当前需手动投递任务文件）
- 结论自动转执行任务：纪要标注后由管家人工照抄投递（可加自动解析）

## 附：相关文件

- 会议协调器：`lib/meeting.js`
- 管家集成：`butler.js`（dispatchMeeting, ~201 行起）
- 纪要示例：`knowledge/meetings/泰拉瑞亚服务器后续优化方向-20260807-1443.md`
- 会议日志：`logs/meeting.log`、`logs/terraria-meeting-test.meeting.log`
- 发言任务留档：`inbox/meeting-泰拉瑞亚服务器后续优化方向-20260807-1443-*.{md,DONE}`
- API：`web/server.js` → `GET /api/meetings`
