# auto-optimize 噪音治理复盘（learning-officer）

- 任务：`nextday-2026-08-11-auto-optimize-噪音治理复盘`
- 执行：learning-officer
- 时间：2026-08-11
- 数据源：`org/logs/auto-optimize.jsonl`（实测 82 条决策记录；任务清单口径"85 条 pending"，含状态文件待处理决策，统计口径略异，不影响结论）

---

## 一、复盘范围

auto-optimize 机制定义（见 `inbox/auto-optimize.md`）：任务失败 ≥ optimizeThreshold(2) 次 → 自动执行 **换渠道 / 换执行者 / 任务拆小 / 环境自查** 四类优化，决策留痕到 `auto-optimize.jsonl`，并以 `prepareRerun` 重新派发回 inbox，形成"失败→自动修复→重跑→验证"闭环。目标 = 用户要的**越用越聪明**（"不要人工盯，异常要自动优化"）。

本次复盘 82 条实际决策记录，逐条归类，确认哪些是**有效机制**（沉淀保留），哪些是**噪音**（需治理）。

## 二、数据概览

| 维度 | 统计 |
|---|---|
| 总记录 | 82（type: auto-optimize 78 / channel-cool 3 / prod-verify 1） |
| 决策类型 | 换执行者 78 / 任务拆小 73 / 渠道冷却 3 |
| 失败原因(reason) | **进程异常中断(pid已死) 63** / 疑似卡死(日志20min未更新) 12 / test·self-test 5 / prod-verify 1 / 空 1 |
| 渠道冷却 | opencode-go 2 / aliyun-tokenplan 1（均正确触发，切下一渠道） |
| 兜底到 learning-officer | 14 条（coo/reviewer/channel-manager/intel-gatherer 等跨域失败任务） |
| 失败来源执行者 | xxsx-gateway 17 / night-worker 17 / workspace 6 / server-admin 5 / coo 5 / reviewer 5 / … |
| 时间分布 | 08-10 共 7 / 08-11 共 75 |

## 三、有效机制确认（"越用越聪明"沉淀保留 ✅）

以下机制经复盘确认为**真实有效、应保留**的核心能力：

1. **换执行者链路有效** ✅
   失败 ≥2 次任务按 `config/auto-optimize.json` 的 `fallbackChains` 自动切同域/配置链兜底执行者（如 night-worker→workspace、xxsx-gateway→workspace），且 `prepareRerun` 把任务重新写回 inbox 排队重跑，形成真实闭环。多任务由此被自动救活，无需人工介入。

2. **渠道冷却打通有效** ✅
   opencode-go / aliyun-tokenplan 连续失败被自动冷却（channel-cool，冷却后路由自动切下一渠道），`channel-fallback` 冷却留痕完整。这是"异常渠道自动降级"的核心，保留。

3. **环境自查真实发现资源问题** ✅
   `envSelfCheck` 检测到 night-worker / workspace 的 sessions 体积超阈值（46.4MB / 50MB > 40MB）→ 触发归档动作。这是**真实资源告警**，非噪音，应保留并考虑放大到所有执行者。

4. **决策留痕 + 重新派发 = 闭环** ✅
   每笔决策落到 jsonl（含 failCount/动作/结果/reason），配合 inbox 重派发与 review-loop 每口复核，机制完整。

**结论**：核心机制成立，方向正确，符合用户"越用越聪明、不要人工盯"的诉求，予以沉淀保留。

## 四、噪音识别与治理建议（本次复盘核心产出）

复盘发现 **4 类噪音**，建议按优先级治理：

### 噪音 A：测试/自检记录混入生产 jsonl（6 条）⚠️ 高优先
- 现象：`autoopt-test-*`、`self-test`、`prodverify`、`生产化验证` 等测试触发记录写入 `auto-optimize.jsonl`，污染真实决策数据。
- 危害：生产决策日志被测试数据稀释，后续按 jsonl 做的统计/学习失真。
- **治理**：测试/自检触发时打独立 `test: true` 标记或写入 `auto-optimize-test.jsonl`，生产 jsonl 只保留真实任务失败决策；统计侧过滤 `reason in (test, self-test)`。

### 噪音 B：单一 reason"进程异常中断(pid已死)"占 77%（63/82）⚠️ 高优先
- 现象：绝大多数触发 reason 都是"进程异常中断（pid 已死）"，高度模式化。
- 危害：**高度怀疑 watchdog 误判**——agent 进程正常完成任务退出、pid 消失，被当成"异常中断"触发 auto-optimize，导致大量无意义"换执行者+任务拆小"刷屏（73 次 task 拆小几乎全覆盖）。
- **治理**：触发前增加**真实性校验**——pid 消失 ≠ 失败：若任务已产出 `.DONE`/产物/正确退出码，则不算异常、不触发优化；只有"pid 消失 且 无 .DONE 且 无产物"才算真失败。这是最大的一笔噪音削减。

