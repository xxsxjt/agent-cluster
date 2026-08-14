# 承诺性优化落地审计（口嗨审计）——2026-08-10

> 审计官：learning-officer
> 目的：回应用户"之前很多优化不全是口嗨？"——系统性盘点 8/1 以来承诺过的优化/规则/机制，逐条对照真实落地物，给三态判定。
> 数据源：主会话 jsonl（9380 行，grep 提取）+ AGENTS.md + conventions.md + evolution-drafts/ + PRODUCT-VISION + 真实文件/进程/配置核查。

---

## 一、判定标准
- ✅ **落地**：对应文件/代码/配置存在，且机制在运行（进程存活 / 配置生效 / 有产出物）
- ⚠️ **部分**：承诺主体落地，但有缺口（缺文件 / 依赖未齐 / 未生效）
- ❌ **口嗨**：只写进文档/口头承诺，无对应落地物，或一直处于 pending 无推进

---

## 二、❌ 口嗨清单（重点）

| # | 承诺（原话/来源） | 缺什么 | 严重度 |
|---|---|---|---|
| 1 | **共享资源锁/owner 登记**（conventions「资源冲突与资源锁」8/6 聊天室被互踩教训后承诺 `knowledge/resource-registry.json`） | 承诺的 **resource-registry.json 文件根本不存在**（全盘 find 无）。规则只写在 conventions，无落地的 owner 登记表与任务 writes/reads 声明校验 | 🔴 高 |
| 2 | **应急响应 skill**（pending 草稿 `incident-response-responder`：被黑/杀软失灵/弹窗应急方法论） | 一直停 in pending，**skill 未生成**（~/.pi/agent/skills 无 incident-response） | 🟠 中 |
| 3 | **经验传递管道**（pending `experience-pipeline-user-twin`：用户质疑"子 agent/管家没有被告知经验路径"，确认架构缺口：经验只对主会话可见，子 agent 是"无经验新人"） | 停 pending，**无落地物**。子 agent 至今仍看不到全局经验 | 🟠 中 |
| 4 | **codex 修复**（多份草稿列"codex 修复 opencodex websocket 426"为待办） | AGENTS.md 自己写明 **"codex 当前 broken 待修"**——8/1 列到 8/10 仍未修 | 🟠 中 |
| 5 | **butler-bridge 激活秘书窗口**（pending `butler-architecture` 声称已落地 butler-bridge.ts 激活机制） | **butler-bridge.ts 文件不存在**，仅残留 `.butler-bridge-seen.json`。激活秘书窗口的闭环未真落地 | 🟡 低 |

---

## 三、✅ 落地清单（已生效，按域分组）

### 指挥中枢与派活
| 承诺 | 落地物（已核） |
|---|---|
| 主会话=指挥中枢 + hub daemon | `hub/orchestrator.js` ✅，node 进程存活 |
| 派活不亲力亲为 / inbox 投递 | `hub/butler-daemon.js`（PID 1720 存活）+ `org/inbox/` 已产生 **215 个 .DONE** ✅ |
| 投递即回、不 sleep、turn 开始查队列 | AGENTS.md「主会话行为铁律」+ `hub/pending-main.jsonl` 存在 ✅ |
| 面板后台工具 | `hub/panel/panel.py` + **`hub/dist/ButlerHQ.exe` 已打包** ✅ |
| 关机/收尾 butler-check | `hub/butler-check.py` ✅ + `org/shutdown-after-done.js` ✅ |

### 路由与隐私
| 承诺 | 落地物 |
|---|---|
| 隐私铁律（可信渠道白名单） | AGENTS.md + `hub/model-router.js` ✅ |
| 智能路由用强模型大脑 + 经验留痕 | `hub/model-router.js` + `hub/routing-log.jsonl`（28KB，已积累）✅ |
| 路由经验库 | `hub/routing-log.jsonl` ✅ |

