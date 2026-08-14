# agent-rescue-core — 智能体互救机制 + 分身核心监督（2026-08-12）

> 用户 2026-08-12 核心理念落地："一个进程出 bug 卡死很正常，需要另一个智能体去帮它……我要的是完善你本身以及其他智能体，干活不重要"
> 执行：night-worker（provider: opencode-go / deepseek-v4-flash / max thinking）
> 状态：✅ 已落地 + 自检 13/13 通过 + 真实链路端到端验证通过

---

## 一、核心理念 → 机制映射

| 用户理念 | 机制落地 |
|---|---|
| **互救≠重跑**：卡死要让另一个智能体去救（诊断/修复/接管），不是同智能体失败重跑 | `lib/agent-rescue.js`：救援任务 = 救援者**诊断日志→修复环境→接管产出**；重跑只是救援链之前的快路径，互救链接管后续 |
| **管理组的意义 = 救其他智能体** | 救援者选择：**同域智能体优先**（懂上下文）→ 管理组兜底（coo/night-worker/reviewer/pm） |
| **分身核心监督**：待命不是摆设，异常→自主决策派救援 | `twin-duty-inspector.scanAgentRescue`：扫描智能体反复失败信号 → 分身自主决策派救援者 → 决策留痕 `logs/twin-rescue-decisions.jsonl` |
| **用户甩手**：异常不打扰用户，救援失败才升级 | 救援成功 → 闭环静默（仅 activity + rescue-log 留痕）；救援耗尽/超时 → 才升级用户 |
| **自我完善**：每次暴露问题→机制代码改进 | 救援成功根因 → 自动追加 `knowledge/corrections.md` 台账 + `chat-signals.jsonl` 进化信号（learning-officer 合并） |

## 二、互救链完整路径（异常失败 → 升级用户）

```
异常检测（已有，复用）
  ├─ task-watchdog：静默询问（10min 无输出 → 问进度）        [发现层]
  ├─ butler.checkActive：PID死/日志停滞20min → 标记失败      [判定层]
  └─ auto-optimize：同任务级优化（换渠道/换执行者）           [优化层]

互救链（新增 agent-rescue）
  ① 自动重跑（快路径，MAX_RERUN=2 次，已有）→ 仍失败
  ② launchRescue()：选救援者（同域兄弟 → 管理组池）
     → 写 inbox/rescue-<task>-<stamp>.md（诊断→修复→接管要求）
     → 状态 rescuing，记录 rescue-log（谁救的/怎么救的）
  ③ 救援完成（.DONE）→ 标记 rescued，闭环不打扰用户
     → 救援根因沉淀 corrections 台账 + chat-signals 进化信号
  ④ 救援失败（.FAILED）→ 换救援者再救一次（maxRescuersPerCase=2）
  ⑤ 救援耗尽/超时（120min）→ escalateToUser：分身决策留痕 + 升级用户

分身监督（twin-duty-inspector.scanAgentRescue，每 5 分钟巡检）
  扫描 scanHealth()：recovery-count + 近期 .FAILED → 某智能体连续失败 ≥2
  → 分身自主决策：自动派管理组救援者诊断该智能体（agent-<id>-health 救援案例）
  → 决策留痕 twin-rescue-decisions.jsonl（signal=agent-repeated-failure）
  → 节流：同批异常 1 天只决策一次（防骚扰）
```

## 三、新增/改动文件

| 文件 | 内容 |
|---|---|
| `lib/agent-rescue.js`（新增） | 互救引擎：launchRescue / check / scanHealth / pickRescuer / recordRescue / recordTwinDecision / selfImprove / selfTest |
| `config/agent-rescue.json`（新增） | 互救配置：rescueAfterReruns=1、rescuerPool、rescueTimeoutMin=120、maxRescuersPerCase=2、healthFailThreshold=2、privateAgents 隐私路由 |
| `butler.js`（改动） | ①autoRerunTask 重跑达上限 → **先启动互救链**（不再直接升级用户），救援未启动才退回原升级路径 ②主循环注册互救巡检（每 5 分钟 check 救援案例） |
| `lib/twin-duty-inspector.js`（改动） | scanDuties 新增 `scanAgentRescue`（分身监督互救）；导出 scanAgentRescue |
| `config/duty-inspector.json`（改动） | 新增 agentRescue 配置段（healthRescueThrottleMin=1440） |
| `logs/rescue-cases.json`（运行态） | 救援案例状态表 |
| `logs/rescue-log.jsonl`（运行态） | 救援记录（谁救的/怎么救的/结果） |
| `logs/twin-rescue-decisions.jsonl`（运行态） | 分身决策留痕 |

