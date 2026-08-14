# 框架规则（conventions.md）

> 维护者：学习进化官（learning-officer）
> 本文件 = 组织运行公约。与 AGENTS.md/work_record 冲突时，以用户最新实时指令为准，并更新本文件。

## 路由规则

0. **免费池思考常开（2026-08-04 用户批评）**：free 池零成本，思考代价只是延迟不是钱——支持思考的免费模型一律开思考，不许机械省（"拒绝僵硬机制，有 free 就放开用"）；只有真付费渠道才权衡思考成本
1. **路由默认值非强制**：model-router 的默认路由只是"默认值"，任务书头部显式声明 `provider:` / `model:` / `thinking:` 时以显式声明为准
2. **opencode-go 只跑 flash**：opencode-go 渠道路由只用 deepseek-v4-flash，重活不走 go 端点（省配额/稳定）
3. **优先级**：opencode free（本地 omniroute）→ opencode go → aliyun-tokenplan qwen3.8；deepseek 官方默认不用（用户 8/4 指令）
4. **qwen3.8-max 只做细活**：preview 已下架（2026-08-06），正式版非低价——杂活/重活/批量默认 deepseek-flash（opencode-go），qwen3.8-max 仅任务头显式指定时用于精细任务
5. **路由经验留痕**：路由决策记 hub/routing-log.jsonl，供 ai-router 学习；调度大脑（任务路由/模型选择）用强模型（deepseek-v4-pro:medium 级），不因省钱降智

## 权限与数据

1. **隐私铁律（2026-08-08 放宽版）**：微信聊天数据 / user-profile 内容 / 个人身份账号信息——允许**可信渠道**读取：①正规大平台（deepseek 官方 / opencode / 阿里云 token-plan）②用户自有基础设施（XXSX 自建中转，自己的服务器自己的 key）；**禁止的是别人的第三方小中转/不明第三方**（molifangapi、sub2-luna、omniroute-free 匿名池、freemodel 等）。不要死守"只走 deepseek 官方"（8/8 用户明示）；自己的东西永远可信。其他模型调用时上下文剥离敏感数据
2. **外部操作 OPSEC**：非白帽授权目标的探测/扫描/爬取 → 操作前询问用户是否走代理（Webshare）
3. **全局知识库写权限**：org/knowledge/ 只有 learning-officer 可以写；其他智能体发现新知识 → 写自己 diary 或投递提醒任务
4. **组级记忆**：org/groups/<组id>/memory/group-diary.md 组内共享，组内智能体可写

## 记忆规范（树形继承：全局 → 组 → 个人，后覆盖前）

1. **专属记忆**：`org/agents/<id>/memory/diary.md` —— 每次会话结束追加 3-5 行（本次任务/结果/新经验/踩坑），私有
2. **自动整理**：diary 超 20 条 → 压缩成 `auto-notes.md` 长期要点，diary 清空重开（可让 learning-officer 代做）
3. **坑上报三级**：踩坑 → ①写自己 diary（必须）→ ②组级通用 → 组 group-diary.md → ③全局通用 → knowledge/pitfalls.md
4. **读取顺序**：全局 knowledge/ → 组 group-diary → 个人 diary（后覆盖前）
5. **监督**：learning-officer 抽查 diary 纪律，连续没写 → 提醒

## 任务规范

1. **任务拆小原则**：一个任务文件只做一个目标；多目标拆多个 `<name>.md` 顺序投递
2. **任务书格式**：头部 `agent:` / `group:` 声明路由；内容含 目标/文件/步骤/验证
3. **并行控制**：同渠道任务排队（等 .DONE 再投），总并行 ≤2-3，防 429/打爆
4. **完成标记**：`inbox/<name>.DONE` 一行摘要；失败写 `.FAILED: <原因>`
5. **投递格式**：`tasks/<name>.md` → 实际投递目录是 `org/inbox/`（butler 扫描）

## 组织树规则（v5）

1. 分支继承：子节点继承父节点全部上下文/工具/知识/人格
2. 组下可再分组（理论无上限）；不用的智能体休眠保留不归档
3. 主会话=数字分身（唯一交互入口），管家=COO 下属智能体；下属不得插嘴打断用户与分身交流
4. 框架（AGPL-3.0 可开源）与分身人格（user-twin，不开源）解耦
5. 管家域（grp-coo）= 管家本体 + 学习进化官 + 框架开发 + 业务域组（2026-08-05 重构）

