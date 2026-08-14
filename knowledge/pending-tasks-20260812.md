# 未办任务清单（2026-08-12 21:50 排查——公共数据库——所有智能体可查）

> 来源：output/2026-08-12-pi会话整理-按天主题.md 排查 + 任务状态实查（inbox .DONE/.PID）
> 排查人：主会话（按用户要求：文档提到且未撤销的 → 全面排查未完成 → 本清单）
> 更新规则：任务完成 → 移入下方"已完成"区（或删除本行）；新发现未办 → 追加

## 一、未完成（需跟进）

| # | 事项 | 状态 | 负责人 | 下一步 |
|---|------|------|--------|--------|
| 1 | **xxssxx-homepage-v2**（主页翻新——xxsxjt+虚无圣殿双身份/分享页进文档/登录保护）| ❌ FAILED（进程异常中断——已清标记重投）| xxsx-gateway | 重跑→用户验收主页效果 |
| 2 | **info-search-entry**（信息搜索入口——APP+网页——私聊式/扣费/独立）| ❌ FAILED（pi 退出 code=null——执行中异常——已重投）| xxsx-gateway | 重跑→双端入口→用户验收 |
| 3 | **app-chatroom-ui-fix**（APP 聊天室乱码显示/排序/好友按钮文本大小 + huashu 前端 skill 借鉴）| ❌ FAILED（进程中断——已重投）| xxsx-gateway | 重跑→发布→用户验收 |
| 4 | **response-format-fix**（response_format 参数报错定位修复）| ❌ FAILED（pi 退出——已重投）| xxsx-gateway | 重跑→验证不再报 |
| 5 | **旅游 v2 docx**（乱码重生成）| ✅ 完成（原损坏 docx 已删——新 docx 按 artifacts/beijing-trip-v2.md 产出）| tourism-planner | **确认新 docx 已放 Downloads**——用户验收 |
| 6 | **泰拉瑞亚撒旦军团**（tile.change/item.use/npc.* 已加+重启）| ⏳ 等用户进服实测 | 用户 | 还不行→用户给原文报错→terraria 智能体查 |
| 7 | **CNB 空间 4/5**（仓库已存在——空——用途规划：4=存储/5=孵化）| ⏳ 待定 | server-admin | 用户确认用途→启用 |
| 8 | **CNB 存储迁移 28G 收尾**（迁完用户确认删源释放 HK）| 🔄 进行中 | server-admin | 续传→完成→用户确认删源 |
| 9 | **HK 管家 ENOENT 深修**（系统已恢复 active——但根因未确认彻底）| ⚠️ 表面正常 | server-admin | 确认根因/或接受现状（HK 正常调度）|
| 10 | **mimo 识图慢**（规范已写：压缩+thinking off+120s）| ⚠️ 规范已落 | 主会话 | 实测一次提速效果——仍慢换 grok |
| 11 | **huashu 前端 skill LICENSE**（借鉴前确认）| ⏳ 待确认 | xxsx-gateway | 用之前查（app-chatroom-ui-fix 带上）|
| 12 | **图片处理占前台会话**（hermes 平台限制——用户与魇. 讨论）| ⚠️ 已知平台限制 | 主会话 | 记 pitfalls——不强行修（修不了就说明）|

## 二、进行中（在跑）

| 任务 | 状态 | 说明 |
|------|------|------|
| backup-supervisor（备用监督者——hub supervisor 移植）| 🔄 在跑 | 死机自动修复+备用接管 |
| execution-completeness（执行完整性——异常记录/修复/沉淀）| 🔄 在跑 | 任务模板加"过程异常与处理"段 |
| uumit-earn-only（UUMit 只接单不买货+协作双向）| ✅ 完成 | 8 技能挂售——等订单 |
| observer-intel-db（观察员信息→共享数据库）| ✅ 完成 | 已验收 |

## 三、机制类已完成（当日落地——保持生效）

- ✅ encoding-root-fix（乱码根治——UTF-8 铁律+知识同步）
- ✅ auto-rerun-strengthen（失败自动重跑——单测 34/34）
- ✅ agent-rescue-core（互救机制+分身监督）
- ✅ session-reuse-quality（会话复用+压缩+交付自查）
- ✅ delivery-completeness（交付完整性标准——用户可及性必查）
- ✅ reviewer-quality-gate（审核编码必拦）
- ✅ agent-collab（协作通道——聊天室拉群/私聊+CNB 归档+群复用）
- ✅ user-apk-download-fix（APP 下载 403）
- ✅ 通知双通道（失败→管理组智能体——用户只收升级）

## 四、备注（排查发现的问题）

- ⚠️ **4 个任务 FAILED 未自动重跑**（21:34-21:38 失败——auto-rerun 21:11 已落地但未拦住）——已清标记重投——**需查 auto-rerun 为何没触发**（或触发条件与"进程异常中断"不匹配）——并入 backup-supervisor/execution-completeness 收尾检查
- ⚠️ 主会话 18:2x 误杀 3 活任务（教训：清理脚本归管家统一管理——已立）
