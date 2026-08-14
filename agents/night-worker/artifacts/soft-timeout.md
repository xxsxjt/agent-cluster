# butler 强制超时 → 软超时（soft-timeout）· 2026-08-11

## 痛点 / 用户质问
用户 2026-08-11 14:2x 质问"你是不是加了什么奇怪的强制超时限制？"——根因：
- `butler.js` 在 HK/CNB 桥 dispatch 时传 `--timeout`（`task.timeout || 7200`），桥脚本 `scripts/hk-task.js` / `scripts/cnb-task.js` 在等待轮询到 deadline 时**直接写 `.FAILED: 任务超时` 强杀**。
- 用户 8/10 已要求"不要强制超时，要智能看护"，`task-watchdog`（静默询问）已落地，但 timeout 强杀仍在 → **冲突**。

## 方案：到期先问，不杀；真卡死才结束
核心原则：**软超时是"询问优先"**，与 task-watchdog 的"日志停滞询问"合并同一种询问机制。

| 场景 | 原行为（强杀） | 现行为（软超时） |
|---|---|---|
| timeout 到期但进程/远端仍活跃 | 直接 `.FAILED` | 投 checkpoint 询问（复用 task-watchdog 机制）→ 远端日志仍活跃 → **续期继续跑**（重新计时） |
| timeout 到期且远端停滞 | 直接 `.FAILED` | 投 checkpoint 询问 → 宽限 `10min` 内仍无活动 → 才判真卡死 `.FAILED` |
| 进程死（无 DONE） | 正常失败 | 保留硬保护（那是真死不是超时） |

## 实现
| 组件 | 说明 |
|---|---|
| `lib/soft-timeout.js`（新增） | `askSoftTimeout`（复用 watchdog `dispatchCheckpoint` 投询问，幂等）+ `isRemoteActive`（活跃窗口判定，默认最近 3min 内远端日志有输出=活跃） |
| `scripts/hk-task.js` | 等待循环改软超时：到期→投 checkpoint 询问（SOFT_AGENT=server-admin）→ ssh 查远端日志 mtime→活跃续期/宽限到(10min)判卡死 |
| `scripts/cnb-task.js` | 同上，SOFT_AGENT=cnb-dev |
| `butler.js` | parseTask 注释更新 timeout 语义（软超时）；dispatch 仍传 `--timeout`（现为软超时参数） |
| `README.md` | timeout 字段说明改为软超时 |

## 关键设计
- **询问复用**：`askSoftTimeout` 直接调 `task-watchdog.dispatchCheckpoint`，生成 `inbox/checkpoint-<task>-<stamp>-softtimeout.md`，由 butler 捡起轻量 flash 会话读源任务+日志回报。隐私路由（server-admin/cnb-dev 等走 deepseek 官方）继承 watchdog 配置。
- **活跃判定用窗口非超时点**：最初用"远端日志 mtime 晚于超时点"，但秒级 mtime 与 ms 级超时点边界脆弱（相等时 `>` 误判）→ 改为"最近 3min 内有输出=活跃"，鲁棒。
- **时序统一**：把"进入软超时（投询问）"从 sleep 前移到到期判定分支内（sleep 后），与续期判定同一时机，避免续期在询问前抢跑（实测 6 次续期 0 次询问的 bug）。
- **真卡死仍结束**：宽限 10min 到且远端日志停滞 → 仍 `.FAILED`（不能无限挂）——但先问再杀。

## 验证（全部通过）
### 单元（lib 直接测）
- `isRemoteActive`：活跃（mtime>窗口）true / 停滞（无日志）false / 早于窗口 false ✓
- `askSoftTimeout` 真实投递：生成 checkpoint-*.md、含询问指令、幂等（重复投 null）✓

### 模拟闭环（test/soft-timeout-loop-sim.js，复刻桥 while 逻辑）10/10
- **场景A**：超时后远端持续活跃 → 到点投询问 + 续期多次，**未 FAILED**（超时但进程活着→继续跑）✓
- **场景B**：超时后远端停滞 + 宽限到 → **判定卡死 FAILED**（真卡死仍结束）✓
- **场景C**：超时前完成 → 正常退出，无询问无续期无FAILED ✓
- **场景D**：超时后先停滞 → 投询问 → 模拟智能体回应（远端日志恢复活跃）→ 续期不杀，**任务继续**（对应任务第3项验证）✓

## 产出物
- 本机制由 night-worker 智能体执行任务 soft-timeout 落地。
- 测试脚本 `test/soft-timeout-loop-sim.js` 可复跑。

## 部署
- **无需重启 butler**：改动在桥脚本 + lib（每次任务 spawn 新进程读最新磁盘代码）；butler.js 仅注释改动。
- 新任务**默认不写 timeout 字段**（写则按软超时语义，不再强杀）。
