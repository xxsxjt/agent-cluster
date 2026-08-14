# 沉淀候选暂存区（pitfalls-inbox.md）

> 自动捕获：lib/exec-completeness.js 审计发现「任务含异常特征 + DONE 明确记录过程异常/沉淀」时自动追加。
> 维护：learning-officer 定期审核合并进 pitfalls.md（场景/错误/根因/解法/时间/踩坑者），合并后删除对应条目。

## 2026-08-12 verify-exec-completeness（执行完整性自动捕获）
- 异常特征：连不上 / 失败 / 绕行
- 任务文件：inbox\verify-exec-completeness.md
- DONE：verify-exec-completeness DONE: 统计=31 个 .js [过程异常: ①遇到什么——模拟连接 mock 端口 127.0.0.1:1 失败(Connection refused, curl exit 7), 网络方案不可用; ②怎么绕的——放弃网络方案, 改用本地方案 node -e readdirSync 统计, 注入命令原路径 C:/Users/du_ji/pi_workspace/org/lib 在容器内 ENOENT, 现场做路径映射执行 /workspace/lib(容器内 pi_workspace 镜像) 得 31, 双法交叉验证一致(ls|wc -l
- 状态：待 learning-officer 审核合并进 pitfalls.md

## 2026-08-12 execution-completeness（执行完整性自动捕获）
- 异常特征：连不上 / 异常 / 绕行
- 任务文件：C:\Users\du_ji\pi_workspace\org\inbox\execution-completeness.md
- DONE：执行完整性机制落地完成：①task-inject.md 模板强制注入「过程异常必须记录五要素」章节（含异常处理链/沉淀自查/DONE格式），fallback 同步；②lib/exec-completeness.js 审计模块+butler.js cycle 挂载（60s节流+幂等cursor）——异常任务DONE无记录→violations.jsonl告警，有记录→自动捕获沉淀候选；③真实闭环验证：投 verify-exec-completeness 演练任务（mock端口连不上→绕行），CNB执行者DONE完整记录[过程异常]五要素，审计精确捕获入 pitfalls-inbox.md；历史基
- 状态：待 learning-officer 审核合并进 pitfalls.md

## 2026-08-12 trip-flight-add（执行完整性自动捕获）
- 异常特征：降级
- 任务文件：C:\Users\du_ji\pi_workspace\org\inbox\trip-flight-add.md
- DONE：行程 v2 已加'交通方案对比'章节（飞机 3~3.5h+机场线 40~60min，旺季早买 600~1000 元/单程 vs 高铁 G80/G70 8h 862~940 元+推荐混搭），docx+txt 已 UTF-8 重新生成并验证无乱码（U+FFFD=0），备忘 artifacts/beijing-trip-v2-flight.md [过程异常: CNB 不可达→自动转本机执行，任务完整完成]
- 状态：待 learning-officer 审核合并进 pitfalls.md

## 2026-08-12 intel-collect-20260813-014522（执行完整性自动捕获）
- 异常特征：不可用 / 522
- 任务文件：C:\Users\du_ji\pi_workspace\org\inbox\intel-collect-20260813-014522.md
- DONE：intel-collect 20260813-014522 完成：HK 桥不可达（SSH 43891 公钥拒绝，observer-intel-sync 已跳过）；集群本地增量已追加 channel-intelligence.md（review-batch 验收 20/2、用户纠正 #9/#10 交付完整性+事件触发复盘、pitfalls +2）；未涉微信/个人数据出圈。
- 状态：待 learning-officer 审核合并进 pitfalls.md

## 2026-08-13 meeting-plan-meeting-sim-2026-08-13-07-持续推进失败判定机制故障族沉淀进-pitfalls（执行完整性自动捕获）
- 异常特征：失败
- 任务文件：C:\Users\du_ji\pi_workspace\org\inbox\meeting-plan-meeting-sim-2026-08-13-07-持续推进失败判定机制故障族沉淀进-pitfalls.md
- DONE：DONE: 持续推进失败判定机制故障族沉淀进 pitfalls——已合入 08-12 两增量：①调度层兜底 settlePending 落地标注；②新增独立故障族「执行载体任务范式识别(CNB 桥伪失败)」；产出 artifacts/meeting-plan-meeting-sim-2026-08-13-07-持续推进失败判定机制故障族沉淀进-pitfalls.md，改前已备份 knowledge/pitfalls.md.bak-20260813-meeting-plan-07
- 状态：待 learning-officer 审核合并进 pitfalls.md

## 2026-08-13 meeting-full-close-loop（执行完整性自动捕获）
- 异常特征：失败
- 任务文件：C:\Users\du_ji\pi_workspace\org\inbox\meeting-full-close-loop.md
- DONE：例会完整闭环五通道落地: 卡点+明日计划自动转派+异常激活+学习信号+例后互评(lib/meeting-close-loop.js runFullCloseLoop+daily-meeting Phase4.5) + 多段卡点提取修复(3→40漏提归零)+CRLF兼容(0→40)+防任务风暴(priority:low) + HK部署(补齐6缺失模块+butler重启) + 单测24/24 + 模拟例会端到端(12转派+4互评+HK真执行) + 聊天室群聊已ask-xxsx-gateway → artifacts/meeting-full-close-loop.md, git e3fb847


- 状态：待 learning-officer 审核合并进 pitfalls.md

## 2026-08-13 checkpoint-info-search-v2-followup-20260813-162031-n30（执行完整性自动捕获）
- 异常特征：失败
- 任务文件：C:\Users\du_ji\pi_workspace\org\inbox\checkpoint-info-search-v2-followup-20260813-162031-n30.md
- DONE：进度汇报完成:任务实际在cnb-dev运行,但源任务.md/log/.log/DONE全缺失仅剩progress.jsonl;最后心跳13:59(102min)后静止2.4h疑似停滞/已过7200s软超时,已追加进度并标注疑似停滞供看护介入[过程异常:任务路由错位到night-worker但真实归属cnb-dev,文件缺失]
- 状态：待 learning-officer 审核合并进 pitfalls.md

## 2026-08-13 checkpoint-info-search-v2-followup-20260813-163051-n30（执行完整性自动捕获）
- 异常特征：失败
- 任务文件：C:\Users\du_ji\pi_workspace\org\inbox\checkpoint-info-search-v2-followup-20260813-163051-n30.md
- DONE：进度汇报完成:任务仍在cnb-dev运行但源任务/日志/DONE全缺失;最后心跳13:59(102min)后静止约2.6h持续停滞,已追加进度并再次标注疑似停滞需看护介入[过程异常:任务路由错位到night-worker、真实归属cnb-dev且文件缺失,持续无恢复]
- 状态：待 learning-officer 审核合并进 pitfalls.md
