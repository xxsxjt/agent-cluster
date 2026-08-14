# reviewer 质量门禁报告：DONE/产出文档编码污染全面核查

> 任务：reviewer-quality-gate（2026-08-12 20:47 派发）
> 审核官：reviewer ｜ 核查范围：org/inbox DONE + 产出文档 + agents 记忆层
> 结论先行：**驳回（大面积编码污染，违反 UTF-8 必杀项）**——详见下文分级。

---

## 一、编码必杀项核查（核心结论：大面积违规）

### 1.1 DONE 文件名层：46 个含 U+FFFD（不可逆污染）

对 org/inbox 全部 800 个 `.DONE` 文件做文件名级检测，**46 个文件名含 U+FFFD 替换符**（GBK→UTF-8 二次编码损坏，**不可逆**）：

| 类别 | 数量 | 时间窗口 | 示例 |
|------|------|----------|------|
| checkpoint-* DONE | 27 | 08-12 18:42 ~ 20:16（**仍在持续产生**） | `checkpoint-nextday-2026-08-11-chatroom-v2-features-����1-����-152618-...-n30.DONE` |
| nextday-* DONE | 19 | 08-11 23:35 ~ 08-12 17:23 | `nextday-2026-08-11-app-p0-product-P1-�ɷ�-152618.DONE`、`nextday-2026-08-11-CNB-����ӹ�-�洢Ǩ����β-152618.DONE` 等 |

**关键对照（根因实锤）**：
- 同一任务的 `.md` 询问文件 **全部正常 UTF-8**（含 FFFD 的 .md = 0），例如 `checkpoint-...-chatroom-v2-features-需求1-重派-152618-20260812-143410-n30.md` 正常；
- 但对应的 `.DONE` 文件名却是 `...-����1-����-152618-...` 乱码。
- **结论**：butler 生成的 .md 正常 → 派发给执行 agent 时经 bash/脚本通道传参中文损坏（与 2026-08-12 notify-encoding-fix 发现的「Windows Git Bash → node.exe 传参中文 → U+FFFD 不可逆」完全同源）→ agent 按损坏的任务名写 .DONE → 文件名乱码。
- **持续产生中**：最新 4 个乱码 checkpoint DONE 的时间戳是 08-12 19:54/20:16，说明根因至今未修。

### 1.2 DONE 内容层：153 个违规（70 个 GBK 编码 + 83 个内容含 U+FFFD）

- **70 个 GBK 编码写入（非 UTF-8，可救回但违规）**：其中 **65 个内容为 `.FAILED: 孤儿进程（PID 残留清理——进程已死）`**，全部集中在 **08-11 18:50 批量产生**（55 个 -improve 类 + 10 个其他）。这些任务**未经真实执行就被孤儿清扫机制标 FAILED 覆盖**（如 agent-backlog-improve 任务书 18:33 创建、18:50 即被标 FAILED；其源任务 agent-backlog 已有正常 DONE → **误标**）。后果：daily-meeting 按 FAILED 误判 → 重复派发（与 08-12 intel-gatherer 发现的「乱码 DONE 导致重复派发」互为印证）。
- **83 个内容含 U+FFFD（UTF-8 但中文已损坏）**：其中 **37 个文件名正常但内容乱码**，损坏最重的：`hk-exec-hub.DONE`（2028 个 FFFD）、`chatroom-v3.DONE`（631）、`daily-meeting-2026-08-11-novel-improve.DONE`（413）、`daily-meeting-2026-08-11-pm-improve.DONE`（365）等。即 agent 汇报的中文在写入时已损坏。

### 1.3 产出文档层：13 个含 U+FFFD（知识库受损）

| 文件 | FFFD 数 | 影响 |
|------|---------|------|
| `knowledge/reviews/daily-material-2026-08-12.md` | **4611** | 当日复盘材料（review-loop 自动生成）主体乱码 |
| `knowledge/reviews/daily-material-2026-08-11.md` | 3372 | 前日复盘材料乱码 |
| `knowledge/channel-intelligence.md` | 3810 | **渠道情报核心知识库**；尾部 08-12 15:41/15:47 HK 侧增量全为乱码（intel-gatherer 声称"已补齐"但实际写入乱码——**验收时未发现，本次复盘揪出**） |
| `knowledge/reference-repos.md` | 若干 | 参考仓库表中文列损坏 |
| `artifacts/hk-hub-e2e-improve.md` | 若干 | e2e 验收报告标题/正文乱码 |
| `knowledge/meetings/*`（8 个） | 28~数百 | 例会纪要中文损坏 |

