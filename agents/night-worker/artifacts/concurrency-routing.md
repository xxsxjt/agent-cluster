# 任务并发限制 + 类型路由（concurrency-routing）

日期：2026-08-11（night-worker）
需求：管家并发无限制（67 任务同时记录 / 87 个 RPC 进程压垮本机）→ 加并发限制 + 类型路由，超负载任务转到云开发环境（CNB/HK）。

## 一、管家并发限制（butler.js）
- **配置**：`config/butler.json` → `maxConcurrent`（默认 3）。本机同时最多跑 N 个任务，其余排队。
- **排队机制**：
  - 派发前检查本机活动任务数（`localActiveCount()`，只统计跑在本机的任务；hk/cnb 远程桥不计入本机并发）。
  - 本机满额 → 新任务写 `logs/waiting-tasks.json` 排队表（不派发），下一轮 scanInbox 活动数下降自动补派（任务文件仍留 inbox，天然可重扫）。
  - 排队任务登记一次（`waiting` 表去重），避免每轮重复刷日志。
- **优先级**：紧急任务优先补位
  - `priority: urgent`（任务头显式标记）> 用户直投（非自动派发前缀）> 自动派发（checkpoint/review/复盘/巡检/daily-meeting/intel-collect）。
  - scanInbox 先按优先级对 inbox 文件排序 → 有空位先派紧急任务，不让自动派发插队。
  - 紧急任务**不受并发限制卡死**（排序优先 + 不因满额永久排队，活动降即补）。

## 二、任务类型路由（route-auto.js + butler.js）
- **任务分类**（任务头 `side: local|remote|auto` + 关键词识别）：
  - `local`（本机代码/文件操作）→ 本机跑（受并发限制）。
  - `remote`（纯推理/信息收集/复盘/构建）→ 远程执行。
  - `auto`（默认）→ 按关键词自动判：构建→cnb、服务器→hk、汇报/推理/信息收集→remote、其余→local。
- **remote 降级链**（`pickRemoteFallback()`）：CNB 优先 → HK → 本机兜底（不丢任务）。
  - 用 node-load 探测 CNB1/HK 可达性（unknown=false 即可达），CNB 断则降 HK，全断则本机兜底。
- **默认落地规则**：intel-collect/review/daily-meeting/复盘/巡检/信息收集 汇报类 → remote；butler/代码修改 → local。

## 三、改动文件
1. `config/butler.json`（新建）— maxConcurrent=3 + remote 路由配置。
2. `lib/route-auto.js` — 新增 `REMOTE_MARKERS` + `side: local|remote|auto` 显式标记支持 + `pickSide` 返回 `'remote'`。
3. `butler.js`：
   - parseTask 增 `side`/`priority` 字段解析。
   - `butlerCfg()`/`maxConcurrent()`/`localActiveCount()`/`isAutoDispatch()`/`isUrgentTask()` 辅助。
   - `nodeReachable()`/`pickRemoteFallback()` 远程降级链。
   - `routeTask()` 支持 `side==='remote'` → 降级链。
   - `scanInbox()` 并发排队块 + 优先级排序。
   - `WAITING_TABLE`（logs/waiting-tasks.json）。
4. `scripts/restart-butler-concurrency-routing.ps1`（新建）— 重启但管家加载新钩子（等待 active 收尾）。
5. `test/concurrency-routing.spec.js`（新建）— 15 用例验证脚本。

## 四、验证
- **route-auto 分类**：9 场景全过（intel-collect→remote、复盘→remote、gradle→cnb、ssh→hk、改代码→local、side:local→local、side:remote→remote、win打包→local、例会→remote）。
- **并发排队模拟**：投 5 个普通任务 → 首轮只派 3 个、排队 2 个；完成 1 个后自动补 1 个（派 4 剩 1）。
- **紧急优先 + 远程不占并发**：urgent-fix 优先派发、cnb-build（远程）照派不占本机名额、checkpoint/review 自动派发排队。
- **remote 降级链**：CNB1 可达→cnb；CNB 断→hk；全断→local（兜底本机，不丢任务）。
- **spec 脚本**：`node test/concurrency-routing.spec.js` → 15/15 通过。
- **语法**：`node --check butler.js && node --check lib/route-auto.js` 通过。

## 五、生效方式（⚠️ 必须重启但管家）
- 但管家当前 PID 25720 跑的是旧代码，**需重启才加载并发限制 + 路由钩子**。
- 重启脚本：`scripts/restart-butler-concurrency-routing.ps1`（自动等 active 任务收尾 → kill → bootstrap start）。
- 重启后验证：投 5 个任务观察 `[并发排队]` 日志 + `logs/waiting-tasks.json`；投推理类任务观察路由到 CNB（`logs/<name>.cnb.log`）。

## 六、注意
- 并发限制**不卡死紧急任务**：用户直投（非自动派发前缀）排序优先，`priority: urgent` 最高优先。
- CNB 路由失败自动降级 HK/本机（不丢任务）。
- 禁止全盘 find：本任务全程用定向 grep/read，未做全盘扫描。
- 临时测试文件已清理（inbox 无 conc-test 残留、waiting 表已清空）。
