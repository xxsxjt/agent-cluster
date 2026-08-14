# CNB 保活加固 + 存储迁移收尾（cnb-storage-migration-finalize）

任务：nextday-2026-08-11-CNB-保活加固-存储迁移收尾-152618
日期：2026-08-12 16:xx-17:0x（server-admin）
状态：✅ 完成（保活加固落地 + 存储迁移收尾实证结论 + 完整性校验）

---

## 一、任务目标

> 调高 keepalive 频率或加保活动作，监控 ~28G 迁至 CNB storage 完成并完整性校验

## 二、保活加固（✅ 已完成并运行）

- **频率 5min → 2min**：`LOOP_INTERVAL_MS = 2*60*1000`
- **心跳增强**：纯 `touch` → 「短 CPU/IO 活动 + 写盘心跳文件 + echo hostname/sn」，命令 <8s
- **运行中**：PID 34452（`cnb-keepalive.js --loop`），日志 15:21 起每 2min 心跳 ✅
- 代码已提交 git（dd8b8cd），与另一 server-admin 智能体「持久存储评估」结论一致

## 三、存储迁移收尾（核心实证：CNB 无平台级持久存储）

监控迁移时实测发现 **CNB 空间不持久**，28G 数据无法可靠存于 CNB：

| 位置 | 持久性 | 实测证据 |
|---|---|---|
| /data（原迁移目标） | ❌ docker overlay | 实例 10-15min 固定生命周期回收重建即整个清空 |
| /root/.vscode-server/storage（我改进后的目标） | ❌ 容器私有层 | 7月 code 文件是镜像预置层(lower)，用户写入的 storage/标记随回收消失；我迁的 28G 已丢、`.md0-persist-marker` 标记消失 |
| /workspace | ✅ git 工作区跨实例保留 | test-persist.txt 跨实例保留；但塞 28G 归档使 git 膨胀，不适宜归档 |
| CNB 平台 API | ❌ 无持久盘 | /storage /stash /backup /restore /disk 均 404 |

**结论**：CNB 不适合存 HK 归档数据。28G 数据**保留 HK** 为唯一安全归宿。

## 四、完整性校验（✅ 通过）

HK 源数据全部完好（未删，脚本只 rsync 不删源）：
- recycle: 12G / 612 文件
- server-backups: 8.0G / 14276 文件
- build: 3.6G / 107163 文件
- backups: 1.1G / 2780 文件
- deploy-backups: 133M / 8 文件
- account-pool: 2.3G / 34061 文件
- system backups: 746M / 316 文件
- **总计 28G 完好**，/data 33G 使用，剩余 9.3G

## 五、落地清单

| 项 | 状态 |
|---|---|
| keepalive 2min + 增强心跳（PID 34452） | ✅ 运行中 |
| 迁移脚本修正：标注 CNB 不可持久 + 增强校验逻辑 | ✅ 本地+HK 一致（123行，git 6f3d091） |
| CNB 上误迁残留清理（658M） | ✅ 已清理 |
| HK 28G 源数据完整性校验 | ✅ 通过 |
| work_record 记录 | ✅ 已追加 |
| 产出文档 | ✅ 本文档 |

## 六、建议

1. **28G 归档数据保持 HK**（不迁 CNB）；HK /data 剩余 9.3G，需关注后续磁盘增长。
2. CNB 空间只放**可重建产物**（构建缓存、临时），不放长期归档；靠「回收自愈 + 环境镜像快恢复」兜底（另一智能体已落地）。
3. keepalive 定位是「尽量 running + 快速自动拉起」，无法规避 CNB 固定生命周期强制回收，不要依赖它保住实例。