## 四、验证结果

### 4.1 内置自检（node lib/agent-rescue.js self-test）—— 13/13 ✅
```
✅ 智能体卡死 → 救援派发成功（救援者≠受害者）
✅ 救援任务文件已写入 inbox/，内容含「诊断→修复→接管」要求
✅ 救援者不会选 twin（分身只决策不干活）
✅ 同案例进行中重复触发 → 幂等跳过
✅ 救援完成 → 案例标记 rescued（闭环，不打扰用户）
✅ check() 返回 resolved 列表含该任务
✅ 救援记录已写入 logs/rescue-log.jsonl（谁救的/怎么救的）
✅ 自我完善：救援根因已追加 corrections 台账
✅ 救援失败 → 案例标记 escalated（升级用户，分身决策留痕）
✅ check() 返回 escalated 列表含该任务
✅ 分身决策留痕已写入 logs/twin-rescue-decisions.jsonl
✅ activity 留痕 [互救] 升级用户
✅ 智能体健康检测：连续失败 ≥ 阈值 → 识别出异常智能体
```

### 4.2 真实链路端到端模拟（不用用户）✅
- 模拟 cnb-test 任务卡死（重跑 2 次仍失败）→ 救援派发 → 救援者**自动选中 server-admin**（cnb-test 同域兄弟，非兜底 coo，证明同域优先生效）→ 模拟救援者完成（根因=CNB 空间回收环境丢失，动作=重建环境+重构建）→ check 标记 rescued，**未升级用户**（互救成功静默闭环）
- 模拟 mc-dev 反复失败 → 救援者选中 auto-bots（grp-dev 同域兄弟）→ 同域优先再次生效
- 模拟 workspace 连续失败 12 次 → scanAgentRescue 分身监督 → 自动派 coo 救援 agent-workspace-health + 决策留痕 `twin-rescue-decisions.jsonl`（signal=agent-repeated-failure）

### 4.3 回归
- `node --check` 三文件全部通过（butler.js / twin-duty-inspector.js / agent-rescue.js）
- twin-duty-inspector 自检 7 场景：6 场景全过；**场景7（takina 按需豁免开关）失败为既有问题**（git stash 后原样失败，与本次改动无关，建议另行排查）
- 真实环境 scanHealth → "无智能体连续失败异常"；check → 无动作（干净基线）

## 五、发现的问题（顺手报告）

1. **twin-duty-inspector 场景7 自检失败（既有）**：关闭按需豁免后 takina 未恢复 stale 派活。与本次改动无关，但说明"关豁免→恢复派活"逻辑可能失效（onDemandExempt 开关语义待查）。
2. **corrections 台账首次自检污染**：self-test 早期版本会把模拟数据写进真实 corrections.md（已修复为测试路径注入 + 已清理残留）。教训：**自检必须测试路径隔离，禁止写真实台账**。

## 六、后续建议

1. **HK/CNB 远程任务互救**：当前救援任务走本机 inbox；远程任务（hk/cnb 桥）救援文件需同步到远端执行（参考 hk-task.js / cnb-task.js 桥接，可扩展 rescue 任务远程侧执行）
2. **救援者技能化**：管理组救援者（coo/reviewer/pm）可沉淀"救援 SOP"到 identity/persona（先诊断后修复再接管，不满足于重跑）
3. **升级用户通知打通 HK 告警**：当前 escalateToUser 写 activity + 决策留痕；可再接 scripts/hk-alert.js 推 APP 通知（用户甩手时最后一道）
4. **场景7 既有失败**列入例会待验证项排查