### 1.4 agents 记忆层：64 个文件含 U+FFFD

覆盖 30+ 个智能体的 `memory/diary.md`、`memory/index.json`、个别 `identity.json` 与 artifacts（如 `agents/coo/artifacts/nextday-...-P1-�ɷ�-improve.md`）。**日记/索引是各 agent 的记忆事实源，损坏后记忆读取会错乱**。

---

## 二、质量清单抽检（文件名+内容均正常的 DONE）

抽检最新 6 个正常 DONE（agent-rescue-core / uumit-capability-driven / ask-takina / ask-novel / ask-night-worker / ask-copywriting）：

- **完整性** ✅：均有目标/动作/结果/产物路径，非一句 DONE。
- **证据真实性** ✅：产物路径（artifacts/、sessions/）指向真实文件，自检数字（13/13、362 条、2703 字）具体可核。
- **回归/完成度** ✅：与任务书要求匹配，含验证描述。
- **结论**：正常链路 DONE 质量达标；问题不在正常链路，而在**编码污染链路**。

---

## 三、根因汇总（三源并流）

1. **bash/脚本传参中文损坏（主因，持续中）**：butler 派发 → bash 调 node/pi 传中文任务名 → U+FFFD 不可逆 → agent 写乱码文件名 DONE（46 个，08-12 20:16 仍在发生）。notify-encoding-fix 已修 hk-alert 通知链路（base64），但 **DONE 写入链路未修**。
2. **孤儿进程清扫误标 + GBK 写入（历史批量）**：08-11 18:50 一次批量将 65 个任务标 `.FAILED: 孤儿进程（PID 残留清理——进程已死）`，且以 **GBK 编码**落盘（非 UTF-8）。清扫机制直接覆盖写 DONE，未走真实执行，造成误标 FAILED → 重复派发。
3. **HK 侧增量回写乱码**：channel-intelligence.md 15:41/15:47 增量经 ssh 回写时中文损坏（3810 FFFD），intel-gatherer 报告未体现损坏。

---

## 四、质量门禁判定与处置建议

### 判定：**驳回（本轮存在大面积编码污染，禁止放行）**

| 项 | 判定 | 依据 |
|----|------|------|
| DONE 文件名 UTF-8 必杀项 | ❌ 违规 | 46 个 U+FFFD（含最新 08-12 20:16 产生） |
| DONE 内容 UTF-8 必杀项 | ❌ 违规 | 70 个 GBK + 83 个内容 FFFD |
| 产出文档 UTF-8 必杀项 | ❌ 违规 | 13 个知识库/复盘/验收文档 FFFD |
| 正常 DONE 质量三问 | ✅ 通过 | 抽检 6 个均达标 |

### 处置建议（打回经 coo 派发，reviewer 不代修）

1. **P0 修复 DONE 写入编码链**（night-worker）：派发/写 DONE 全程禁用 bash 中文传参；agent 侧 DONE 文件名必须从 .md 文件名派生而非从 argv；写文件强制 `utf8`。修后跑 3 个含中文任务名的真实派发验证文件名无 FFFD。
2. **P0 清理孤儿清扫误标**：65 个 `.FAILED: 孤儿进程` GBK DONE 统一重建为 UTF-8；对其中源任务已有正常 DONE 的 55 个 -improve 类核实后删除或标记非失败；清扫逻辑改为「删 PID 不覆盖 DONE」，禁止清扫器写 .FAILED。
3. **P1 知识库乱码修复**：channel-intelligence.md（HK 增量段）、daily-material-2026-08-11/12.md、reference-repos.md、meetings 8 个，损坏段重写或标注弃用。
4. **P1 agents 记忆层**：30+ agent 的 diary.md/index.json 含 FFFD 的，统一检测脚本扫出后逐个重建。
5. **机制防复发**：inbox 巡检脚本（butler/lib）加编码自检——文件名含 U+FFFD 或内容非 UTF-8 的 DONE 记日志告警；reviewer 验收清单加入「编码必杀项」作为第一问（本报告即为标准基线）。

---

## 五、验收复盘（本任务自身）

- 本报告基于全量扫描（800 DONE 文件名 + 内容、knowledge/artifacts/agents 三层），非抽样。
- 临时脚本 `scratch/qg-check*.py` 已清理；本报告为唯一产物。
- 结论：编码必杀项**必须前置**——先查编码，再过三问；本次发现说明既往验收漏了编码维度，channel-intelligence.md 乱码增量曾以"已补齐"通过，**复盘纠出**。

---
*生成：reviewer ｜ 2026-08-12 20:5x*
