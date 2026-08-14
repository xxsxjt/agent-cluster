# hk-exec-hub — HK 执行中枢部署（HK 管家 + 调用 CNB 执行 + 存储上云）

日期：2026-08-11
执行：server-admin
状态：✅ 已落地并验证

## 一、背景与架构目标

用户（2026-08-11 19:3x）："那个 uu 放服务器上吧，让服务器调用云开发空间，大部分任务都迁移上去吧，存储空间也用云开发空间的可以吧，毕竟服务器磁盘也不大"

**架构升级**：HK 服务器 = 24/7 执行中枢（butler 管家）→ 调用 CNB 云空间执行任务 + 存储；本机只做指挥。

**最终架构（分区设计，防双管家冲突）**：
```
本机 Windows（指挥中枢）          HK（执行中枢管家）           CNB 云空间（执行+存储）
┌────────────────────┐  hk-task  ┌───────────────────┐  cnb-task  ┌──────────────────┐
│ butler.js(50MB轻量)│──投递任务─▶│ butler.js(systemd)│──SSH投递──▶│ pi 0.83 / 8核16G   │
│ local 任务(UI/代码)│  .DONE回传 │ remote 任务→CNB    │  .DONE回传 │ /data/cnb-org     │
│ remote→HK/CNB     │◀──────────│                    │◀──────────│ storage 256G      │
└────────────────────┘           └───────────────────┘            └──────────────────┘
  不同 inbox 物理隔离 → 任务不重复执行
```

## 二、关键链路（三级，已端到端验证）

**本机 → HK → CNB → 回传**（hk-exec-hub E2E 实测通过）：
1. 本机 `scripts/hk-task.js` 投任务到 HK inbox（公网 103.100.159.111:43891，Tailscale 链路挂已改）
2. HK 管家（systemd org-butler）扫描 HK inbox → 识别 target=cnb/remote → `dispatchToCnb`
3. `scripts/cnb-task.js`（HK 端）动态解析 CNB SSH host → SSH 投递 + 拉起 cnb-exec
4. CNB 端 pi 0.83 执行任务代码块 → 写 .DONE → 回传 HK → 回传本机

验证结果（hk-hub-e2e，15 秒完成）：
```
✅ CNB 任务 [hk-hub-e2e] 完成：HUB_E2E_CHAIN_OK / executor=1fe1d62d44d3 / pi=0.83.0 / storage_ok=YES
```

## 三、落地明细

### 1. HK 部署完整 org + butler（执行中枢）
- HK 已有 org 基础（org-runner、systemd、pi 0.83）→ 同步本机最新代码
  （butler.js 116K + lib 25 文件 + scripts 33 + config 19）到 /data/agent-cluster
- 备份旧代码 → `.bak-hkexec-20260811-1941`
- **HK 管家 = systemd org-butler（完整版 butler.js，active 稳定）**
- 新增 **`scripts/hk-deploy-exec-hub.sh`**（幂等自愈：6 步检查——代码/token 权限/CNB key/属主/systemd/保活，全绿）

### 2. HK→CNB 调用打通（关键修复）
- `scripts/cnb-ctl.js` getToken 多来源：环境变量 CNB_GIT_TOKEN → secrets/cnb-token 文件 → Windows DPAPI
- `lib/spawn.js` 跨平台：Linux 直接 spawn pi，不再强制 cmd.exe + pi.cmd
- **butler.js spawn 全部改 process.execPath**（HK org-runner PATH 无 node 的坑）
- 权限修复：
  - `secrets/cnb-token` → org-runner 组读（640）
  - `id_rsa_cnb` → 复制到 org-runner home `~/.ssh/`（600）
  - org 数据目录属主 → org-runner 全权（修 review-loop EACCES）
- **cnb-exec.js findDonePath 优先匹配 /cnb-org/ 路径**（旧版误写 /data/agent-cluster 路径导致 ENOENT；cnb-task 自愈加版本校验——缺或旧版都强制更新）

### 3. 本机降级为轻量
- 本机但 butler 内存仅 50MB（PID 14672 健康运行），只处理 local
- remote 任务 → `dispatchToCnb`（CNB 优先）/ `dispatchToHk`
- 本机 butler.json `remoteFirst: cnb`、`remoteFallback: [cnb, hk]`
- 防双管家冲突：本机/HK 扫描各自物理 inbox，不重复执行

### 4. 存储上云
- CNB 空间3 建 storage 目录：`/data/cnb-org/storage/{artifacts,logs,backups,reports}`（256G）
- 新增 **`scripts/hk-storage-migrate.sh`**（幂等增量 rsync：HK 归档目录 → CNB storage，成功后打标记）
- 可迁移约 28G：xxsx-api/recycle(12G) + server-backups(8.3G) + build(3.6G) + account-pool(2.3G) + backups(1.1G) + deploy(133M) + system(746M)
- 后台迁移进行中（recycle 已传 7.8G/12G）

### 5. UUMit 上服务器
- UUMit skill 已在 CNB 空间1 安装（7 skill 校验通过），执行端指向 CNB（side:remote, space:1）
- 授权链接/用户码已生成，等待用户在平台页面授权

## 四、验证清单

| 项 | 结果 |
|---|---|
| HK 管家活着（systemd active） | ✅ PID 2097012 稳定运行 |
| HK→CNB SSH | ✅ ORG_RUNNER_CNB_KEY_OK |
| 三级链路派发→执行→回传 | ✅ hk-hub-e2e 15s 完成，本机 .DONE 生成 |
| CNB 环境（pi 0.83 / storage） | ✅ INIT_OK + storage 目录齐全 |
| 本机 remote 不本机跑 | ✅ remote→CNB/HK 路由生效 |
| 存储文件 CNB 可查 | ✅ storage/backups/recycle 已传 7.8G |
| UUMit 指向 CNB | ✅ side:remote space:1 |

## 五、遗留 / 注意事项

1. **CNB 空间回收不持久**：CNB 空间 / 是 overlay，闲置约 10min 回收重建会清空 /data/cnb-org。
   - 已靠：HK keepalive cron（每 5min 心跳）+ cnb-task 自愈（环境自动重建）+ hk-deploy-exec-hub.sh 幂等
   - **关键数据仍需走 git 通道（cnb.cool 仓库）持久**；storage 是热存储，回收需重迁
   - 建议后续：提高 keepalive 频率 或 接 CNB 持久存储服务（当前 Git 通道兜底）
2. **存储迁移后台进行中**：约 28G 需时间，CNB 空间回收会中断（脚本幂等可续传重跑）
3. **HK 管家是完整版 butler**（非精简），内存约 60-70MB，systemd MemoryMax=384M 足够；3.8G 内存下可接受
4. **Tailscale 链路挂**：本机→HK 已改公网 103.100.159.111（hk-task/dual-sync/hermes-run），建议后续修复 Tailscale
5. HK 管家用的模型渠道（opencode-go）在 HK 可能需单独配 key（当前走 /data/agent-cluster/.pi 或 HK pi 默认）
