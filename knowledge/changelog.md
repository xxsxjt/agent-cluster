# 框架演进日志（changelog.md）

> 维护者：学习进化官（learning-officer）
> 格式：日期 — 变更 — 影响/说明。从旧到新追加（新的在最后）。

## 2026-08-05 — 管家域重构 + 学习进化官 + 记忆体系（org-restructure-memory）

**变更**：
1. **组织树重构**：coo 从个体升级为管家域组 `grp-coo`（parent=twin）。树形变为：CEO → 分身(twin) → 管家域(grp-coo) → { 管家本体(coo)、学习进化官(learning-officer)、框架开发(night-worker)、6 业务域组 }。业务域组 parent 全部从 coo 改为 grp-coo。
2. **新增智能体 learning-officer**（spawnType=pi，on-demand）：维护全局知识库 org/knowledge/、每日汇总经验（chat-signals + work_record + 任务 DONE）、监督各智能体 diary 纪律、重复踩坑检测。
3. **记忆体系落地（树形继承）**：全局库 org/knowledge/（assets/pitfalls/conventions/changelog）+ 组级记忆 groups/<组>/memory/group-diary.md + 专属记忆 agents/<id>/memory/diary.md；写入规则（会话结束追加 3-5 行、超 20 条压缩 auto-notes、坑上报三级、读取顺序 全局→组→个人）。
4. **butler.js 微调**：动态创建智能体与管家分身的默认 parent 从 'coo' 改为 'grp-coo'（树形一致性）；路由兜底逻辑不变（coo 仍是主调度）。
5. **初始化全局知识库四件套**：assets.md（含 2026-08-05 渠道实测：agnes 文生图✅/edits 503⚠️/redfox 无key❌/阿里 wan❌/mimo 代理❌）、pitfalls.md（9 条坑，含高频 require 缓存）、conventions.md（路由/权限/记忆/任务规范）、本文件。

**影响**：
- org.json 树形结构变化（web 面板/前端若硬编码 coo.children 需同步检查）
- 所有智能体新目录规范：agents/<id>/memory/diary.md 模板已就位
- butler 需重启生效（require 缓存，本次只改了 js 默认 parent，registry 读 org.json 无缓存问题）

## 2026-08-05 — 启动体系正规化 + opencode-go 恢复（上午）

- opencode 余额恢复（Insufficient balance 解决），opencode-go 直连通
- 配置整理：omni-go→opencode-go、omni-free→omniroute-free、删 experiment 渠道
- 启动正规化（为开源准备）：scripts/bootstrap.js（start/stop/status/restart/install/uninstall）+ install.ps1/install.sh + xuwu.sh；任务计划 pi-xuwu-boot-butler
- model-router 升级：opencode 分级（small=omniroute-free、large=opencode-go）
- 坑：Git Bash 下 schtasks 路径转换失败 → 用 powershell.exe

## 2026-08-05 — 模型渠道全面盘查（晚间）

- 实测确认：agnes 文生图 ✅ / agnes edits 图生图 503 ⚠️ / redfox.hk 无 key ❌ / 阿里 wan 图片 ❌ / mimo 视觉代理 ❌
- 教训沉淀：skill 存在 ≠ 渠道可用；资产清单入 knowledge/assets.md

## 2026-08-04 — v5 组织树定稿（CEO→分身→管家→域组）

- 组织树 v5：root(CEO) → twin(分身) → coo(管家) → 6 业务域组（安全/内容/服务器/开发/媒体/工作台）
- 蒸馏 v3 全量完成
- butler.js 单实例锁 + inbox 任务机制 + fs.watch 实时响应
- 教训：butler require 缓存需重启 / 阿里 429 / 任务一锅烩 / 并行打爆

## 2026-08-05 — 记忆体系收尾：实体审核闭环 + 记忆进控制台（memory-polish，night-worker）

**变更**：
1. **learning-officer 定期巡检脚本** `agents/learning-officer/patrol.js`：扫描全部智能体 entities.json，pending 超 24h 的实体进审核队列；auto-approve 规则 = count>3 且实体名出现在 knowledge/assets.md，其余留 pending 待分身处理；附带 diary 纪律抽查（模板未写/索引缺失）。产出 `agents/learning-officer/memory/entity-review-log.md`，自身 diary 同步记账。identity.json 补 capability: entity-review。
2. **lib/memory.js**：新实体补记 pendingSince 时间戳（24h 判定精确化，旧数据用 firstSeen 兜底）；新增 listEntities() 导出。
3. **控制台记忆视图**：server.js 新增 `GET /api/memory/<agentId>`（timeline/search/entities/index 元信息）；智能体详情页新增"记忆"tab（时间线 + 检索条目 + 关键词过滤 + 实体图谱状态着色），仅 agent 节点显示。selftest 86/86（新增 4 项记忆接口用例），headless Edge 实测渲染通过。

**已知边界**：butler 的 diary 自动写入依赖内存 active 表——改过 butler.js/lib 后必须重启 butler 才生效（本次核实 20:22 前完成的任务因旧进程无新代码而未记账，takina 之后的条目正常）。

## 2026-08-09 — chat-signals 增量合并（learning-merge-20260809-202629，learning-officer）

**变更**：分身巡检派活触发 33 条 chat-signals 增量合并，逐条核对四件套后落地缺失/过时项：
1. **conventions.md**：①隐私铁律放宽（8/8 用户：可信渠道=正规大平台 deepseek官方/opencode/阿里云 + 自有基础设施 XXSX 中转；只禁第三方小中转 molifangapi/sub2-luna/omniroute-free）②新增免费池思考常开（free 零成本，支持思考一律开，别机械省）③智能体集群核心原则补 5 条子则：授权边界可逆直接做 / 分身代决不反问 / 立即沉淀不等攒 / 任务按业务域路由 / ④新增"询问与执行边界"（"能不能"≠执行指令，先答可行性再等明确指令）⑤新增 API Key 管理（派活三要素/key 固化 ~/.qoder/apis//key 分身统一主管）⑥新增软件渠道安全（离线版/盗版要安全校验，GitHub ★0 钓鱼仓库拒绝）
2. **pitfalls.md**：新增 重建/重启前先查在线（泰拉瑞亚撞玩家被踢）、离线版/盗版软件安全校验
3. **assets.md**：微信渠道隐私标注改放宽版；新增 泰拉瑞亚服务器资产（专家大世界/密码2287/6人/无注册）

**影响**：隐私数据可读渠道扩宽（不再死守 deepseek 官方），降低误拒/误拦；决策类规则补全减少分身犹豫。
**去重说明**：33 条信号中大部分已存在于四件套（license/短标题/报错规范/前端路由/docx/新组件三查/排查三序/集群核心原则等），本次只补真缺失项，不重复。
