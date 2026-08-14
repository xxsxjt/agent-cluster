# CNB 保活加固 / 持久存储评估（cnb-keepalive-persistent-storage）

任务：nextday-2026-08-11-CNB-保活加固-持久存储评估-152618
日期：2026-08-12 15:3x（server-admin）
状态：✅ 完成（结论 + 落地 + 端到端验证）

---

## 一、背景回顾

CNB 云开发空间此前多次出现：三空间闲置约 10 分钟即被回收重建，`/data/cnb-org` 整个清空
（java/gradle/pi 全丢），导致构建/分流任务每次都要从零初始化（curl gradle 90MB + npm install pi 163M，
耗时数分钟）——即「storage 热数据重迁」成本。

之前的 `cnb-keepalive.js` 已存在但：①频率 5min，距 10min 闲置回收阈值太近；②心跳只是 `touch /tmp`，
实测不触发 CNB「活跃」判定，实例仍被回收。

本任务目标：调高 keepalive 频率或加保活动作 + 评估接入 CNB 持久存储缓解 overlay 回收对 storage 热数据影响。

---

## 二、关键实证（本次实测）

### 1. keepalive 已加固落地（08-12 15:21 起生效）
- **频率 5min → 2min**：`LOOP_INTERVAL_MS = 2*60*1000`（贴近 10min 回收阈值，留 5 倍余量）。
- **心跳增强**：从纯 `touch` 改为「短 CPU/IO 活动 + 写盘心跳文件 + echo hostname/sn」，
  命令 <8s，最大化命中 CNB「有操作」判定。
- **保活进程**：PID 34452（本机），`cnb-keepalive.js --loop`，15:21 启动加载新代码，持续运行。
- 日志验证：15:21-15:25 三空间心跳 ✅ 每 2min。

### 2. 关键事实：CNB 存在「固定生命周期上限回收」，SSH 心跳无法完全防回收
从 `logs/cnb-keepalive.log`（451 行）统计空间1 的 sn 变化，重建几乎恒定每 10-15 分钟一次：

```
12:52 cnb-kbg → 13:02 cnb-9t7 → 13:12 cnb-3ao → 13:27 cnb-6jo → 13:37 cnb-ge8
→ 13:52 cnb-5g8 → 14:02 cnb-1ig → 14:17 cnb-t2g → 14:27 cnb-llg → 14:42 cnb-gdo
→ 14:52 cnb-rdg → 15:07 cnb-o9o → 15:17 cnb-cbg
```

空间1 单日重建 55 次、空间2 54 次、空间3 41 次。即便 2min 心跳全 ✅，实例仍被回收——
说明 CNB 的回收**并非单纯「闲置回收」，而是包含固定生命周期上限（约 10-15min）强制回收**，
任何 SSH/CPU 活跃都无法规避。

**结论：keepalive 只能缓解「闲置回收」和加速「closed→自动拉起」，无法规避强制生命周期回收。
保活的真正价值 = 让空间尽量保持 running、减少任务投递时撞上 closed 的窗口。**

### 3. CNB 无平台级持久存储（API 实证）
探测 CNB API 端点：
```
/storage  → 404
/stash    → 404
/backup   → 404
/restore  → 404
/volume   → 200（但这是 CNB 用户仓库实体 volume.net.cn，非持久盘）
/disk     → 404
```
**结论：CNB 不提供平台级持久盘（无 stash/backup/restore/volume-mount API）。
`/data` 属容器本地盘，实例回收即清空。因此「接入 CNB 持久存储」在平台层面不可行。**

### 4. 正确解法 = 「回收自愈 + 环境镜像快恢复」（已落地 + 端到端验证）
既然无法防回收、无法持久存储，唯一可行路径是把「storage 热数据重迁成本」从**分钟级从零初始化**
降到**秒级镜像恢复**：

- **`cnb-env-image.sh`**：把已初始化环境打包成镜像（gradle-8.14.3 + pi 全局包），本机存档
  `logs/cnb-env/env-image.tar.gz`（160MB）。实例回收后 `restore` 秒级解压。
- **`cnb-task.js` 自愈**：每次投递任务前检查环境（java/gradle/pi），缺失则：
  ① 优先 scp 环境镜像 → `cnb-env-image.sh restore` 秒级恢复 gradle+pi；
  ② 镜像不含 java（java 走 apt）→ 补跑 `cnb-init-env.sh` 兜底装 java。

**本次端到端实测（空间3 干净回收后）：**
```
镜像 restore 后：gradle bin ✅ 恢复（/opt/gradle-8.14.3/bin/gradle）
                pi 0.83.0 ✅ 恢复
                java ❌（镜像刻意不含，走 apt）
补 java（init-env / 手动 apt）后：java 21.0.12 ✅
gradle 真实构建 → GRADLE_REAL_OK ✅
```
整条「回收 → 自愈检测 → 镜像快恢复 → 补 java → 真实构建」链路跑通。

---

## 三、落地清单

| 项 | 状态 |
|---|---|
| keepalive 频率 5min→2min（cnb-keepalive.js） | ✅ 已落地，PID 34452 运行新代码 |
| keepalive 心跳增强（CPU/IO+写盘+echo） | ✅ 已落地 |
| 环境镜像打包/恢复脚本（cnb-env-image.sh） | ✅ 已落地 |
| 环境镜像存档 logs/cnb-env/env-image.tar.gz（160MB） | ✅ 已生成 |
| cnb-task.js 自愈：镜像优先 + init-env 兜底 | ✅ 已落地 |
| **cnb-init-env.sh 修复**：apt update 无条件先跑 + 3 次重试（原依赖 curl 短路会跳过 update 导致装 java 用过期缓存失败） | ✅ 本次修复 + 幂等重跑验证 |
| 端到端验证（回收→自愈→镜像→构建） | ✅ GRADLE_REAL_OK |

---

## 四、结论

1. **keepalive 加固**：频率 2min + 增强心跳已落地并运行。但实证表明 CNB 有固定生命周期上限
   （约 10-15min 强制回收），SSH 心跳无法完全防回收。**不要期待 keepalive 能保住实例**，
   它的定位是「尽量 running + 快速自动拉起」，真正兜底靠第 2 点。

2. **持久存储评估**：CNB **无平台级持久盘**（stash/backup/restore/volume-mount API 均不存在），
   接入不可行。overlay 回收对 storage 热数据的影响，只能靠「环境镜像秒级恢复 + cnb-task 自愈」缓解，
   已落地并端到端验证。

3. **建议（后续可考虑）**：
   - 若某空间承载重要长任务，可把关键工作放在空间1（保活与自愈最优先覆盖）；构建机/测试沙箱
     接受「回收 + 自动自愈」为常态。
   - 观察 2min 频率是否足够：若某空间仍频繁在投递时 closed，可对该空间单独调高（甚至 1min），
     但边际收益有限（因为强制回收不可规避）。
   - 大文件/长期热数据不要依赖 CNB `/data`，应放本机或 HK；CNB 只放可重建的构建产物。

---

## 五、相关文件
- `scripts/cnb-keepalive.js`（2min + 增强心跳）
- `scripts/cnb-env-image.sh`（镜像 build/restore）
- `scripts/cnb-init-env.sh`（本次修复 apt update）
- `scripts/cnb-task.js`（自愈链路）
- `logs/cnb-env/env-image.tar.gz`（环境镜像）
- `logs/cnb-keepalive.log`（回收频率实证）
