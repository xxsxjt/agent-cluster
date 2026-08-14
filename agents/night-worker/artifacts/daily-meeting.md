# 每日例会机制 — daily-meeting

> 执行：night-worker（opencode-go / deepseek-v4-flash）· 2026-08-09
> 任务文件：`inbox/daily-meeting.md` · 状态：✅ 完成

## 一、目标回顾

用户要求把日报系统与开会系统合并为**每日例会**：
1. 每天固定时间所有智能体开会，轮流发言做了什么
2. 其他智能体可提问/交流
3. 分身和管理组再开小会（讨论评估）
4. 给用户汇报文档
5. 管理组自己安排后续任务派发给所有智能体

## 二、设计落地（四阶段）

```
每日 22:00 自动触发（config/daily-meeting.json 可调）
    │  butler.js 调度器写 inbox/daily-meeting-<date>.md（type: daily-meeting）
    ▼
dispatchDailyMeeting() spawn lib/daily-meeting.js（独立协调进程）
    │
    ├─ Phase 1 全员大会：召集所有智能体（grp-cloud + 管理组 + 业务域全部）
    │    每人按【今日做了什么 / 卡点风险 / 明日计划】汇报，butler 并行派发，支持提问轮次
    ├─ Phase 2 管理组小会：大会纪要给管理组（分身 twin + pm + 审核 reviewer + 渠道 channel-manager
    │    + 学习 learning-officer + 框架 night-worker）→ 评估（完成质量/优先级/资源）→ 决策明日任务清单
    ├─ Phase 3 汇报文档：knowledge/meetings/<date>-daily.md（用户可读）+ 同步 output/ 一份
    └─ Phase 4 自动派发：解析管理组任务行 → 写 inbox/nextday-<date>-*.md（agent 指定）→ 次日执行
```

## 三、实现清单

| 文件 | 改动 |
|---|---|
| `lib/daily-meeting.js` | 新增（约 430 行）：每日例会协调器。解析任务头部（date/participants/mgmt/full-only/timeout）；默认参会名单=全部业务智能体（叶子 agent，排除测试节点 sync-test-hk/claude/ds-bridge）；大会/小会发言任务投递+幂等；轮询收集；汇报文档生成（含大会汇报+管理组评估+派发清单）；任务行解析（支持 `- [ ] 标题（agent: X）\| 说明`、`@X`、全角/半角括号）；自动派发写 inbox |
| `butler.js` | 新增 `dispatchDailyMeeting()`（镜像 dispatchMeeting，spawn lib/daily-meeting.js 流式日志+PID）；`dispatch()` 识别 `type: daily-meeting`；主进程新增**每日例会调度器**（读 config/daily-meeting.json，默认 22:00，窗口内每分钟检查，已开过/在队列则跳过，**有任务则顺延**——active 非空时等待） |
| `config/daily-meeting.json` | 新增：`{enabled, hour:22, minute:0, windowMinutes:90, mgmtGroup:[twin,pm,reviewer,channel-manager,learning-officer,night-worker], participants:[]}` |
| `scripts/restart-butler-daily-meeting.ps1` | 新增：延迟重启脚本——轮询等待 daily-meeting + cnb-ctl-autostart 两任务 .DONE → kill 旧 butler(35404) → bootstrap start 重启（加载新代码，幂等+watchdog 同款） |

## 四、验证实录

**A. 单元验证**：
- `defaultAllParticipants()` → 20 人名单（twin/coo/server-admin/mc-dev/night-worker/security/novel/copywriting/xxsx-gateway/hermes/auto-bots/video-prod/workspace/channel-manager/learning-officer/takina/pm/reviewer/intel-gatherer/cnb-dev）
- `parseTaskLines()` → 正确解析全角/半角 `（agent: X）`、`@X`、`\|` 说明分隔（agent 归位正确，不再全落 coo）

**B. 全链路模拟**（预置发言文件代表智能体已通过 butler 汇报）：
```
node lib/daily-meeting.js inbox/daily-meeting-2026-08-09-sim.md
[02:49:48] 全员大会 3/3 位汇报 ✅（night-worker/pm/reviewer，幂等跳过）
[02:49:48] 管理组小会 2/2 位参与 ✅（pm/reviewer）
[02:49:48] 解析出 3 条明日任务，自动派发 ✅
            → nextday-...-每日例会调度落地 → night-worker
            → nextday-...-例会文档转-docx → pm
            → nextday-...-泰拉瑞亚备份保留14天 → server-admin
[02:49:48] 汇报文档 → knowledge/meetings/2026-08-09-sim-daily.md + output/ 同步 ✅
```
（模拟派发产物已清理，避免污染真实队列）

**C. 踩坑修复**：
1. `buildDailyPrompt/buildMgmtPrompt` 引用未传入的 `donePath` → 修正签名传参
2. **parseTask 头部解析 bug**：`full-only` 行 `continue` 在 `if` 外，导致每行提前 continue、`timeout:` 永不匹配 → 改为 `if(m){...;continue;}` 后 timeout 正确解析（3600→300）

## 五、部署生效

- 核心协调器 `lib/daily-meeting.js` 已可用（可手动 `node lib/daily-meeting.js <任务.md>` 触发）
- butler 新代码（调度器 + dispatchDailyMeeting）**需重启生效**：延迟重启脚本已后台启动，等待 active 任务（daily-meeting 本体 + cnb-ctl-autostart）完成后自动 kill 旧 butler(35404) → bootstrap 拉起。重启后每日 22:00 自动触发例会。
- ⚠️ 22:00 有任务冲突时自动顺延（active 非空则等待窗口期重试，天然实现"有任务则顺延"）；发言每人 2-3 条摘要级；派发遵循路由（服务器→server-admin、xxsx→xxsx-gateway、框架→night-worker 等，由管理组 task 行 agent: 指定）。

## 六、后续建议（未做，标注可后续）

- web 面板：`/api/meetings` 已会扫 knowledge/meetings/（daily 报告自动出现），前端可加"每日例会"tab 渲染
- 例会"提问/交流"轮次（发言→提问→补充）：当前全员大会为单轮发言+可互相留言；如需强轮次制可扩展 meeting.js 增加交互回执
- 汇报文档转 docx：按用户"重要文档转 docx"规范，用户要求后可由 pm 转（模拟派发已含该候选任务）

## 附：相关文件

- 协调器：`lib/daily-meeting.js`
- 管家集成：`butler.js`（dispatchDailyMeeting + 调度器）
- 配置：`config/daily-meeting.json`
- 重启：`scripts/restart-butler-daily-meeting.ps1`
- 日志：`logs/daily-meeting.log`
