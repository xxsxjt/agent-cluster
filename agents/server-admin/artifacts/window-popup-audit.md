# 本机弹窗/退役组件自动化巡检（2026-08-13）

> 任务：hk-stable-popup-audit（server-admin）
> 结论：**巡检自动化已落地并增强**（凌晨修复轮已有初版，本次收敛范围/加白名单/加去重），不靠用户盯

## 巡检机制

- **执行体**：`org/scripts/window-popup-audit.ps1`（PowerShell 5.1 兼容，UTF-8 BOM 保留；输出 JSON 用 UTF8 无 BOM 编码防乱码）
- **调度**：计划任务 `pi-popup-audit`（TimeTrigger + Repetition PT30M = 每 30 分钟；动作带 `-WindowStyle Hidden`，无弹窗）
- **告警闭环**：异常 → 写 `logs/window-popup-alert.jsonl`（留痕）+ `inbox/window-popup-alert.md`（任务头 `agent: server-admin`）→ **butler 自动派发给 server-admin 处理**；无异常时清除告警文件防重复派活
- **去重**：`agents/server-admin/state/popup-audit-state.json` 记录告警 key，**同异常 4h 冷却**——持续异常不每 30 分钟刷屏派活（日志照记）

## 三查覆盖（任务书逐条）

### 1. 新计划任务 Hidden 合规
- 枚举 `^(org|pi)-` 前缀且 Enabled 的计划任务，检查 Actions：
  - powershell 缺 `-WindowStyle Hidden` → 违规
  - cmd.exe / node.exe / python.exe 直跑（需 wscript/vbs 隐藏包装）→ 违规
- 本次收敛：仅查自有任务（原来查全部根任务，会把第三方任务/用户任务误报）

### 2. 退役组件巡检（计划任务禁用但进程残留）
- 枚举 Disabled 的 org-/pi- 任务，按 Arguments 中的脚本路径特征（或任务名关键词 cnb-keepalive / pi_workspace\hub / omniroute）匹配运行中进程命令行
- 命中 → `retired-component-running` 告警（含 PID + 命令行）
- 配套公约：**组件退役三件套**（conventions 第 12 条）——禁用任务 + 杀残留进程（--loop/daemon 会继续跑）+ 引用标注

### 3. 弹窗检测
- **可见窗口控制台进程**：node/powershell/cmd/python 带可见主窗口（MainWindowHandle≠0）→ 本次增强：**仅报命令行含自动化特征**（pi_workspace / org\scripts / hub / keepalive / watchdog / .vbs）——用户自己开的终端不算弹窗，防误报
- **孤儿 conhost**：conhost 父进程已不存在（父链异常 spawn 的残留）→ `orphan-conhost` 告警

## 验证（本次实测）

| 项 | 结果 |
|---|---|
| 脚本手动执行 | `popup-audit done: 0 alert(s)`（当前无异常，无误报） |
| 检测能力 | 凌晨轮历史 jsonl 实测过三类告警（new-task-no-hidden / retired-component-running / orphan-conhost） |
| 去重逻辑 | 单测通过：同一告警第一次 True、第二次 False（4h 冷却） |
| 调度 | pi-popup-audit Ready，每 30 分钟 |
| 编码 | ps1 BOM 保留（PS5.1 中文解析正确）；jsonl/state 为 UTF-8 无 BOM |

## 历史修复背景（2026-08-13 凌晨轮，已在库）

- keepalive 残留类弹窗已修：org-cnb-keepalive 计划任务 Disabled + cnb-keepalive-test.js 残留进程清理
- 新组件上线规范（conventions）：计划任务一律 vbs 隐藏包装或 `-WindowStyle Hidden`；启动后查无空窗口/cmd 残留
- 管家单例铁律：butler.js 任何时候只允许一个进程

## 2026-08-13 修复：orphan-conhost 去重失效 → 每 30 分钟刷屏派活

- **现象**：巡检持续收到 orphan-conhost 告警（02:11/02:14/11:49/11:57 多个不同 PID），每次 PID 都不同。逐个核验全部是**瞬时孤儿**（检查时已消失，conhost 父进程退出后短暂残留，Windows 正常现象，非弹窗/非残留组件）。
- **根因**：去重 key 含 PID（`Type|Task|Pid|Name`）。orphan-conhost 每次 PID 都不同 → 4h 冷却永不命中 → 每 30 分钟巡检一捕获瞬时孤儿就写 inbox 派 server-admin，刷屏。
- **修复（最小改动）**：orphan-conhost 改用**全局 key**（`orphan-conhost||`，每 4h 最多一次）；其余类型保留 PID 精度（退役组件/可见窗口按具体进程去重）。验证：隔离测试两个不同 PID 的 orphan 只发一次（PASS），retired 同 PID 仍抑制。
- **结论**：orphan-conhost 基本是非actionable 的瞬时噪声，保留每 4h 一次可见性即可；真遇到持久性孤儿弹窗也能 4h 内被巡到。
- **待办确认**：若用户不希望 orphan-conhost 告警（彻底无价值），可删 ps1 中该检查段；本次先保留+节流。

## 后续建议

1. 新计划任务上线时巡检会在 30 分钟内自动发现 Hidden 违规并派活提醒（无需人盯）
2. 若未来出现"计划任务 Ready 但持续报 Hidden 违规"——说明组件上线流程没走 conventions，处理人补 vbs 包装后标注组件退役三件套
