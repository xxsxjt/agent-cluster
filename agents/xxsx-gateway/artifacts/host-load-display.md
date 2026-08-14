# 主机负载显示改造（CPU%/磁盘 used/total）— APP + 网页 + 后端

**日期**：2026-08-08
**Agent**：xxsx-gateway
**任务**：host-load-display

## 需求（用户 2026-08-08 22:1x 批评）
原"负载"显示的是 load_average（1/5/15 分钟均值，形如 `0.49 / 0.87 / 1.13`），被误当成 CPU 百分比。要求改为明确显示：
- **CPU：x%**
- **磁盘1：已用/总量**（磁盘2 如有）
- 内存（已有）
- 位置：APP（Android）+ 网页管理后台（host-panel）

## 后端 Go（service/hostadmin）
- `service.go`：Snapshot 结构新增 `CpuUsedPercent float64 \`json:"cpu_used_percent"\``；在 `BuildSnapshotWithServices` 中调用新函数赋值。
- 新增 `cpu_linux.go`：`readCpuUsedPercent()` —— 读 /proc/stat 两次采样（间隔 200ms）差值计算 CPU 使用率（busy/total）；`user nice system idle iowait irq softirq steal` 全字段。
- 新增 `cpu_other.go`：非 Linux 返回 0。
- **不改 LoadAverage 字段**（保持兼容），仅显示层不再冒充 CPU。
- 验证：`go build`（本机 + GOOS=linux 交叉编译）通过；`go vet` 通过；`go test ./service/hostadmin/` 通过。

## 网页（web/default/src/features/admin-assistant/）
- `api.ts`：`HostSnapshot` 类型新增 `cpu_used_percent: number`。
- `host-panel.tsx`：指标卡改为 **CPU（%）、内存（% + used/total）、磁盘（每个 disk 一张卡：percent + used/total）、系统负载（1/5/15，次要从属）、SSH 失败**。磁盘由 `snapshot.disks` 动态渲染（有第二盘 `/data` 就显示）。
- 验证：`rsbuild build` 成功，`dist` 与最终二进制内均含 `cpu_used_percent` 与磁盘模板。

## APP（xxsx-admin-android）
- `OverviewFragment.kt` + `fragment_overview.xml`：新增 `resourceDisks`、`resourceLoadAvg` 两个 TextView；`resourceLoad`=CPU%，`resourceMemory`=内存% + used/total，磁盘逐行 `磁盘N <path>：pct%（used/total）`，`resourceLoadAvg`=系统负载小字。
- `ServersFragment.kt`（renderMain）：主服务器摘要加入 CPU%、内存%+used/total、磁盘逐行。
- `MoreFragment.kt`（incidentDetail "host"）：加入 CPU%、内存、磁盘 used/total 逐行。
- 各 Fragment 新增 `formatGB()`（GB 格式化：≥100 用 `%.0fG`，否则 `%.1fG`）。
- 验证：`gradlew :app:compileDebugKotlin`、`:app:processDebugResources` 均通过（exit 0）。

## 产物
- Linux 生产二进制：`C:\_dx\_serve\new-api-linux-amd64-20260808-host-load-display`
  - SHA256：`39fe46703e82cab1a8abb08a1649d88aa147b8907060cef884afb8ec2658c278`
  - 版本：`v0.0.0-xxsx.host-load-display.1-20260808`
  - 已内嵌 rebuilt default+classic web（含 host-panel 改造），二进制内确认含 Go 结构体 tag `cpu_used_percent"`
- 部署脚本：`artifacts/deploy-host-load-display.py`（完整备份+fuser ETXTBSY 防护+回滚+端点验证）
- 验证脚本：`artifacts/verify-host-load-display.py`（用 root access_token 直连 /api/admin/host/status）

## 生产部署情况（重要）
- 已通过 US 跳板机 → HK 部署到 `/opt/xxsx-api/bin/new-api`，服务 `xxsx-api-mi` 重启后短暂运行新版本（部署脚本验证：LOCAL_STATUS=200、PUBLIC_STATUS=200、VERSION/NEW_SHA 匹配、DB 完整、用户 27/渠道 11/令牌 52 不变、0 错误）。
- **但随后被并发活跃部署覆盖**：服务器当前生产架构已演变为 node 体系（服务进程为 `/usr/local/bin/node cli.js serve 3461`，`/opt/xxsx-api/cli.js`），且有另一个 agent 在活跃维护部署（`/opt/xxsx-api/bin/deploy-hk.sh`，部署 `new-api.new`，时间戳 2026-08-08 21:43）。我的二进制在部署后约 5 分钟内被该并发管线覆盖（现 `/opt/xxsx-api/bin/new-api` 为 v0.0.0、SHA 59a3…、无 cpu 字段）。
- 当前线上状态：服务 `active`、`/api/status` 200，运行的是并发管线的构建（**不含本改造**，`cpu_used_percent` 未上线）。
- 备份留存：`/data/xxsx-api/server-backups/host-load-display-20260808-*/`（新二进制 + DB .backup + service 文件）。

## 结论与建议
- 代码改造**全部完成并本地验证通过**（Go 编译+单测、Android 编译+资源、web 构建+内嵌）。
- 生产落地被并发活跃部署管线接管，**未持续上线**。为不与另一 agent 的活跃部署冲突，本 agent 停止继续覆盖线上。
- 建议：将本改造并入服务器当前权威部署管线（`deploy-hk.sh` / `new-api.new` / `cli.js serve`），或在下个维护窗口由管家/集群 agent 统一部署。二进制与验证脚本已备好，可一键走既有流程。