## 智能体自我繁衍机制（2026-08-09 用户明示架构理念）

1. **理念**：项目大到单个智能体难以全盘熟知时 → 智能体主动申请在自己当前分组下创建子分组 + 给自己创建子智能体（分身）→ 分配处理任务 → 父智能体升格组长协调。集群要"活"，智能体有主动性、讨论、执行
2. **流程**：自评(evaluate)→写申请(inbox/reproduce-<agent>.md)→分身大脑审批(scanDecisions→user-twin)→管家执行(org.json 建子分组+子智能体+父 role→coordinator)→全程留痕(activity [繁衍])
3. **实现**：`lib/org-evolution.js`（主模块）+ `config/org-evolution.json`（规则：throttleDays=7 / maxChildren=4 / pendingThreshold=3）；挂入 `lib/twin-duty-inspector.js` scanDuties，分身每 5 分钟巡查自动扫描申请与处理决策
4. **防滥用**：①必须分身大脑审批（红线升级用户）②申请必附分工方案（缺则驳回）③同智能体 7 天节流④单次最多 4 子智能体
5. **路由兼容**：子分组 parent=父智能体所在分组（如 grp-dev→grp-dev-mc-dev-mods），keywords 继承父分组 → 子智能体仍属原域，任务按域路由命中，不破坏路由
6. **真实拆分需确认**：生产智能体（如 mc-dev）真正繁衍必须用户/分身通过正常审批确认后再落盘，测试/演示产物用后须还原 org.json（删节点、还原父 role/children、删 agent 目录）
7. 详细文档：`artifacts/org-evolution.md`

## 启动与运维

1. 启动：`bash xuwu.sh start|stop|restart|status`（bootstrap.js 统一入口，任务计划 pi-xuwu-boot-butler 开机自启）
2. **改 lib/ 代码后必须重启管家**（require 缓存不重新加载，见 pitfalls）
3. 面板：`python pi_workspace/hub/panel/panel.py`（后台工具，用户可看可不看）

## 外部项目参考规范（2026-08-05 用户强调）
1. **每次参考/克隆/借鉴外部项目前，必须先确认开源协议**（LICENSE 文件），合规后才可继续：
   - MIT / Apache-2.0 / BSD → 可自由参考（保留 LICENSE 即可）
   - GPL / AGPL → 借鉴需谨慎（传染性，注意派生作品义务）
   - 无协议 / 保留所有权利 → 不可直接参考复制
2. 已确认协议的项目：
   - oh-my-pi（Mario Zechner）→ MIT ✅
   - human-writing（KKKKhazix）→ MIT ✅
   - oh-my-cli（qwen-code-dev-bot）→ Apache-2.0 ✅
3. 参考记录统一放 knowledge/references-<项目名>.md，含协议标注

## 汇报格式规范（2026-08-05 JUN 反馈）
1. **短标题 + 详情**：所有汇报/输出用"短标题概括 + 点开/展开看详情"的形式——标题要短（≤15字），详情放后面
2. **别啰嗦**：能短就短，JUN 原话"可以再剪短点"
3. 适用：任务汇报、控制台输出、对话回复的格式化场景

## 智能体任务冲突与资源锁（2026-08-06 教训：聊天室模型被互踩）
1. **资源归属**：共享资源要有明确 owner（如 chatroom.model→twin 决策、chatroom.channels→night-worker 维护），记录在 knowledge/resource-registry.json
2. **任务声明资源**：任务文件标注 `writes:` / `reads:` 涉及哪些共享资源；butler 派发前比对"运行中任务的 writes"，有交集→串行或上报分身，不硬派
3. **分身改共享资源前先查**：改前问 butler 该资源有无任务正在写（本次教训：分身在 qwen 任务还活着时改了聊天室模型，被 qwen 收尾改回）
4. **子任务作用域纪律**：子任务只改任务文件写明的；要动全局/共享配置→上报 butler/分身，不擅自改（本次教训：qwen 任务是"加频道"，收尾却重置了全局模型）
5. **并行任务禁止写同一资源**：确需并行，必须走 butler 协调或拆成串行

