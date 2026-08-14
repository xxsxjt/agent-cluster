# 存储迁移收尾 + 完整性校验（nextday-2026-08-11-存储迁移收尾-完整性校验-152618）

**日期**：2026-08-12 16:31-17:05（server-admin）
**任务**：确认 ~28G 全量迁至 CNB storage（recycle/server-backups/build/account-pool），回收后增量续传，做完整性校验并记录
**结论**：⚠️ **迁移无法在 CNB 持久化——CNB 无平台级可写持久盘**。完整性校验确认 HK 源数据完好（~28G），CNB 目标数据回收即丢。建议归档继续留在 HK，CNB 只作临时计算层。

---

## 一、执行过程

### 1. 状态盘点（16:31）
运行 `hk-storage-migrate.sh 3`（幂等增量迁移脚本）。当时源目录：
- `/data/xxsx-api/recycle` 12G、`server-backups` 8.3G、`build` 3.6G、`backups` 1.1G、`deploy-backups` 133M、`account-pool-data` 2.3G、`/data/backups` 746M
- 已有 3 个 `.storage-migrated-persist` 标记（backups/backups/system/recycle）

### 2. 迁移运行 → SSH 中断（16:31-16:48）
- recycle/backups/account-pool-data 命中标记跳过
- server-backups/build/deploy-backups 迁移中 SSH 断开（rc=23/255），完整性校验目标文件数读取为空 → 未打标记

### 3. 关键实证：CNB 空间回收即丢数据（16:48 前后）
- 迁移期间 CNB 空间3 从 `cnb-mhe-1jvqd65rn` 回收重建为 `cnb-42o-1jvqifs8h`（hostname 1540b2a884d9）
- 新实例上 `/root/.vscode-server/storage` 目录**消失**（find 全盘无 recycle/server-backups/account-pool 等目标目录）
- 已传入 `cnb-mhe` 节点 md0 的迁移数据（含 recycle 12G）**全部丢失，不可恢复**

## 二、CNB 持久性实证结论（核心发现）

对当前及新实例做全面探测，确认 CNB 三种存储均**不跨回收持久**：

| 存储位置 | 类型 | 跨回收持久？ | 实证 |
|---|---|---|---|
| `/data` | docker overlay | ❌ | 历史多轮验证：实例回收 /data/cnb-org 即清空 |
| `/root/.vscode-server` | per-node md0（每台物理节点各自的盘） | ❌ | cnb-mhe→cnb-42o 回收后 storage 目录消失，旧节点 md0 数据不可达 |
| `/workspace` | git-clone 工作区 | ❌（仅 git 提交持久） | 空间3 /workspace git 无提交；test-persist.txt Birth=实例启动时刻(16:48:11)，系模板/重克隆产物；persist-probe/PERSIST_MARKER 均未跟踪 |

**根因**：CNB 空间约 10-15min 强制生命周期回收（keepalive 只能缓解闲置回收、无法规避），每次回收落到（可能不同的）物理节点，md0 为各节点独立盘。**CNB 无平台级可写持久盘**（/storage /stash /backup /restore /disk API 均 404，已在先前 artifact 实证）。28G 归档无法在 CNB 持久化。

## 三、完整性校验（HK 源 = 唯一真副本，确认完好）

7 个源目录全部在位，总量约 28G，与任务描述一致：
```
recycle 12G · server-backups 8.0G · build 3.6G · account-pool-data 2.3G
backups(xxsx-db) 1.1G · /data/backups(system) 746M · deploy-backups 133M
```
- 迁移脚本用 `rsync` 推送到远端，**从不删除 HK 源** → HK 源无任何丢失
- `/data` 磁盘 44G 已用 33G / 剩 9G，未释放（因迁移未达持久目的，未清源）

## 四、落地动作

1. **删除全部无效 `.storage-migrated-persist` 标记**（backups/xxsx-api-backups/recycle/account-pool-data/server-backups）——这些标记声称"已迁到 md0 持久盘"，但目标数据已丢失，保留会导致未来脚本误跳过重迁、甚至在清源时误删唯一副本。已全部清除。
2. **修正 `scripts/hk-storage-migrate.sh`** 错误注释：原声称 `/root/.vscode-server/storage 挂载 /dev/md0（39.1T raid，跨实例持久）` —— 实证为 per-node md0，非持久。已改写注释 + echo 提示为"per-node md0，实例回收即清空，仅临时中转"。原文件备份 `.bak-20260812-persistcheck`。
3. **确认无 git 误提交大文件**：空间3 /workspace git 无任何提交，未污染版本库。

## 五、建议（供产品/管家决策）

- **归档不迁 CNB**：recycle/server-backups/build/account-pool 等 ~28G 归档继续保留在 HK（唯一持久副本），CNB 不承担持久归档职责。
- **释放 HK 磁盘的替代路径**：
  1. 清理 HK 内部真正的垃圾（旧 tmp / 可再生成的构建产物 / 过期 recycle）；
  2. 重要小文件走 git 通道（cnb.cool 仓库）持久；
  3. 若确有持久大容量需求，评估其他 VPS/对象存储（阿里云 OSS 等，走隐私合规）。
- **CNB 定位**：执行/计算层（环境镜像快恢复 + cnb-task 自愈已覆盖回收），storage 仅临时中转，绝不当持久盘。

## 六、相关文件
- `scripts/hk-storage-migrate.sh`（注释已修正，备份 .bak-20260812-persistcheck）
- 探测脚本：/tmp/cnb-storage-deep.sh、/tmp/cnb-persist-verify.sh、/tmp/cnb-workspace-check.sh（HK 临时）
