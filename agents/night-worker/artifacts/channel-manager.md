# 渠道管理智能体（channel-manager）+ 智能恢复探测

日期：2026-08-08 18:1x
执行：night-worker（deepseek-v4-flash）

## 背景
用户 2026-08-08 18:0x 明确：①渠道切换要更智能化——高优先级渠道确认暂时不可用→切下一个→**冷却期后自动恢复探测**→恢复后切回；②管家组太简陋——渠道健康这类持续运营职责应有**专职智能体**负责，不是 butler 里一堆代码。

## 改动

### 一、恢复探测机制（lib/channel-fallback.js 升级）
在既有静态 fallback 链基础上新增**恢复探测**能力：

| 能力 | 实现 |
|---|---|
| 冷却渠道每 30 分钟轻量探测 | `PROBE_INTERVAL_MS=30min`，`probeCoolingChannels()` 扫描冷却/失败渠道，按 `probedAt` 节流（未到间隔跳过） |
| 探测方式 | `probeChannel(provider)`：`GET {baseUrl}/models`（极小请求，OpenAI 兼容端点统一） |
| 成功 → 恢复 | `markRecovered()`：`status=recovered` + `recoveredAt` + 清零失败/解除冷却 → `pickProvider` 自动切回高优先级 |
| 失败 → 继续冷却 | `coolingUntil = now + COOL_DOWN_MS`（延长），更新 `lastFailAt/lastError` |
| 端点/密钥 | `resolveProviderEndpoint()` 从 pi models.json **运行时读取**，不硬编码 key（OPSEC） |
| 留痕 | 探测结果写 `logs/channel-health.json` + `agents/twin/activity.log`（`[渠道]` tag） |
| 全挂联动 | `recordOutage` / `channel-outage.json` 逻辑**不变**，恢复探测不干扰 |

### 二、渠道管理智能体节点（channel-manager）
1. **org.json 新增节点**：id=channel-manager，label=渠道管理智能体，**parent=grp-coo**（管家组），spawnType=pi，keywords（渠道/模型路由/fallback/冷却/恢复探测/配额）
2. **`agents/channel-manager/identity.json`**：persona + 职责（巡查健康/恢复探测决策/决策留痕/与 fallback 链协作/汇报）+ 权限 + 限制（不硬编码 key、探测必须轻量、恢复须实测）
3. **`agents/channel-manager/AGENTS.md`**：职责边界、渠道链、工作机制（健康表/冷却与恢复/决策留痕/全挂告警）、常驻方式、关键命令、协作链路
4. **`agents/channel-manager/patrol.js`**：独立巡检脚本（`--force` 忽略 30 分钟间隔立即探测 / `--report` 只出报告不探测），决策写自身 `memory/diary.md`

### 三、常驻方式（双通道）
- **twin-daemon 巡查循环**：`lib/twin-daemon.js` runPatrol 新增 `scanChannels()` 步骤（每 5 分钟一轮，探测自身按 30 分钟节流）——分身常驻即负责调度本节点，无需单独 schtasks。
- **独立执行**：`node agents/channel-manager/patrol.js` 可手动/定时跑。

## 验证（全过）

| 场景 | 结果 |
|---|---|
| **A. 模拟 opencode-go 冷却**：fails=2 + coolingUntil → `pickProvider` 返回 aliyun-tokenplan（跳过冷却） | ✅ |
| **恢复探测**：`patrol.js --force` → 探测 /models 200 OK → `markRecovered`（status=recovered, recoveredAt） | ✅ |
| **路由切回**：恢复后 `pickProvider` 返回 **opencode-go**（高优先级） | ✅ |
| **B. 探测失败**（fake 渠道无端点）：`coolingUntil` 延长 + `probedAt` 记录 + status 保持 cooling | ✅ |
| **C. 30 分钟节流**：刚探测过的渠道（probedAt=now）常规巡检跳过（probes=0） | ✅ |
| **channel-manager 节点出现在控制台**：`/api/state` 含 channel-manager + 渠道管理智能体，grp-coo children 包含它 | ✅ |
| **巡查/决策活动记录**：`agents/twin/activity.log` 有 `[渠道恢复]` 留痕 + 自身 diary.md 落盘 | ✅ |
| **twin-daemon 加载新代码**：重启后 `--once` 巡查显示"inbox/进程/安全/**渠道**" | ✅ |

## 产出
- `lib/channel-fallback.js`（改：+ 恢复探测 probeCoolingChannels/probeChannel/markRecovered + PROBE_INTERVAL_MS）
- `agents/channel-manager/`（新增：identity.json + AGENTS.md + patrol.js + memory/diary.md）
- `org.json`（改：grp-coo 加 channel-manager 节点）
- `lib/twin-daemon.js`（改：runPatrol 挂入 scanChannels 恢复探测）

## 注意
- **butler.js 的 fallback 控制器本身（model-fallback-chain）未改**——本次只新增"恢复探测 + 专职智能体"。fallback 切换执行逻辑保持原样。
- twin-daemon 已重启（PID 37132）加载新代码；web server 实时读 org.json，控制台无需重启即显示新节点。
- 探测是真实 HTTP 请求（/v1/models，极小），但仅对**冷却/失败**渠道且按 30 分钟节流，不烧额度。
