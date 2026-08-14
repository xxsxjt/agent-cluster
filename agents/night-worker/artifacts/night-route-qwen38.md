# 夜间折扣路由恢复（22:00-8:00 → qwen3.8）+ 多模态看图默认

- **日期**：2026-08-11
- **执行**：night-worker（任务 night-route-qwen38）
- **用户指令**（2026-08-11 14:2x）："还记得之前的 22 点~8 点算作晚上，然后 qwen3.8 有折扣的事吗，现在也有，这个时间段一些复杂任务可以派给它，而且它是多模态模型"

## 改动清单

### 1. `org/lib/model-router.js`（核心）
- **恢复夜间窗口** `isNightWindow(now)`：本机时间 `22:00 <= t < 08:00`（`NIGHT_START=22` / `NIGHT_END=8`）。
- **夜间默认路由** `defaultRoute()`：夜间 → `aliyun-tokenplan/qwen3.8-max` · `thinking: max`（折扣价，复杂任务主力）；白天保持 → `opencode-go/deepseek-v4-flash` · off。
- **新增多模态路由** `visionRoute()`：看图/视觉任务 → `aliyun-tokenplan/qwen3.8-max` · max（**不分昼夜**，白天看图也用 qwen3.8——用户两次纠正：不用 mimo/opencode-go 免费池）。
- **新增视觉任务识别** `isVisionTask(text)`：命中 识别图片/看图/截图/图像分析/OCR/screenshot/image analysis 等关键词。
- 显式覆盖优先机制保持（任务头 `provider:/model:/thinking:` 仍最优先）。

### 2. `org/lib/spawn.js`（必要接线，让路由真实生效）
- pi 分支：无显式 `provider` 时，构建路由链 = `[当前默认路由(链头)] + FALLBACK_CHAIN 去掉同 provider` → `channelFallback.pickProvider(chain)`。
  - 白天链头 = opencode-go flash（同原默认）；夜间链头 = qwen3.8-max；看图链头 = qwen3.8-max。
  - qwen 冷却时自然落到 opencode-go 等健康渠道，不破坏渠道 fallback。
- 看图检测：`opts.vision === true || isVisionTask(prompt)` → base 用 `visionRoute()`。
- 显式 `opts.provider` 仍最优先（任务头覆盖）。

## 验证（全部通过）

**单元测试** `node test/model-router.test.js` → **13/13 全绿**
- 夜间 23:00/00:00/07:59 → night/qwen3.8-max·max
- 白天 08:00/14:00/21:59 → day/opencode-go/deepseek-v4-flash·off
- 边界：22:00 含（夜间）、08:00 不含（白天）
- 看图：visionRoute=qwen3.8-max·max；isVisionTask 命中/不误命中

**spawn.js 链路仿真（5 场景）**：
| 场景 | window | provider/model | thinking |
|---|---|---|---|
| 夜间普通 | night | aliyun-tokenplan/qwen3.8-max | max |
| 白天普通 | day | opencode-go/deepseek-v4-flash | off |
| 白天看图 | day | aliyun-tokenplan/qwen3.8-max（多模态不分昼夜） | max |
| 夜间看图 | night | aliyun-tokenplan/qwen3.8-max | max |
| 显式覆盖(夜间指定deepseek) | night | opencode-go/deepseek-v4-flash | off（显式优先✓） |

## 注意事项
- 已派发任务的显式渠道**未动**。
- 阿里 token-plan 为付费通道（曾 429），仅夜间复杂任务/看图默认启用；仍受渠道冷却保护。
- 生效需 butler 重启加载新代码（当前模型-router 被 spawn.js/twin-daemon/web 引用）。
- model-routing SKILL 的定时路由表注释与本次一致（白天全天 flash、细活 qwen），本次把夜间折扣窗恢复为默认复杂任务主力。
