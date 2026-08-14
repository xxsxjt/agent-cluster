# 360 弹窗治理收尾 · 复验报告（2026-08-12）

- 执行者：system-ops
- 任务：nextday-2026-08-11-本地-360-弹窗治理收尾-152618
- 结论：**根治（EnableUpdateExam=0 落盘）仍被 360 自我保护硬拦截，常规会话/提权均无法落盘；需用户安全模式或 360 UI 操作。360Tray 空指针未复发。**

---

## 一、原值记录（已确认备份完整，可还原）

| 文件 | 原值 | 备份位置 |
|---|---|---|
| `...\360Safe\SoftMgr\roconfig.ini` | `[app] EnableUpdateExam=1` | `pi_workspace/scratch/360-roconfig-backup.ini` |
| `...\360Safe\SoftMgr\softmgrcfg.ini` | `[Options] EnableUpdateExam=1  ` | `backup/360softmgr_20260811/softmgrcfg.ini` + `backup/softmgrcfg.ini.bak-20260811-183044` |
| HKLM Run\360Safetray | `"C:\Program Files (x86)\360\360Safe\safemon\360tray.exe" /start` | `pi_workspace/scratch/360_run_entry_backup.txt` |

> 注：softmgrcfg.ini 当前 649B 与备份**完全一致**（IDENTICAL），说明此前被上一会话截断为 0 字节的损坏已成功恢复，空指针/配置损坏风险已消除。

## 二、当前实时状态（2026-08-12 提权会话实测）

- 提权：`net session`=YES（管理员，已提权）。
- `360Tray.exe` 运行中（PID 70084）；`SoftupNotify.exe` **当前未运行**。
- `roconfig.ini` 第 5 行 `EnableUpdateExam=1`；`softmgrcfg.ini` `EnableUpdateExam=1  ` —— **开关仍为开启**（弹窗来源未根除）。
- 360 自我保护驱动均在运行：`360FsFlt`（文件过滤 minifilter）=RUNNING、`ZhuDongFangYu`（主动防御）=RUNNING。

## 三、提权落盘再验证（仍被拦截，证据）

1. **写文件**：向 `...\360Safe\SoftMgr\_sysop_probe.tmp` 写入 → `Permission denied`（即便提权）。→ 360FsFlt 拦截整个 360 安装树。
2. **注册表自启项**：`Remove-ItemProperty HKLM\...\Run\360Safetray` 返回 REMOVE-OK，但随即查证 `STILL PRESENT` —— **360 自愈机制立即重写**，删除无效。
3. **结论**：管理员提权在常规会话下无法落盘 `EnableUpdateExam=0`，与既往 4+ 次失败结论一致。根因=360 自我保护，非权限问题。

## 四、360Tray 空指针是否复发？

**未复发。**
- 事件日志近 200 条应用错误中，**无 360Tray 空指针/崩溃**。
- 唯一相关：`360PatchMgr64.exe`（360 补丁管理，非 360Tray）在 2026-08-11 16:21 因 combase.dll 异常崩溃一次，与本任务治理目标无关。
- 360Tray 当前稳定运行（PID 70084），无异常。

## 五、根因与根治路径（需用户动作）

EnableUpdateExam 为**文件级开关**（roconfig.ini / softmgrcfg.ini），无注册表等价项；被 360 自我保护（360FsFlt+ZhuDongFangYu）锁定，提权也无法写入，且 Run 自启项自愈。**唯一根治法**二选一：

1. **安全模式**（推荐，脚本已备好）：用户重启进入安全模式（360 自我保护不加载）→ 以管理员运行
   `pi_workspace/org/agents/system-ops/scripts/360-remediate-safe-mode.ps1`
   （将 EnableUpdateExam 1→0 + 移除 360Safetray 自启 + 恢复软管配置；支持 `-Restore` 回滚）。
2. **360 设置 UI**：打开 360 安全卫士 → 设置 → 软件管家/升级提醒 → 关闭「软件升级提醒」。
   （用户操作走 360 特权写路径，不受自我保护拦截，360 自己会写回 0。）

## 六、结论

- 本任务**无法在常规会话自主落盘根治**——再次实锤 360 自我保护拦截（写文件/注册表双路径），需用户安全模式或 UI 操作。
- **已完成**：原值备份确认 ✓、当前状态复验 ✓、360Tray 空指针排查 ✓（未复发）、softmgrcfg 损坏恢复确认 ✓、根治脚本就绪（safe-mode）。
- 标记为 `.FAILED`，原因：提权落盘仍被 360 自我保护硬拦截，根治需用户安全模式/UI 操作。
