# org-watchdog — 但管家 watchdog 守护（备用持续运行 + 自动修复重启）

- 日期：2026-08-08
- 归属：server-admin（运维职责，但管家守护）
- 状态：✅ 已落地并验证

## 结论速览

org 时代的管家守护**已完整继承 hub 旧方案**并改进为 v2。看护脚本、schtasks 定时、真实崩溃自动恢复、正常态不误重启——全部验证通过。当前但管家健康运行（单实例）。

## 一、交付物

### 1. watchdog 脚本：`org/scripts/org-watchdog.ps1`（v2）

基于 hub 旧 `watchdog.ps1` v3 经验重写，**弃用 CIM 命令行匹配作为主判定**（实测 schtasks S4U 计划任务环境下 `Get-CimInstance` 返回空，会每 10 分钟误判"未运行"空转重启——hub v3 注释早已警告此坑）。改为 **pidfile + tasklist 双确认**，与 bootstrap.js 的 `isAlive` 完全一致：

- 读 `butler.pid` → `tasklist /FI "PID eq <pid>"` 确认该 PID 是存活 `node.exe` → 存活即判定运行正常，**绝不重启**
- pidfile 缺失 / PID 不在 → 判定未运行 → 调 `bootstrap.js start` 重启
- pidfile 异常丢失但进程仍在时，用 CIM 尽力兜底一次（交互会话下可用），防误重启
- **防误杀**：仅通过 `bootstrap.js` 重启（自带 pidfile 幂等 + butler.js 单实例锁），绝不直接 taskkill，绝不匹配 pi 主进程
- **幂等**：管家/web 正常则静默；挂了才调 bootstrap（bootstrap 自身幂等，防重复拉起）
- 检测对象：
  - 主目标 `org/butler.js`（pidfile + tasklist + CIM 兜底）
  - 增强项 `web/server.js`（端口 8787 LISTENING 探测，比 pidfile 更可靠，防端口堆积）
- 重启日志：`org/logs/watchdog-restart-<ts>.log`（含原因/时间，stdout/err 分离）；总日志 `org/logs/watchdog.log`

### 2. schtasks 定时：`pi-org-watchdog`（已注册）

- 执行：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\du_ji\pi_workspace\org\scripts\org-watchdog.ps1"`
- 频率：每 10 分钟重复（起始 0:55:00，起始日 2026-08-08）
- 上次运行：2026-08-08 10:25:02，结果 **0（成功）**
- 下次运行：2026-08-08 10:35:00
- 开机自启：任务计划本身随系统启动触发（起始时间 + 每10分钟循环，重启后首个 0:55 后开始），watchdog 自身幂等，无需开机单独注册

## 二、验证记录（真实运行数据）

### ✅ 正常态不误重启（关键）
手动触发 watchdog 于健康态：退出码 0，`watchdog.log` **无任何新增行**（最后一条仍是 10:26:20 的历史重启记录）→ 正常运行时 watchdog 静默、不误重启。

### ✅ 真实崩溃自动恢复（今日实例）
`watchdog.log` 时间轴（乱码为 GBK 中文在终端显示问题，文件本身正常）：
- `02:05` butler + web 均重启（v1 误判期，见下）
- `02:37` 升级 v2（修掉 CIM 误判）
- `02:38:53` web 掉线 → v2 检测 → `bootstrap web start` 自动恢复
- `02:38 → 10:25` 约 8 小时**零日志** = 全程健康静默
- `10:25:04` butler 真实掉线 → 检测 → `10:26:20` 调 `bootstrap start` 自动拉起（restart log: `[集群 10:25:06] 管家已启动`）
- `10:28:01` butler 28992 常驻稳定至今，并正常派发任务（含本次 org-watchdog 任务）

### ✅ 单实例确认（无双开 / 无崩溃循环）
- `Get-CimInstance` 实测仅有 1 个 butler.js 进程：PID 28992，命令行精确匹配
- 与 `butler.pid`(28992)、`bootstrap.js status`(🟢 PID=28992) 三方一致
- web server.js PID 27356 监听 8787
- 10:28 起无后续重启日志 = 稳定无循环

### ⚠️ 已知说明
- `10:26` bootstrap 报告启动 PID=3480，但最终常驻为 `10:28:01` 的 28992。原因为 watchdog 的 `Start-Process -Wait` + bootstrap 的 detached spawn 在计划任务 S4U 环境下的 PID 传递差异，**不影响最终稳定单实例**，后续无 flapping。
- 02:05 前存在 v1 每 10 分钟空转重启的脏日志（CIM 误判），v2 已修复，可忽略。

## 三、schtasks 注册命令（备份）

```powershell
schtasks /Create /TN "pi-org-watchdog" /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:\Users\du_ji\pi_workspace\org\scripts\org-watchdog.ps1\"" /SC MINUTE /MO 10 /ST 00:55 /F
```

## 四、与 bootstrap.js 自启共存检查

- `pi-xuwu-boot-butler` / `pi-xuwu-boot-web` / `pi-xuwu-butler-once`：开机一次性拉起管家/web（bootstrap.js 幂等）
- `pi-org-watchdog`：每 10 分钟常驻守护（挂了才重启）
- **无冲突**：两者都走 `bootstrap.js`（pidfile 幂等 + 单实例锁），watchdog 只在"进程真没了"时补位，不会与开机自启重复拉起。

## 五、产出位置

- 看护脚本：`org/scripts/org-watchdog.ps1`
- 守护日志：`org/logs/watchdog.log` + `org/logs/watchdog-restart-*.log`
- 本报告：`org/agents/server-admin/artifacts/org-watchdog.md`