## 改配置要改"配置源"，不是"派生表"（2026-08-06 教训：new-api 聊天室模型被重置）
1. 直接改 DB 派生表会被程序的 reconcile 循环覆盖（new-api chat_room_topic_agents 表 ← options.ChatRoomTopicAgents + 代码默认值 reconcile 而来）
2. 改行为先找真正配置源：options 表对应 key / 代码硬编码默认值 / env，改源头才持久
3. new-api 聊天室模型根因：setting/chatroom/setting.go `DefaultTopicAgentModel=OpenCodeMiMoModel` 硬编码 + option 加载怪癖；持久修复=改默认值重建，或修复 option 加载（归入 VISION-v6 聊天室改造）

## 报错汇报规范（2026-08-06 用户明示）
1. **小问题只留任务日志**：不向用户反复发报错邮件/文档/汇报；记录到任务日志（inbox/.DONE、logs/）即可
2. **安全邮件告警已关闭**：new-api SecurityDefenseEmailAlertsEnabled=false（2026-08-06）
3. **重大/不可逆事件才当面汇报**：服务不可用、数据丢失风险、需要用户决策的才汇报
4. 服务器端智能体集群部署后，小事由集群自治消化（VISION-v6 路线）

## 前端路由规范（2026-08-07 用户明示）

1. **前端内容/效果图检查 → claude-opus-5**：前端页面内容核对、效果图/视觉还原度检查类任务，**默认交给 claude-opus-5**（xxsx 渠道，模型名 `antigravity/claude-opus-5`），其他模型（deepseek/gemini 等）效果差
2. **渠道状态（2026-08-07 实测）**：xxsx 渠道 `antigravity/claude-opus-5` 返回 503（上游未就绪）；**当前可用替代**：`antigravity/claude-opus-4-6-thinking`（Claude Opus 强，实测可用）——派发前 30 秒验证 opus-5，失败即降级 4-6-thinking
3. **前端编码任务**（写代码/改页面）不强制 opus-5，按 model-routing 常规路由（claude 系为主）
## 通知规范（2026-08-08 用户）
- **所有通知走软件（APP admin_mobile_alerts 通知）**，不再发 SMTP 邮件（邮件延迟且多余）
- 发布/告警/任务事件：task_done/task_failed → APP 通知（已有链路）
- SMTP 配置保留仅用于注册验证邮件（功能，非通知）
## CNB 仓库（2026-08-09）
- xxssxx.top/1、2、3 = 私有仓库（开发/构建/测试空间）
- xxssxx.top/4、5 = 公开仓库（用户 2026-08-09 添加）
- 空间启动/状态/SSH 查询：org/scripts/cnb-ctl.js（API 驱动，token 加密存储）
## 新组件上线规范（Windows 防弹窗三查，2026-08-09 沉淀）
任何新增：计划任务 / 服务 / 脚本 / 定时器 / 常驻进程——上线前必查：
1. **窗口隐藏**：计划任务必须是 vbs/wscript 隐藏包装 或 `-WindowStyle Hidden`（Interactive 计划任务每次执行会弹窗闪屏！）
2. **交互式任务包装**：schtasks 定时任务一律改 vbs 隐藏（参考 scripts/watchdog-hidden.vbs 模式）；powershell 加 -WindowStyle Hidden
3. **残留清理**：启动后检查 无空窗口 / 无 cmd 残留 / 浏览器无残留标签
验收：新组件上线后观察 10 分钟（watchdog 周期）确认无弹窗
## 文档格式规范（2026-08-09 用户）
- 给用户看的文档（docx/纯文本）：**禁用 markdown 语法符号**（**加粗、# 标题、- 列表符等）——用自然文本/Word 样式
- markdown 仅用于内部过程稿（任务文件/知识库）
## 调研/排查任务三序（2026-08-09 用户批评后）
1. **先查对应智能体的记忆/artifacts**（该领域的历史报告——聊天室→xxsx-gateway/night-worker 的 artifacts——多数答案已在）
2. **再查源码**（权威源码优先本机 WorkBuddy/xxsx-proxy-gateway/upstream——HK /opt/xxsx-api/upstream 可能是旧副本）
3. **最后才问用户**（不要主会话自己探路搜代码——派给对应智能体，它负责自己的领域知识）

