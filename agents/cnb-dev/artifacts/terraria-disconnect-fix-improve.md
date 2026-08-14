# terraria-disconnect-fix 完善（P2 海外扫描屏蔽 + DebugLogs 预案）

- 日期：2026-08-11
- 执行：cnb-dev / terraria-disconnect-fix-improve
- 服务器：HK（103.100.159.111，terraria3/HKWorld3，端口 6666）
- 源任务：terraria-disconnect-fix（结论=服务端无故障，断连根因指向客户端跨境网络瞬时中断；遗留"未做服务端改动"）

## 遗留完善点（源任务 DONE 明确）
源任务**未做任何服务端改动**，遗留两项可补做：
1. **P2：6666 加白名单屏蔽海外扫描**（端口正被海外 IP 扫描）
2. **可选开启 DebugLogs 精确定位断连**（需玩家离线时段重启）

## 本任务完成的完善

### ① P2 海外扫描屏蔽 —— ✅ 已落地并端到端验证

**扫描证据（journal 实锤）**：8月11日多个海外 IP 反复连接 6666：
- 195.170.172.215（05:45，5+ 次不同端口）
- 85.217.140.5 / 85.217.140.11（07:55 / 08:10）
- 150.107.36.82（09:06，2 次）
- 204.76.203.81（09:21，2 次）
- 94.154.43.21（11:23）
- 80.66.83.80（13:18）

正常玩家固定两个大陆 IP：**120.230.140.225（xxsx）、113.109.49.57（芙芙）**。

**落地（fail2ban 新增 tshock-scan jail，可逆、不重启游戏、不踢在线玩家、只封扫描 IP）**：
- `/etc/fail2ban/filter.d/tshock-scan.conf`：
  - `failregex = ^.*TShock\.Server\[\d+\]: <HOST>:\d+正在连接`
  - `ignoreregex` 白名单放行 `120.230.140.225` 和 `113.109.49.57`
  - `journalmatch = _SYSTEMD_UNIT=terraria3.service`
  - datepattern 适配中文月份（`8月`，`{^LN-BEG}` 不识别中文月份是坑）
- `/etc/fail2ban/jail.d/xxsx.local` 追加：`[tshock-scan] enabled=true port=6666 maxretry=6`
  - 继承 DEFAULT：bantime 1h、findtime 10m、backend systemd、banaction=firewallcmd-rich-rules

**端到端验证**：
- fail2ban-regex：真实日志 8 行 → 正常玩家 6 行被 ignoreregex 忽略、海外扫描 2 行匹配；纯扫描样本 3/3 匹配 ✅
- `fail2ban-client reload` → `tshock-scan` jail 生效 ✅
- 手动 ban 195.170.172.215 → 防火墙生成 `source address=195.170.172.215 ... port 6666 reject` 规则 ✅
- `set tshock-scan unbanip 195.170.172.215` → 规则删除（count 0）✅（注：旧语法 `unbanip` 无效，须用 `set <jail> unbanip <ip>`）
- fail2ban 开机自启 enabled，jail 已入持久列表 ✅
- terraria3 服务保持 active，未触碰在线玩家 ✅

### ② DebugLogs 精确定位预案 —— ✅ 已就位（待离线时段执行）

- 当前有玩家**芙芙在线**（14:48 加入，ESTAB），任务书明确"改 TShock 配置要重启服务，用户可能在线玩——先说明时段"，故**未擅自重启**。
- 已写入一键预案脚本：`/data/terraria/tshock/enable-debuglogs-offline.sh`
  - **玩家在线保护**：检测 6666 ESTAB 连接 >0 即拒绝执行，防止误踢在线玩家
  - 备份 config → 开 DebugLogs=True → 重启 terraria3 → 校验 active
  - 下次断连时 `journalctl -u terraria3` 将记录详细 socket 错误，可 100% 确认根因
  - 定位后改回 DebugLogs=False 复原
- 脚本语法检查通过（bash -n OK），服务 Type=simple、Restart=on-failure 重启约 30s 内恢复监听。

## 结论
- **源任务遗留的"未做服务端改动"已补做一项可安全落地的**：海外扫描屏蔽（fail2ban tshock-scan jail），既缓解端口扫描、又不误伤玩家、可逆可回滚。
- **DebugLogs 精确定位** 作为离线时段预案就位，因玩家在线未执行重启（守规矩，不擅自踢在线玩家）。

## 回滚/复原
- fail2ban：`fail2ban-client set tshock-scan unbanip <ip>` 可即时解封误封；删除 `/etc/fail2ban/filter.d/tshock-scan.conf` + `xxsx.local` 中 `[tshock-scan]` 段并 reload 可完全移除该 jail。
- DebugLogs：`systemctl restart terraria3` 前执行预案脚本（含在线保护），定位后改 DebugLogs=False 复原。
- 本次未改动游戏配置、未重启游戏服务。
