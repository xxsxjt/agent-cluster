# 模型渠道自动 fallback 链（model-fallback-chain）

日期：2026-08-08 00:5x
执行：night-worker（deepseek-v4-flash）

## 背景
用户 2026-08-08 00:5x 明确：主模型 deepseek-v4-flash 渠道优先级，第一渠道调用错误**多次**、确认暂时不可用后换下一个：
1. **opencode-go**（优先）
2. **aliyun 0731 版**（aliyun-tokenplan / deepseek-v4-flash-0731）
3. **商汤**（xxsx / deepseek-v4-flash）
4. **deepseek 官方**（deepseek / deepseek-v4-flash）
5. 1-4 全挂 → **管理端软件通知**（管理端待确认，先做钩子）

## 现状痛点
- `lib/model-router.js` 有 day/dayAli/smallSense 路由表，但**无自动 fallback**——spawn 一次失败就失败（今天 403 全卡 opencode-go）
- pi 内部只有 auto_retry（同渠道重试），无渠道级切换

## 改动

### 1. 新增 `lib/channel-fallback.js`（fallback 核心）
- `FALLBACK_CHAIN`：opencode-go → aliyun-tokenplan(-0731) → xxsx → deepseek 官方（含各自 model/thinking）
- 健康状态持久化 `logs/channel-health.json`：`{ provider: { fails, lastFailAt, lastError, coolingUntil } }`
- `pickProvider(chain)`：返回链上第一个**健康（未冷却）**渠道；全冷却 → 兜底 chain[0]
- `markFailure(provider, err)`：fails+1，**达阈值 RETRY_THRESHOLD=2 进入冷却 COOL_DOWN_MS=10min**，pickProvider 自动跳过 → 自然切下一个
- `markSuccess(provider)`：清零失败 + 解除冷却
- `recordOutage(task, chain, attempts)`：写 `logs/channel-outage.json`（事件行）+ `activity.log [告警]` + 触发预留 `setNotifier` 钩子（管理端待确认后接入）

### 2. `lib/spawn.js` — pi 分支默认渠道走 fallback
- 无显式 provider 时：`channelFallback.pickProvider()` 取默认链起始渠道（跳过冷却渠道），替代硬编码 opencode-go
- 显式 provider 尊重显式渠道（model 未给时用 route.model）

### 3. `butler.js` dispatch — pi 任务渠道 fallback 控制器
- 非 pi（claude/hermes/node）保持单次 spawn（无渠道切换概念）
- pi 任务：构建渠道链（默认任务=FALLBACK_CHAIN；显式 provider=单元素链）
- `tryNext()` 递归控制器：
  - 每渠道连续失败 N 次（冷却）→ 自然切下一个
  - exit 时无 .DONE（进程异常/403/5xx/连接错）→ `markFailure` → 重试本渠道或切换
  - exit 有 .DONE 非 FAILED → `markSuccess` 成功终止
  - exit 有 .FAILED（agent 业务失败）→ **不触发渠道切换**，直接终止（区分业务失败与渠道故障）
  - 全部渠道失败（attempt 达上限 chain.length*2+1）→ `recordOutage` 全挂告警
- 每次 launch 更新 active entry（channel 字段标注当前渠道），pidPath/org.json 状态在最终结束才清理

## 验证（全过）
用健康标记文件强制驱动，未真耗订阅：
1. 初始健康 → pick = `opencode-go/deepseek-v4-flash`（正常不用切换 ✅）
2. opencode-go 连败 2 次 → 冷却 → pick = `aliyun-tokenplan/deepseek-v4-flash-0731` ✅
3. aliyun 连败 2 次 → 冷却 → pick = `xxsx/deepseek-v4-flash` ✅
4. xxsx 连败 2 次 → 冷却 → pick = `deepseek/deepseek-v4-flash`（官方兜底）✅
5. deepseek 也连败 → 全冷却 → 兜底 chain[0]，控制器 attempt 达上限 → `recordOutage` 触发（notifier 钩子 YES，outage.json + activity.log [告警] 落盘）✅
6. `markSuccess` 清零 + 解除冷却 → opencode-go 恢复 ✅
7. 控制器全流程模拟：每渠道重试 2 次→切下，最终全挂 → OUTAGE 告警 ✅

语法检查：channel-fallback.js / spawn.js / butler.js `node --check` 全过。

## 产出
- `lib/channel-fallback.js`（新增）
- `lib/spawn.js`（改：默认渠道走 fallback 链）
- `butler.js`（改：pi 任务渠道 fallback 控制器）

## 待办 / 注意
- ⚠️ **butler 需重启才生效**（当前 butler PID 44884 运行中，加载的是旧代码）。本次未重启以免中断在跑任务（含本任务自身）。建议下个空档重启。
- 管理端通知：`setNotifier(fn)` 钩子已预留，等待用户确认管理端软件后接入真实通知。
- 显式 provider 任务保持原样（尊重显式渠道，失败按同一渠道重试 N 次后终止，不跨渠道）——符合"先做默认链，显式保持原样"。
