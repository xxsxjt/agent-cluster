# 管理端 APP 分类整理——号池与智能体集群远控分区

**时间**: 2026-08-11 14:5x
**智能体**: xxsx-gateway（task: app-category-reorg）
**渠道**: aliyun-tokenplan

## 背景（用户 2026-08-11 14:5x）
"现在的分类很乱啊，号池和智能体集群远控混在一起"——管理端 APP 功能分类混乱，**号池管理**（账号池/渠道/额度——xxsx 的账号资源）和**智能体集群远控**（智能体/任务/集群状态）混在一起，需要分区整理。

## 一、现状盘点（v1.7.16 / versionCode 50）

底部 4 Tab：**对话 / 监控 / 告警 / 设置**。监控 Tab 是容器，顶部子切换 3 子页。

| Tab / 子页 | 承载 | 归属 |
|---|---|---|
| 对话 | AssistantFragment：智能体集群对话中心（管理员助手/选智能体/远控对话） | 集群 |
| 监控→集群状态 | OverviewFragment：智能体集群卡片（管家/分身/智能体/任务/渠道告警）+ 主机资源 + 托管服务 | 集群+系统 |
| 监控→服务器与账号池 | ServersFragment：**主服务器 + 智能体集群卡片 + Sub2API 号池（账号/渠道/额度/优化/导入）+ 受管服务器** | ⚠️ 五类混杂 |
| 监控→请求日志 | LogsFragment | 系统 |
| 告警 | AlertsFragment：分类 Tab（集群/号池/系统/渠道） | 已分区✓ |
| 设置 | MoreFragment：故障中心/安全检查/更新/模块开关/号池管理入口/账号导入跳转 | 公共+号池 |

**核心混乱点**：`监控→服务器与账号池` 一个页面塞了【主服务器、智能体集群、Sub2API 号池、账号导入、受管服务器】五类功能，号池与集群彻底混在一起。

## 二、分区方案（按领域）

### 号池区（账号资源）
- Sub2API Account Pool（账号/渠道/额度/订阅/计划/优化/同步/导入/回收站/配额）
- 号池告警（已有：告警页号池分类）
- 号池管理入口（Sub2AccountManagementSheet）

### 集群区（智能体集群远控）
- 智能体集群对话中心（对话 Tab）
- 集群状态卡片（管家/分身/智能体/任务/渠道告警）
- 集群文档
- 集群告警（已有：告警页集群分类）

### 服务器区（基础设施）
- 主服务器 / 受管服务器 / 主机资源 / 托管服务 / 请求日志

### 公共
- 设置（故障中心/安全检查/更新/模块开关/关于）
- 告警（保留，分类已清晰）

## 三、导航结构重排方案

**5 Tab：对话 / 集群 / 号池 / 告警 / 设置**（号池从监控子页提升为独立 Tab）

| Tab | 内容 | 领域 |
|---|---|---|
| **对话** | 智能体集群对话中心（原样） | 集群 |
| **集群**（原监控改造） | 集群状态（Overview）+ 服务器（Servers 瘦身：仅主服务器+受管服务器）+ 请求日志 | 集群+服务器+系统 |
| **号池**（新 Tab） | Sub2API 账号池 / 渠道 / 额度 / 订阅 / 优化 / 同步 / 账号导入 / 配额详情 | 号池 |
| **告警** | 分类告警（原样） | 公共（已分区） |
| **设置** | 维护与设置（原样） | 公共 |

**关键改动**：
1. 新建 `PoolFragment`（承载 Sub2API 号池全部逻辑，从 ServersFragment 拆出）
2. `ServersFragment` 瘦身：移除 Sub2API 号池 + 账号导入区块，只留【主服务器 + 受管服务器】
3. `OverviewFragment` 保留：集群状态卡片 + 主机资源 + 集群文档（集群区）
4. 底部导航 4→5 Tab，新增 `nav_pool`（号池）
5. 设置页号池管理入口 / 账号导入跳转 → 改指向号池 Tab（openPool）
6. 版本 v1.7.17（versionCode 51），合并上次 app-fixes-b 改动（已含在代码库）

## 四、功能零丢失保证
- 所有按钮/弹窗/导入逻辑原样迁移，仅换承载 Fragment
- 告警分类、对话中心、设置完全不动
- 外部账号导入（分享文件进 APP）通道：MainActivity PendingImport 兜底改为投递到号池 Tab

## 五、验证（模拟器禁用）
- 代码审查：编译 `:app:compileDebugKotlin` + `:app:assembleDebug` BUILD SUCCESSFUL
- dex 标记检查：PoolFragment / nav_pool / 号池 等
- 构建发布：管理端 v1.7.17 APK 部署 HK，`/api/mobile/admin/app-release` 返回 51/1.7.17
---

## 实施与发布结果（2026-08-11 15:0x）

### 实施完成 ✅
- 方案落地：`PoolFragment.kt`（1740 行，承载 Sub2API 号池全部逻辑：账号/渠道/额度/订阅/优化/导入/配额）从 ServersFragment 拆出
- `ServersFragment` 瘦身：仅保留【主服务器 + 受管服务器】基础设施（+ 服务类型识别），号池逻辑已迁往号池 Tab
- `OverviewFragment` 保留为「集群状态」子页（智能体集群卡片）
- 底部导航 4→5 Tab：**对话 / 集群 / 号池 / 告警 / 设置**
- `MainActivity` 接入 nav_pool → PoolFragment，openPool/openServers 指向号池；ModulePrefs 支持号池模块开关
- 版本 **v1.7.17（versionCode 51）**，含 app-fixes-b 已有改动

### 构建验证 ✅
- `:app:assembleDebug` **BUILD SUCCESSFUL**，APK 6557039B
- dex 标记确认：`1.7.17 (51)`（classes4）、`PoolFragment`（classes4/7）、`nav_pool`（classes2/7）、`ic_nav_pool`（classes2）

### 发布验证（HK 经 US 跳板，本机 Tailscale 挂）✅
- 上传 `/opt/xxsx-api/releases/xxsx-admin.apk`，HK sha256 `5e7e40ef…` == 本机一致
- manifest → 51/1.7.17（备份 .bak-v1716）
- app-release 本地 127.0.0.1:3461 → **HTTP 200 {version_code:51, version_name:1.7.17, sha256:5e7e40ef…}**
- 下载 sha256 == 本机一致（6557039B）
- 公网 api.xxssxx.top → **HTTP 200 51/1.7.17/sha 一致**
- 临时 token 已吊销（无残留）

### 功能零丢失
- 仅分类重组，不删功能；告警/对话/设置不动；外部账号导入投递到号池 Tab（PendingImport 兜底）
- 提交：`7e0549e feat(admin-app): 号池与智能体集群远控分区`