### 噪音 B'：prepareRerun 的 `recCount+1` 放大误判（根因定位，高优先）
复盘 jsonl 与 `logs/recovery-count.json` 交叉核对，**精确定位到代码级根因**：
- **证据**：10:32-10:34 批量触发的 62 个任务中，`recovery-count` 实际值 **61 个=1**、仅 1 个=2；但 jsonl 记录 `failCount` 全为 2/3，全部达到阈值触发优化。
- **根因**：`lib/auto-optimize.js` 的 `prepareRerun`（约 line 326）`failCount: recCount(name) + 1` —— **每次重跑强制 +1**。于是真实只失败 1 次（recovery-count=1）的任务，一旦被判定需要重跑就 `+1 → 2`，越过阈值触发整条优化链。
- **后果**：结合 10:32 的一次批量进程异常（62 任务同时 pid 已死），62 个仅失败 1 次的 Improve 复跑任务被**集体误判为连续失败 2 次**，触发 62 次"换执行者+任务拆小"，全部改写 inbox 任务文件 agent 头（抽查确认含 `auto-opt-orig` 标记，如 reviewer→learning-officer、night-worker→workspace）。这是本次批量噪音的直接推手。
- **治理（代码级）**：`prepareRerun` 不再裸 `+1`，而应按真实失败语义计数（如读取健康表/退出码/`recovery-count` 本身，仅在确认真失败时累加），且与 `check()` 的 `recCount` 口径统一；避免"重跑动作本身"把 1 次失败放大成 2 次。
- 说明：噪音 B（pid 真实性校验）解决"误判是否算失败"，噪音 B'（+1 逻辑）解决"失败 1 次为何触发"，两者叠加才能真正消除这 77% 的批量噪音。

### 噪音 C：兜底目标单一化，learning-officer 成"垃圾回收站"（14 条）⚠️ 中优先
- 现象：coo/reviewer/channel-manager/intel-gatherer 等**跨域**失败任务被统一兜底到 learning-officer。
- 危害：learning-officer 非这些域的专职执行者，跨域兜底大概率执行质量/语义不匹配；且集中兜底会造成单点堆积。
- **治理**：兜底应**按任务类型/域匹配**专职执行者（review 域→reviewer 链、运维域→system-ops 链），只有同域链耗尽才允许跨域兜底；`fallbackChains` 需补充各域专属链，避免全部收拢到一个通用执行者。

### 噪音 D：任务拆小模式化全覆盖（73 次）🟡 低优先
- 现象：几乎每个失败任务都被"任务拆小"（分步小目标）。
- 危害：拆小决策模式化，未区分任务是否真适合拆小，可能把简单任务不必要地拆碎。
- **治理**：拆小前判断任务是否**多步骤/含多文件**（当前对 review-batch 等批量任务合理），单步任务跳过拆小，减少无意义决策噪音。

## 五、建议落地归属

- 噪音 B（pid 真实性校验）与噪音 A（测试隔离）：**butler / auto-optimize.js** 侧修改，最高优先，直接削减大部分噪音。
- **噪音 B'（prepareRerun 的 recCount+1 放大误判）**：`auto-optimize.js` `prepareRerun` 失败计数口径修正，最高优先，是批量噪音（62 条同分钟刷屏）的直接代码根因。
- 噪音 C（兜底按域）：**config/auto-optimize.json fallbackChains** 扩充各域专属链。
- 噪音 D（拆小判断）：`auto-optimize.js` optimizeTask 增加步骤数判定。
- 本轮仅**复盘+沉淀**，机制代码改动不在此任务范围，建议另派 `auto-optimize-noise-fix` 落地（重点：B 真实性校验 + B' 计数口径修正，双管齐下消除 77% 批量噪音）。

## 六、结论

- **有效机制确认**：换执行者闭环、渠道冷却、环境自查、决策留痕 = "越用越聪明"核心，**沉淀保留**。
- **噪音治理**：识别 4 类（测试混入/pid 误判/兜底单一/拆小模式化），其中 **pid 误判（77%）是最大噪音源**，治理后可让 auto-optimize 从"高频刷屏"收敛为"精准触发"。
- 治理后机制将更聚焦：只在**真实失败**上自动优化，回归用户"越用越聪明、不刷屏不误报"的预期。