## 智能体集群核心原则（2026-08-09 用户理念明示）
0. **授权边界（可逆直接做）**：不涉及永久删除、或大量代码不备份就覆盖的可逆操作——直接做，不必每次确认（8/6 用户明示）；生产环境重建/部署仍谨慎验证
0b. **分身代决（不反问）**：所有任务决策点（注册账号/继续挖/换方案/预算分配/方案选择）由分身直接做出与用户想法一致的判断并执行，不给建议反问"要不要做"（8/6、8/8 用户）；仅红线（花钱/永久删除/法律风险/超授权范围）才升级用户。授权链：用户→分身→任务执行
0c. **立即沉淀（不等不攒）**：检测到教训/偏好/踩坑立即主动沉淀（conventions/pitfalls/memory），不等攒批（8/6 用户批评"敏感度太低"）
0d. **任务按业务域路由**：服务器/守护活→server-admin、聊天室/网关→xxsx-gateway、框架→night-worker、前端→claude；不按代码归属，按"做什么"归谁；紧急止血可先直接做再派任务收尾（8/7-8/8）
1. **分工铁律**：谁的项目谁干——小事不劳主会话/分身亲自做；智能体不越权（遇到别的域的活→转交路由，不代劳）；主会话=接想法→路由→收汇报（隐私/敏感/红线除外）；分身=监督/决策/审批（不亲自查细节）
2. **自我繁衍**：项目大到无法全盘熟知 → 智能体主动写繁衍申请（子分组+子智能体分工方案）→ 分身审批 → 管家执行建子分组 → 父智能体升格组长
3. **讨论文化**：用户给思路和方向（大模型无法创造新思路，只能推演）→ 智能体们讨论、分工、执行、汇报——不等用户逐条指挥
4. **用户=CEO 只提想法**：愿景"我只需要提出想法，剩下的分身搞定"——集群自主运转

## 询问与执行边界（2026-08-09 用户纠正）
1. **"能不能/可不可以/是否可行"≠执行指令**：用户问可行性 → 先答"能/不能 + 关键点"，等用户明确说"做吧/下载吧"再动手；不要火急火燎直接开干（浪费动作+可能做错方向+打断节奏）

## API Key 管理（2026-08-09 用户明示）
1. **不派无目标任务**：派活三要素=具体产出+用什么资源+验收标准
2. **Key 一律固化**：存 `~/.qoder/apis/` 等专用路径，不从历史会话翻找
3. **Key 分身统一主管**：secrets-index 登记，分身派任务时知道用哪个

## 软件渠道安全（2026-08-07 用户）
1. **离线版/盗版软件**：用户愿意尝试但要求安全校验（病毒检查/沙箱）；GitHub ★0 钓鱼仓库要识别拒绝

## xxsx 网关 new-api 构建源（2026-08-11 踩坑固化）
1. **规范构建源 = `D:\dx\projects\xxsx-proxy-gateway\upstream\new-api-main`**（完整工程，含全部 xxsx 自定义路由：app-release/cluster/admin_mobile_release 等）。
2. **`.public-release/xxsx-api` 是裁减版（对外开源），缺自定义路由**——用它编译的二进制会丢 app-release/cluster 路由导致 APP 更新通道 404。8/10 深夜误用其编译→线上回退 08-08 版牺牲令牌时长 UI；8/11 已从完整 upstream 重编译修复。
3. **new-api 前端 go:embed 内嵌 dist**：改 Web UI 必须重编译二进制才能生效，仅替换磁盘 dist 不生效。
4. **移动管理令牌永久化**：`model/admin_mobile_device.go` 中 `expires_at == 0` 表示永久（upstream 已加此逻辑 + 查询 `(expires_at = 0 OR expires_at > ?)`）；Web 后台 host-panel.tsx 有令牌时长选择（7/30/90/365天/永久）。
5. **部署流程**：上传新二进制为 `bin/new-api.new` → deploy-hk.sh（备份→停服→替换→重启→健康检查）→ 验证 Web index 引用新版 js + 自定义路由 + 数据完整（users/channels/tokens 计数）。

## 通用规则（2026-08-10 用户明示）
1. **漏洞/问题分级处理**：
   - 用户自己使用中发现的问题/漏洞 → **直接修复**（不用问——改完验证+记录）
   - 其他用户（产品使用群体）发现的 → **征求用户意见后**再处理（提交 GitHub 反馈/修复发布——先问用户决策，不擅自改影响面大的）
