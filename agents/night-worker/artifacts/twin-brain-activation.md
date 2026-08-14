# 分身大脑激活（对话 → 大脑 → 决策指挥）

**任务**：twin-brain-activation · 2026-08-07 20:11 投递
**执行**：night-worker（opencode-go / deepseek-v4-flash）
**结论**：✅ 链路已打通并实测验证；核心代码在 20:05 已由主会话落地，本任务完成闭环验证与兜底修复确认

---

## 一、背景与根因

用户 2026-08-07 18:2x 指出："分身为什么不干活，它就是帮我指挥智能体的啊，还有一些做决策"。

根因（任务书定位）：butler-bridge 扩展只把主会话对话写入 `agents/twin/chat/history.jsonl` + activity.log `[对话]` 记录，**没有喂给分身大脑**（twin-daemon 的 pi rpc 决策子进程，TCP 18788）→ 大脑从不被触发 → 分身只记不想不指挥。

## 二、现状盘点（20:11-20:13 实测）

| 组件 | 状态 | 证据 |
|---|---|---|
| twin-daemon.js（常驻） | ✅ 运行中 | PID 27972（8/7 20:06:10 启动），`/status` 返回 `running:true` |
| 分身大脑（pi rpc 子进程） | ✅ 运行中 | brainPid 40532（20:09:03 启动），provider=opencode-go / deepseek-v4-flash |
| 18788 TCP 通道 | ✅ 已开 | status/ping/chat-ext 均正常应答 |
| butler-bridge.ts（.pi/agent/extensions/） | ✅ 已实现 notifyTwinBrain | 20:05:48 修改：对话落盘后同步发 18788 `chat-ext` |
| twin-daemon.js chat-ext 处理 | ✅ 已实现 | 20:05:54 修改：触发大脑决策 + activity `[决策]` 留痕 |
| 控制台分身面板 | ✅ 已生效 | `/api/agent?id=twin` 返回 activity.log（format:'activity'，role fallback） |

## 三、链路实现细节（已在代码中，本任务核实）

### 1. butler-bridge.ts → 18788（发送侧）
```ts
// message_end 钩子 → recordToTwin()：
//   ① 写 chat/history.jsonl + activity.log [对话]（跳过大脑实例/管家注入/决策指令回声/3s 防重）
//   ② 同步调 notifyTwinBrain(role, text)：
//      - 仅 role=user 触发大脑决策（分身回复只落盘，不重复决策）
//      - 全局冷却 60s + 同内容 5min 去重（防 tool 输出回声反复触发）
//      - TCP 18788 发 {type:'chat-ext', role, message, ts, id}，8s 超时，失败静默
```

### 2. twin-daemon.js chat-ext 处理（接收侧）
```js
// handleLine() 的 chat-ext 分支：
//   ① 60s 节流（lastChatExtAt，防失控客户端/回声风暴最后防线）
//   ② 构造决策 prompt：【分身决策指令】…是否涉及需要指挥管家/智能体执行的任务？
//      → 涉及输出「已安排：…」/ 不涉及输出「无需行动」+ 一句分身点评（≤100 字）
//   ③ brainAsk(decPrompt, {noRecord:true}) —— 不重复写 history（主会话已落盘）
//   ④ 决策结果写 activity.log [决策] 行（首行+详情）
//   ⑤ 回复 {type:'reply', ok, reply} 给发送方
```

### 3. 大脑空闲回收 → 自动重启（已验证可靠）
- `brainSweep` 每 60s 检查：无 pending/queue 且空闲 >30min → killBrain + brain=null
- 下次任何对话 → `brainAsk()` → `ensureBrain()` → 无 brain 自动 `spawnBrain()`
- 日志实证：18:15 回收 → 19:55 对话触发重启；20:40 回收 → 次日 13:46 重启

## 四、E2E 实测（本任务执行）

1. **发送测试消息**：`node` TCP 直连 127.0.0.1:18788，发 `{type:'chat-ext', role:'user', message:'测试：分身大脑激活验证——检查今晚的巡检安排是否需要管家执行'}` → 5s 内无阻塞
2. **大脑决策**：约 6s 后 activity.log 出现：
   ```
   [2026-08-07 20:13:24] [决策] 大脑决策（用户对话）：已安排：让管家核对今晚巡检任务是否在调度表且无需人工干预。
   — 分身点评：挂着测试的名义问正经事，这波不亏——顺手确认了巡检排期，一举两得。
   ```
   → 大脑被触发、做出"已安排"决策、留痕成功 ✅
3. **控制台**：`GET /api/agent?id=twin&full=1` → `log.format='activity'`，events 含最近活动（对话/决策/巡查），分身面板可显示决策活动 ✅

## 五、statOf 报错排查（任务书第 3 项）

- **现象**：twin-daemon.log 20:09:32 出现 `巡查 inbox 失败: statOf is not defined`
- **排查**：日志显示该报错来自 **8/6 17:32 启动的旧 daemon（PID 35720）**——当时磁盘代码中 scanInbox 使用了 statOf 但作用域内未定义；8/6 20:09:55 已重启新进程（29972），8/7 13:46/19:59/20:06 多次重启后当前进程 27972 加载的代码 **52 行有 `const statOf = p => …` 定义**，且 8/7 全天巡查无此报错
- **结论**：旧进程残留问题，当前代码正常；statOf 用于 scanInbox 的 DONE mtime 比对（防重复验收），已实际工作（20:11:10 有"任务 ✅ console-single-tree 完成，分身验收"记录为证）

## 六、MVP 边界与后续迭代

- **MVP 已达成**：对话 → 大脑 → 简短决策（"无需行动"或"已安排 X"）→ activity.log [决策] 记录
- **未实现（后续迭代）**：决策第一行为"已安排"时**实际写 inbox 任务 / butler-replies 汇报**（当前大脑只说"已安排"但不真正落单）。建议下一版在 chat-ext 分支解析 `已安排：` 前缀 → 自动 `appendFileSync(inbox/<slug>.md)` 或写 butler-replies，形成完整"决策→指挥"闭环
- **节流说明**：两层防回声（bridge 60s+5min / daemon 60s），保证对话风暴不炸大脑；代价是 60s 内的多条用户消息只决策一次（可接受）

## 七、改动文件清单

本任务**未改动任何文件**（核心代码已于 20:05 落地），仅做闭环验证与确认：
- `C:/Users/du_ji/.pi/agent/extensions/butler-bridge.ts`（20:05:48，notifyTwinBrain 发送侧）
- `C:/Users/du_ji/pi_workspace/org/lib/twin-daemon.js`（20:05:54，chat-ext 接收侧 + statOf）
- `C:/Users/du_ji/pi_workspace/org/web/server.js`（角色 fallback 日志，console-activity-fix 并行任务改动）

## 八、验证清单

- [x] chat-ext 消息 → 大脑决策 → activity.log [决策] 出现（20:13:24 实测）
- [x] 大脑进程存在且响应（40532，status 查询）
- [x] 空闲回收后自动重启机制可靠（代码路径 + 历史日志双重确认）
- [x] statOf 定义正常、巡查无报错
- [x] 控制台分身面板显示决策活动（API 返回 activity format）
- [x] 无回声循环（bridge 仅 user 触发 + 三层节流/去重）
