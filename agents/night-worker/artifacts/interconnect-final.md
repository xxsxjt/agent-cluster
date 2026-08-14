# 互联模式收尾验证报告（interconnect-final）

- 日期：2026-08-09 00:40（UTC+8 本机）
- Agent：night-worker（provider: opencode-go / deepseek-v4-flash）
- 范围：修误杀机制 + 同步验证 + 隧道常驻 + 自动分配确认

---

## 1. 修"空转超时误杀"机制（butler.js）

### 问题
`butler.js` 空转检测：任务日志尾部出现 `"type":"agent_settled"`（AI 已声明完成）但子进程未退出时，
原逻辑直接写 `.FAILED` + 杀进程 —— 误杀已经完成的任务（dual-cluster-sync / disaster-recovery 被误标失败）。

### 修复（2026-08-09，已改 `butler.js`）
- 新增常量 `SETTLED_GRACE_MS = 60 * 1000`（settled 后宽限期）。
- `agent_settled` 命中时：
  - 首次命中 → 记录 `entry.settledAt`，只等待（`⏳ 等待进程退出`），**不标记、不杀**。
  - 宽限 60s 内进程自行退出 → 走 pid 死分支标记**成功**。
  - 宽限 60s 仍不退 → **标记成功**（`agent_settled 后进程空转未退出（宽限已过，判定完成）`）+ 强制结束，**不再标 FAILED**。
  - 只写成功标记不移除 active → 下一轮由完成分支统一通知 + 记忆沉淀 + 清理（保证分级通知/日记完整）。
- pid 死分支：若 `entry.settledAt` 已设置（settled 后自然退出）→ 标记成功；否则照旧 `failTaskAnomaly`。
- 语法检查通过（`node --check butler.js` OK）。
- 注：运行中的 butler 仍为旧代码，修复需重启生效（见 §5 部署说明）。

---

## 2. 同步引擎真实验证（dual-sync.js 本机 ↔ HK）

### 基线
- `node scripts/dual-sync.js` 首跑：HK 可达，`merge agents/twin/activity.log`，变更 2 处（正常收敛）。

### 注入测试数据（仅 HK 端，一次性）
1. HK `org.json` 注入测试节点 `hk-sync-test-node`（parent=root，并加入 root.children）。
2. HK `agents/twin/activity.log` 追加测试行 `SYNCTEST-<ts> | dual-sync 测试行`。
3. HK `inbox/hk-sync-test.DONE` 创建测试终态标记。

### 同步结果（第二次跑）
| 目标 | 动作 | 验证 |
|---|---|---|
| org.json | `merge-local+push` | 测试节点被结构合并吸收：本机 `nodes['hk-sync-test-node']` 存在 ✅ 且进入 `root.children` ✅ |
| activity.log | `merge` | HK 测试行合并回本机 ✅ |
| .DONE | `pull(new) →local` | `inbox/hk-sync-test.DONE` 落盘本机，内容一致 ✅ |

### 清理与收敛
- 两端同时移除：org.json 测试节点（含 root.children）、activity.log 测试行、测试 .DONE。
- 残留检查全过：`✅ org.json 无测试节点残留` / `✅ activity.log 无测试残留` / `✅ 本机无测试 .DONE`。
- 最终同步收敛正常（仅 activity.log 跨端合并本会话真实日志，无测试污染）。

---

## 3. cloudflared 隧道常驻（开机自启）

### 现状核查
- cloudflared 原已运行（PID 37960），隧道 `remote.xxssxx.top → http://127.0.0.1:8787` 健康（HTTP 200）。
- 但**无任何自启**：无计划任务、无 Windows 服务（`schtasks`/`sc query` 均无）。
- set-cred.ps1 用 DPAPI 加密仓读取 token（`cf_tunnel_local_token`），需用户会话上下文 → 采用**登录时（LogonTrigger）计划任务**。

### 落地
- 用 PowerShell `Register-ScheduledTask` 创建 `org-cloudflared-local`：
  - Action：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File ...\org\scripts\cloudflared-local.ps1 -Daemon`
  - Trigger：`MSFT_TaskLogonTrigger`（登录触发）
  - Principal：du_ji
  - 状态 `Ready`。

### 端到端验证（打点自检，符合端到端验证铁律）
1. `Stop` 当前 cloudflared → 进程消失（PID 37960 退出）。
2. `Start-ScheduledTask org-cloudflared-local` → 12s 后 cloudflared 进程恢复（新 PID 44560）。
3. 隧道健康：`remote.xxssxx.top → HTTP 200` ✅，`cloudflared-local.pid` 已更新为 44560 ✅。
- 结论：开机登录后计划任务将自动拉起隧道，验证通过。

---

## 4. 自动分配确认（hk-task target 扩展 local/hk/auto）

### 现状
- `lib/route-auto.js` **已完整实现** `pickSide(task)`：
  - 命中构建标记（gradle/maven/npm build/compile/android/apk/msvc/msbuild/dotnet/exe 打包/go build/tsc 等）→ `local`（HK Linux 跑不了 Windows/Android 构建）。
  - 命中服务器/重活标记（ssh/scp/rsync/服务器/systemctl/docker/部署/大计算/爬取/100.97./new-api/xxsx 等）→ `hk`。
  - 其余 → `local`（默认，安全不惊扰）。
- `butler.js` 路由（第 169-173 行）**已接线**：
  - `target: hk` → 强制 HK；`target: local` → 强制本机；`target: auto`/未指定且未显式绑定 agent/group → 调 `pickSide` 判侧。
- **结论：auto 分配（构建→本机、服务/重活→HK）已落地，无需补充。**

---

## 5. 误杀修复部署说明（但ler 重启）

- 修复代码已写入 `butler.js` 并通过语法检查，但运行中的 butler（PID 35404）仍为旧代码。
- 因 `active` 为内存表（重启即空），为不影响本收尾任务的正常收尾，采用**延迟重启**策略：
  等本任务（night-worker）写出 `.DONE` 且进程退出后，再重启但ler 加载修复。
- 重启方式：`scripts/bootstrap.js start`（与 watchdog 同款，幂等 + 单实例锁），参考 `restart-butler-delayed.ps1`。
- 重启后 `scanInbox` 因 `interconnect-final.DONE` 已存在会跳过重派，安全。

---

## 6. 总结
- ✅ 误杀机制已修复（agent_settled → 宽限 → 标记成功，不再误标 FAILED）
- ✅ 同步引擎真实验证通过（org.json 结构合并 / activity.log 行合并 / .DONE 终态同步），测试数据已清理
- ✅ cloudflared 隧道常驻（登录自启计划任务），端到端验证隧道恢复
- ✅ auto 路由（构建→本机、服务/重活→HK）确认已落地