2. **无对应智能体时的处理**：分身/主会话遇到任务但没有对应职责的智能体（或框架为空）→ **先问用户是否创建**：创建什么智能体 + 放到哪个分组（参考现有分组结构建议）；用户说"你自己决定"时才自主创建（如 tourism-planner 案例——当时用户提示"不是有管旅游的吗"后补建——规则化：默认先问）
3. **进程拉起必隐藏（2026-08-10 补）**：任何方式拉起 Windows 进程（node/管家/服务）必须用 bootstrap.js（Start-Process -WindowStyle Hidden）或 vbs 包装——**禁止手动 nohup/直接 node 启动**（会闪空终端）；计划任务执行器必须带 Hidden/或 vbs；修复后验证 MainWindowHandle=0
4. **桌面重操作白名单（2026-08-11）**：智能体任务**禁止未经用户同意**启动用户桌面应用/模拟器/安装软件/重启服务等重操作——需要时**先问用户**（或至少 activity 通知+等确认）；验证 UI 用无头方式/截图优先——擅自启动用户应用=打扰（案例：app-fixes-b 擅自启动雷电模拟器）
5. **禁止全盘扫描（2026-08-11 二次教训）**：智能体**禁止 `find /`、全盘 grep**（卡死机器——已发生 2 次：reviewer 验收/hk-tailscale-restore 找日志）——找文件限项目内/明确路径；需要系统文件用 which/type 或 /var/log 等明确目录
6. **CNB 仓库回馈原则（2026-08-11）**：用腾讯云 CNB 云开发环境（免费/低价）——私有仓库必须持续有内容（git-sync 自动推 org 公开部分）——定期检查仓库健康（README/结构/内容）——"不纯白嫖"；上传内容限"不太核心不太隐私"（secrets/会话/密钥绝不上传）

## 实体审核防积压（2026-08-12 learning-officer 批量审批教训）
1. **零 LLM 实体抽取会产出大量噪声**：extractEntities 从任务名/日志/报错提取的实体，多数是纯大写缩写（DONE/FAILED/PID/CNB/HTTP）、英文碎片 token（Users/Material/Running）、中文残缺一次性状态短语（"渠道正常为"/"服务器域工作由"/"渠道空回复并走fallb"）——这些不是知识实体，注入上下文纯属噪音。
2. **patrol.js 自动 approve 条件过苛导致积压**：仅 `count>3 且 实体名在 knowledge/assets.md` 才 approve，导致 474 实体中 approved 仅 1、pending 473，且每次巡检越积越多（183→303）。
3. **批量审批策略（固化于 tools/entity-review-batch.js）**：REJECT = 纯大写缩写 / 英文碎片 token（不在专名白名单且低频）/ 中文残缺一次性状态；APPROVE = 英文专名白名单（品牌/项目/框架/工具）+ 英文高频非碎片 + 中文完整语义实体。执行一次将积压清零（reject 308 / approve 167 / 留 0）。
4. **防再积压**：建议巡检定期追加跑一次 `node tools/entity-review-batch.js`（或并入 patrol.js），及时 reject 新产生的噪声 token，避免再次累积到数百量级。
## 分身思维默认为主（2026-08-12 用户明示，乱码修复恢复）
1. **任务执行/审批/答复/工具，默认用分身思维（user-twin）**：用户会怎么想/怎么选/怎么说——执行时不问用户（用户不在场），用户自己的事自己判断；需要用户拍板的再上报

## 协作规范再强调（2026-08-12 用户再次强调，乱码修复恢复）
1. 任务交接**必须**与对应智能体交流：不是单方面执行，先与该智能体确认（ask / 投递咨询 / 确认信息 / 协商）
2. **任务投递必须附"智能体上下文提示"**：涉及该智能体 / 冲突 / 共享资源的任务，投递时附该智能体的会话/记忆或自动注入其记忆，确保智能体知道是否与规范冲突
3. 任务文件 = 目标 + 边界 + 内容格式——**必写内容/格式/注意事项**，内容自己判断

## 验收闭环增强（2026-08-12 经验沉淀，乱码修复恢复）
1. reviewer 验收必须含**实机验证**（运行/操作/真实数据/端到端低阶验证）；验收报告缺失则驳回重试
2. 源头修复 + 验收把关双保险

## 识图功能（2026-08-12，乱码修复恢复）
1. mimo 识图（图片/发送图片任务）：图片压缩到 800px 内（微信截图 1080+ 太大）；加 --thinking off（避免视觉推理思考）；超时 120s；失败换 grok

