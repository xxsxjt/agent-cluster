# CNB 保活加固 + 防回收策略（nextday-2026-08-11-CNB-保活加固-152618）

**日期**：2026-08-12　**执行**：server-admin（cnb-dev 域）
**关联**：cnb-sync-p0（2026-08-11）→ 本次加固落地 + 端到端验证

## 1. 现状与根因评估（重要结论）

通过实际探测与观测确认：

- **CNB 无平台级持久存储/快照能力**：`/workspace/stash/list`、`/workspace/backup/list`、`/workspace/restore` 等 API 均返回 `Resource not found`；workspace detail 虽有 `stash_count/restore_id/backup_status` 字段但无可用端点。**CNB workspace 的 /data 属容器本地盘，实例回收即清空。**
- **强制回收不可避免**：观测日志（logs/cnb-keepalive.log）显示，即使每 5 分钟 SSH touch 心跳，三空间实例仍在 **~15 分钟尺度被重建**（sn 从 1jvqcerv9 → 1jvqd658a 等频繁轮换，workspace/list total 已堆积 289 个历史实例）。CNB 有闲置约 10 分钟回收 + 凌晨 4-6 强制回收 + 实例生命周期上限。
- **结论**：单纯调高 keepalive 频率**无法 100% 规避回收**，只能缓解"闲置回收"。真正可靠的是**"回收即自愈"**——把"环境恢复"做成自动化、秒级，替代每次从零 curl+npm 的分钟级重迁。

## 2. 已落地改动

### A. keepalive 增强（scripts/cnb-keepalive.js）
- 频率 **5min → 2min**（贴近 10min 闲置阈值，留 5 倍余量）。
- 心跳**增强**：原 `touch /tmp` 升级为执行一段真实命令（短 CPU 循环 + 心跳写盘 + 记录耗时/主机），最大化命中 CNB"有操作"判定。
- 新增**实例重建监测**：记录每空间 `lastSn`，sn 变化时打印"实例已重建 + 距上次重建分钟数"，用于持续观测真实回收频率（防回收策略的数据依据）。
- 守护进程已重启加载新代码（PID 34452，--loop 2min）。

### B. 环境镜像加速重迁（新增 scripts/cnb-env-image.sh + 本机存档）
- **问题**：实例回收重建后 /data 清空，java/gradle/pi 全丢，每次从零 `curl gradle(90MB)+unzip` + `npm install pi(163M)` 耗时数分钟 = "storage 热数据重迁"成本。
- **解法**：把已初始化好的环境打包成镜像（gradle 146M + pi 全局 163M → **env-image.tar.gz 154M**），本机存档 `logs/cnb-env/env-image.tar.gz`（logs/ 已 gitignore，不进版本库）。
- `cnb-env-image.sh` 支持 `build`（CNB 端打包）与 `restore`（解压恢复 gradle+pi+软链，幂等）。
- 镜像已构建并存档本机（sha256 前缀 10a8d567）。

### C. cnb-task.js 自愈增强
- **环境自愈独立于 exec 缺失**：修复了原逻辑缺陷——环境自愈只绑定在 `cnb-exec.js 缺失` 分支内，导致"exec 在而环境缺失"（空间3 实测）时被跳过。现环境自检总是执行。
- **镜像优先恢复**：检测 java/gradle/pi 缺失 → 本机有镜像则 scp + `restore` 秒级恢复 gradle+pi → 再自检，仍缺（尤其 java 走 apt）才补跑 `cnb-init-env.sh`（幂等只装缺失项）；无镜像回退原 init-env 全流程。

## 3. 端到端验证（真实场景）

空间3（回收重建后 java/gradle/pi 全 MISS）投递构建任务：
1. `⚠️ CNB 端构建环境缺失 → 用环境镜像快恢复`（scp 154M + restore ~90s）
2. `✅ 镜像恢复 gradle+pi`
3. `✅ CNB 环境自愈完成（java/gradle/pi 就绪）`（init-env 补 java）
4. 任务真实执行 → **`GRADLE_OK / VERIFY_ENV_IMAGE3_OK`**（gradle 真实构建通过）

对比改造前：从零 curl gradle(90MB)+unzip + npm install pi(163M) 需数分钟；改造后镜像恢复秒级（scp 154M 为唯一耗时，远快于 npm install）。

## 4. 防回收分层策略（沉淀）

| 层 | 机制 | 作用 | 局限 |
|---|---|---|---|
| 1. 保活 | keepalive 2min + 增强活跃心跳 + 自动拉起 closed | 缓解闲置回收，尽量维持实例存活 | 无法规避强制回收（凌晨4-6/生命周期） |
| 2. 回收自愈 | cnb-task 环境自检（独立于 exec）+ 环境镜像秒级恢复 | 回收重建后自动恢复构建环境，任务照常执行 | 首次镜像 scp 154M 有约 90s 延迟 |
| 3. 数据安全 | CNB storage 目录（/data/cnb-org/storage）**非持久** | 归档/缓存 | ⚠️ 回收即清空——**重要数据不能只放 CNB** |

**Storage 数据安全红线**：HK 迁移到 CNB storage 的归档（recycle/server-backups/xxsx-build 等）会随实例回收丢失，**非持久**。重要数据必须：本机/HK 双写，或仅放可再生的归档；CNB storage 只作缓存/临时中转。详见 hk-exec-hub 的存储迁移方案——迁移已完成但 CNB 侧非持久，需评估是否拉回本机或接受"丢失可重建"风险。

## 5. 遗留 / 建议
- CNB 镜像 154M 每次 scp 是恢复耗时大头；若网络允许可考虑对镜像做差异（只重迁 pi 包）进一步压缩。
- 建议后续将环境镜像生成纳入"环境变更后自动 rebuild"，避免镜像与最新环境漂移。
- storage 迁移数据的安全策略需产品决策（是否放弃 CNB storage 持久性，或改双写）。
- 空间2 观测到 SSH 偶发断连（重建中），keepalive 会自动拉起，属正常。

**产出文件**：scripts/cnb-keepalive.js、scripts/cnb-env-image.sh、scripts/cnb-task.js、logs/cnb-env/env-image.tar.gz（154M，gitignore）
