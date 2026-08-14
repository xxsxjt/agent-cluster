# HK 部署收尾 + 存储迁移收尾复核（hk-deploy-finalize）

任务：nextday-2026-08-11-存储迁移收尾-HK-部署-152618
日期：2026-08-12 18:12-18:1x（server-admin）
状态：✅ 完成（存储迁移收尾已证 + HK 保活 24/7 正常 + 修复 HK git-sync 死链）

---

## 一、存储迁移收尾（结论已在先前会话实证）

**核心结论：CNB 无平台级可写持久盘，~28G 归档不迁 CNB，保留 HK 为唯一持久副本。**

- CNB 空间约 10-15min 固定生命周期强制回收，/data(overlay)、/root/.vscode-server(per-node md0)、/workspace(git) 均不跨回收持久；/storage /stash /backup /restore /disk API 均 404。
- HK 源数据完整性校验通过（本次复核 18:17）：recycle 12G + server-backups 8.0G + build 3.6G + account-pool-data 2.3G 等共约 28G 全部在位，/data 33G 已用 / 剩 9.1G。
- 无效 `.storage-migrated-persist` 标记已清理；hk-storage-migrate.sh 注释已修正为"per-node md0 非持久"。

## 二、HK 部署复核（24/7 保活 + git 同步）

### 1. CNB 保活 24/7 ✅ 正常
- `/usr/local/bin/cnb-keepalive-hk.sh` + cron `/etc/cron.d/org-cnb-keepalive`（每 5min）已部署。
- **实测 heartbeat 持续正常**：18:00/18:05/18:10/18:15 三空间（xxssxx.top/1,2,3）全部 `heartbeat ok`，日志 `/data/agent-cluster/logs/cnb-keepalive.log` 滚动更新。
- secrets/cnb-token 权限 600 在位（root），SSH key /root/.ssh/id_rsa_cnb 在位。

### 2. 修复：HK org-git-sync 死链（本次发现并修复）
- **问题**：`/data/agent-cluster` 是 HK 运行目录（butler/twin/inbox/knowledge），**不是 git 仓库**（无 .git）。原 `org-git-sync` cron 每 10min 执行 `git fetch cnb`，因无 remote 必然失败且短路无日志（白耗资源）；`hk-cnb-pull.sh` 亦假设该目录为 git clone，与真实架构不符。
- **真实架构**：org 数据同步走**本机 dual-sync.js（ssh/scp 双向，每 15min）主通道**（实测 18:12 同步到位，变更 7 处）；本机 git-sync.js push 到 cnb.cool 私有仓库（18:13 push OK）。HK git pull 为可选兜底，仅适用于独立 git-clone 部署。
- **修复**：
  1. `/etc/cron.d/org-git-sync` 加 `.git` 守卫：`[ -d /data/agent-cluster/.git ] && ...`，非 git 仓库静默跳过（备份 `.bak-20260812`）。
  2. `hk-cnb-pull.sh` step1 加守卫 + 更新头注释说明 dual-sync 主通道（本机与 HK 两端一致，HK 备份 `.bak-20260812`）。
  3. 语法校验通过，守卫验证：非 git 仓库正确跳过。

## 三、落地清单

| 项 | 状态 |
|---|---|
| 存储迁移收尾（CNB 无持久盘→归档留 HK，28G 完整） | ✅ 复核通过 |
| HK CNB 保活 24/7（cron 5min + heartbeat 正常） | ✅ 正常 |
| secrets/token + SSH key 权限 | ✅ 600 在位 |
| org-git-sync cron 死链修复（.git 守卫） | ✅ 已修复 |
| hk-cnb-pull.sh 守卫 + 注释修正（本机+HK 一致） | ✅ 已修复 |
| 本机改动 git commit+push（同步 cnb.cool/github） | ✅ 已提交 |

## 四、结论与建议
1. **归档保留 HK**（唯一持久副本），CNB 只作临时计算层；HK /data 剩 9.1G，需关注增长（后续可走阿里云 OSS 等持久大容量，需隐私合规）。
2. **HK 保活 24/7 已就绪**，本机休眠/关机时由 HK cron 兜底防 CNB 回收。
3. **git 通道定位**：dual-sync 为主，git-sync 为本机→cnb.cool push；HK 如需独立 git 兜底，应 git-clone 到独立目录（勿用运行目录），脚本已预留守卫能力。

## 五、相关文件
- `scripts/hk-cnb-pull.sh`（本机 + HK /data/agent-cluster/scripts 一致，备份 .bak-20260812）
- `/etc/cron.d/org-git-sync`（HK，备份 .bak-20260812）
- `/etc/cron.d/org-cnb-keepalive` + `/usr/local/bin/cnb-keepalive-hk.sh`（HK，未改动）
- `/data/agent-cluster/logs/cnb-keepalive.log`（保活证据）