### 分身与自动化巡检
| 承诺 | 落地物 |
|---|---|
| 分身职责巡检（盯谁该有活） | `org/lib/twin-duty-inspector.js` ✅（分身 PID 33452 存活）|
| 定时职责调度 | `org/lib/auto-schedule.js` + `config/auto-schedule.json` ✅ |
| 长任务 watchdog 看护 | `org/lib/task-watchdog.js` + `config/task-watchdog.json` + state ✅ |
| 每日例会自动化 | `org/lib/daily-meeting.js` + `config/daily-meeting.json`，**已产出 08-09 全员例会文件** ✅ |
| 智能体 Backlog（该干没干） | `config/agent-backlog.json`（11 业务智能体）✅ |
| 自我繁衍机制 | `org/lib/org-evolution.js` + `config/org-evolution.json` ✅ |
| 对话即蒸馏 | `hub/chat-signals.jsonl`（33 条）+ `hub/merge-signals.py` + `hub/user-preferences.md` ✅ |
| 分身思维 user-twin | user-twin SKILL v3.1 ✅ |

### 多节点架构
| 承诺 | 落地物 |
|---|---|
| CNB 云开发节点接入 | `org/scripts/cnb-task.js` + `org.json` cnb-dev + `scripts/cnb-ctl.js` ✅ |
| 双集群/互联 | HK 部署 + 增量同步草稿 ✅ |

### 行为/规范类（conventions 明文落地）
| 承诺 | 落地物 |
|---|---|
| 外部项目参考先确认协议 | conventions「外部项目参考规范」明文 ✅ |
| 新组件上线防弹窗三查 | conventions ✅ |
| 文档格式禁用 markdown 符号 | conventions ✅ |
| 调研/排查三序 | conventions ✅ |
| 汇报格式"短标题+详情" | conventions ✅ |
| 通知走 APP 不走 SMTP | conventions ✅ |
| 杀进程禁用命令 | evolution approved `kill-process-cmd-set` ✅ |
| 端到端验证铁律 / 借鉴优先 | AGENTS.md ✅ |
| 微信图解密 | evolution approved ✅ |
| 安全邮件告警关闭 | conventions（SecurityDefenseEmailAlertsEnabled=false）✅ |
| Key 固化 | `~/.qoder/apis/` 目录已建 + `config/secrets-index.json` ✅ |

---

## 四、⚠️ 部分落地

| 承诺 | 现状 |
|---|---|
| Key 一律固化专用路径 | 目录在，但**只有 redfox.json 一个 key**，多数 key 未迁入（secrets-index 兜底） |
| daemon 开机自启 | butler/分身进程存活，但计划任务 schtasks 查询为空，**开机自启未确认生效** |
| 主会话读取 pending-main SOP | 已并入 AGENTS「主动收汇报」铁律（算落地），但 pending-main.jsonl 为空、读取链路未实测 |
| 三草稿（butler 架构/经验管道/应急响应） | 主体机制有但项缺失（见口嗨清单 2/3/5） |

---

## 五、最严重 3 条口嗨
1. 🔴 **资源锁 owner 登记表缺失**——8/6 聊天室被互踩是实打实教训，conventions 承诺了登记表却从未建，共享资源互踩风险仍裸奔。
2. 🟠 **codex 修复拖了 10 天**——8/1 就列为待办，AGENTS 至今写"broken 待修"，部署/数据域一直缺手。
3. 🟠 **应急响应 skill 停 pending**——安全事件应对没有可复用方法论，出事时只能现想。

---

## 六、建议（谁来做 / 优先级）

| 优先级 | 口嗨项 | 补落地动作 | 负责 |
|---|---|---|---|
| P0 | 资源锁 owner 表 | 建 `knowledge/resource-registry.json`，把聊天室模型/频道/共享配置登记 owner；任务书补 writes/reads 校验（可并入 task-watchdog） | learning-officer + night-worker |
| P0 | codex 修复 | 排查 opencodex websocket 426，或改路由绕开 codex 用 claude/opencode-go 承接部署数据域 | night-worker |
| P1 | 应急响应 skill | 把 pending 草稿终稿审批 → 生成 skill 并落 skills 目录 | pi-evolution / 分身审批 |
| P1 | 经验传递管道 | 设计子 agent 读全局经验的通道（开机注入 knowledge/ 索引） | night-worker |
| P2 | key 迁移 + 开机自启 | 批量迁 key 到 ~/.qoder/apis/；用 schtasks 重建开机自启并验证 | workspace / server-admin |

---

*结论：8/1 以来优化绝大多数真落地（指挥中枢/分身巡检/例会/watchdog/路由/隐私全链路可查可运行，inbox 215 个 DONE 为证）。真正的口嗨集中在"承诺了文件/表/skill 却没建"的少数几项，最严重的是资源锁登记表与 codex 修复。*