## 编码规范（2026-08-12 用户强调"乱码一直没根"——night-worker 乱码根治落地）
1. **所有文件读写一律 UTF-8**：Windows python 默认 GBK（cp936）写文件是乱码根源——python 写文件必须显式 `open(path, 'w', encoding='utf-8')`，读文件同理（坏字节用 errors='replace' 容错）
2. **写 DONE/标记/日志/知识文件优先用官方工具**：`node org/scripts/write-done.js <任务名> "<一行摘要>"`（node 默认 UTF-8 + 写后校验，坏即拒写）
3. **文件名/内容禁止出现 U+FFFD 替换符**（乱码特征）；任务名、摘要中文一律 UTF-8 落盘
4. 禁止：python 裸 `open(p,'w')` 写中文、PowerShell `Set-Content`/`>` 重定向写文件（默认 ANSI/GBK）、`print > file`
5. 已落地机制（2026-08-12）：PYTHONUTF8=1 + PYTHONIOENCODING=utf-8 用户环境变量；sitecustomize.py 全局强制（stdout/stderr/open 默认 UTF-8）；lib/knowledge-inject.js 任务派发自动注入本规范速查（knowledge/task-inject.md）
6. 产出验证：写后自查 `file <文件>` 显示 UTF-8 或读回无 `\ufffd`；乱码 DONE 会被 write-done.js 拒绝

---
> 修订记录：2026-08-12 night-worker 修复尾部乱码（第 7-10 条 GBK 损坏恢复 + 新增编码规范章节）
11. **执行完整性规范（2026-08-12 用户+魇. 对话共识）**：
    - **不找最短路径**：执行中遇到异常（连不上/失败/绕行）——**事后必须记录+总结**（为什么绕/能不能修）——修得了就修（最小改动）——修不了问用户——**不许静默绕过**
    - **过程质量**：不只是"跑通目标"——过程中发现的问题/坑/异常点——**写进沉淀**（pitfalls/知识库/任务 DONE 的"过程异常与处理"段）
    - **说了要强行记进去**：用户纠正/魇. 等外部反馈——**立即落地**（代码/文档/机制三选一）——不留口头——每轮结束自查"这轮说的记了没"
    - **规范保持**：改过的规范下次还在（机制强制——不靠自觉——自觉会忘）
12. **组件退役三件套（2026-08-13 keepalive 弹窗教训）**：任何组件弃用/退役——①计划任务禁用 ②常驻进程杀掉（--loop/daemon 残留会继续跑）③引用/文件标注（防复活）——"策略上不用"≠"进程没在跑"；新计划任务一律 -WindowStyle Hidden
13. **管家单例铁律（2026-08-13 双管家弹窗教训）**：butler 管家任何时候只允许一个进程——watchdog/拉起逻辑必须先杀旧管家再起新的（检测到多个 butler.js 进程=告警+清理）；任何代码补丁必须 git 提交（git-sync 会 auto-commit 未提交改动——但显示"working tree clean"才是安全态）
14. **文档默认输出位置（2026-08-13 用户）**：给用户生成的任何文档/文件**默认放 Downloads**（C:\Users\du_ji\Downloads\）——用户方便找——不用问"放哪"——工作产物/中间件才放 pi_workspace\output 或 scratch
15. **Windows 进程启动总规范（2026-08-13 弹窗三轮教训——彻底版）**：
    - **计划任务一律 wscript vbs 包装**（vbs 放 org/scripts/hidden/，ws.Run "命令", 0, False）——**禁止直接 powershell/cmd/node 作计划任务动作**（-WindowStyle Hidden 在计划任务+用户会话下已被证明不可靠——多次弹窗实证）
    - **schtasks /change /tr 带空格路径必须内部引号**（/tr "wscript.exe \"C:\path\x.vbs\""）——或用 Set-ScheduledTask -Action（最稳）
    - **后台进程 node 直跑**（lib/spawn.js：pi/claude 直跑 js/exe——不 cmd 包装——windowsHide 有效）
    - **监督/巡检类计划任务间隔 ≥5 分钟**（l1/l2/watchdog/popup-audit 曾 6 分钟×4 个=高频弹）
    - **新组件上线三查强化**：①计划任务 vbs 化 ②进程隐藏 ③退役清理三件套（conventions 12）
