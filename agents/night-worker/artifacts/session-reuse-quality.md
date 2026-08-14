# 会话复用 + 上下文压缩 + 交付质量自查（2026-08-12）

> 背景：用户批评三个长期问题——①智能体无限新开会话（上下文不延续，像失忆）；②上下文积累无压缩策略；③细枝末节（乱码/UI 塞不下）要用户一个个挑。
> 执行智能体：night-worker | 状态：✅ 落地完成 + 验证通过（含乱码根因修复）

---

## 一、会话复用（核心）

### 问题实证
- `lib/spawn.js` 每次任务强制唯一 session-id（`task-<agent>-<ts>`）→ 同智能体同主题任务上下文 100% 断裂
- night-worker 等智能体 291+ 会话文件全是单任务短会话（`sessions/` 153 + `archived-sessions/` 138），**auto-compaction 从未触发过**（0 个会话含 compaction entry）

### 机制设计（`org/lib/session-reuse.js` 新模块）
- **主题族（family）**：任务名前两个有效 token（滤纯数字/时间戳段）
  - `session-reuse-quality` → `session-reuse`
  - `nextday-2026-08-12-xxx-152618` → `nextday-xxx`（夜间任务族内再细分，不互污染）
  - `cnb-node-test-resume-verify` → `cnb-node`
- **复用判定**（全部满足才复用，缺一即新开）：
  1. 同 agent + 同 family（主题相关才复用，防上下文污染）
  2. 会话空闲（mtime 距今 > 2min，防与活跃任务并发写坏同一会话）
  3. 体积 < 512KB（≈5 万 token，防上下文爆炸——2026-08-10 隔离底线不破）
  4. 旧格式会话（无 family 的 `task-<agent>-<ts>`）**永不误配**（无法判断主题）
- **pi 原生支持**：`--session-id <id>` 语义 = 存在即续用、不存在即创建 → 复用/新开同一入口，RPC `prompt` 可连续追加（对话延续）
- **策略覆盖**：任务头 `session: reuse | new | <id>` 可显式声明（butler parseTask 解析），默认 auto
- **接线**：`lib/spawn.js` pi 分支默认 sessionId 改走 `computeSessionId`（id 含 family，新格式供下次复用）；`butler.js` 派发时传 `taskName` + `sessionPolicy`

### 安全设计
- 主题不匹配 → 永不混用（`session-reuse-quality` 与 `nextday-xxx` 各自成族）
- 会话体积超限 → 新开（不把巨型历史灌进新任务）
- 并发防护：mtime 空闲判定（正在跑的任务 mtime 持续刷新）
- 复用后长会话由 auto-compaction 兜底（见下）

---

## 二、上下文压缩（确认 + 显式化 + 长期积累）

### 现状确认
- pi auto-compaction **默认已启用**：`enabled: true`、`reserveTokens: 16384`、`keepRecentTokens: 20000`
- 触发条件：`contextTokens > contextWindow - reserveTokens`（deepseek-v4-flash 窗口 131072）
- 但子代理每次任务新会话 → 从未触发过压缩（无长会话）

### 落地
1. **~/.pi/agent/settings.json 显式化压缩配置**（新增 `compaction` 块）：
   ```json
   "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 30000 }
   ```
   keepRecentTokens 20K→30K：长任务保留更多近期细节，压缩更晚发生（flash 便宜量大，阈值更宽松合理）
2. **会话复用后长会话自动压缩生效**：同族任务复用 → 会话持续增长 → 超过阈值自动 summarize 旧内容（pi compaction 机制，结构化 summary + 文件操作累计跟踪）
3. **长期积累策略**（`org/scripts/archive-sessions.js` 新脚本）：
   - 扫描全部 `org/agents/*/sessions/*.jsonl`，mtime > 7 天 → 移入 `archived-sessions/`（历史可查、目录不失控）
   - 参数：`--days N`、`--agent <id>`、`--dry-run`
   - 已挂入 butler 周期维护（节流 6h，实际每天最多一次；只移 mtime 老的，活跃会话天然免疫）
   - 验证：`--days 1 --dry-run` 正确识别 123 个可归档会话（13.6MB）

---

## 三、交付质量自查（butler prompt 注入，全组织强制）

`butler.js` 派发 prompt 的"执行要求"后新增【交付前自查】块（**所有被派发的智能体自动获得**）：

```
【交付前自查（2026-08-12 强制执行，通过后才写 DONE）】
- 自查四项：① 编码——产物文本文件 UTF-8 无乱码（无 U+FFFD 替换符/问号块），DONE 摘要可读；
  ② UI/布局（凡涉及前端/面板/按钮/文本展示）——文本是否放得下、不溢出不截断、不同尺寸窗口不挤爆，
  ③ 内容完整性——需求逐条对照覆盖，产物文件存在且非空，关键数据齐全；
  ④ 需求覆盖——任务目标逐条打勾，未覆盖项必须说明理由
- 自查不通过 → 自己修 → 再自查，全过才写 DONE；不要交付后等用户来挑
```

---

## 四、乱码根因修复（E2E 发现的深层问题，超出原任务范围但必须修）

### 实证链
E2E 验证时发现：智能体用 bash 写中文 DONE → 会话里出现 U+FFFD 乱码 → 后续任务从上下文引用乱码传播。
逐层排查定位根因：**Git bash (msys) 的宽字符 argv → 多字节转换用 C locale，命令行里的中文全部变 `?`**（`printf '中文' | xxd` → `3f3f`）。这是历史 GBK 乱码 DONE 的根源之一（与 intel-gatherer 2026-08-12 发现的"GBK 损坏 DONE 文件名"同源）。

### 修复（`night-worker/scripts/hidden-bash.c` v3，已重编译替换 `pi_workspace/bin/hidden-bash.exe`）
- v1→v3 变更：`main` → `wmain`（无损 UTF-16 argv，避免 CRT 按 ACP/GBK 转码）
- `-c` 命令转 UTF-8 → 写入临时脚本 `%TEMP%\hb-<pid>-<rand>.sh` → 执行 `bash <脚本>`（argv 全 ASCII 无转码问题）→ 用完即删
- 对 pi 完全透明（仍以 `shellPath + -c` 调用）
- 验证：stdout/写文件/循环/引号/变量/退出码全通道 UTF-8 正确；旧 exe 备份为 `hidden-bash.exe.bak-20260812`

---

## 五、验证结果

| 项目 | 结果 |
|---|---|
| 单测 `test/session-reuse.spec.js`（族提取/候选/安全阀/策略） | ✅ 17/17 |
| E2E `scripts/e2e-session-reuse.js`（真实 pi 子代理 ×2 任务） | ✅ 任务 B 自动复用任务 A 会话（CURRENT_ID == TASK_A_ID），**凭上下文精确回忆出任务 A 指令且无乱码** |
| butler.js 自查块注入 / parseTask session 字段 / spawn 接线 | ✅ 代码级验证通过 |
| compaction 配置显式化 | ✅ settings.json 生效（pi 全局加载） |
| 归档脚本 | ✅ dry-run 正确识别 123 个候选 |
| 乱码修复 | ✅ 中文全通道 UTF-8（修复前 `中`→`?`，修复后 `e4b8ad` 正确） |

### E2E 关键证据（第二任务报告）
```
REUSED=true
TASK_A_ID=task-night-worker-session-reuse-1786539761001
CURRENT_ID=task-night-worker-session-reuse-1786539761001
RECALL=任务A指令：用bash读取本会话sessions目录下最新.jsonl的第一行，提取其中id字段，
写入artifacts/e2e-a.txt（格式一行SESSION_ID=<id>），并创建artifacts/e2e-a.DONE标记文件（一行摘要）。
本人已实际完成该任务。
```

---

## 六、文件清单

| 文件 | 变更 |
|---|---|
| `org/lib/session-reuse.js` | 新增：主题族提取 + 复用候选判定 + 策略计算 |
| `org/lib/spawn.js` | 修改：pi 分支 sessionId 走 session-reuse（含 family），记录 reuse 日志 |
| `org/butler.js` | 修改：parseTask 解析 `session:`；spawnAgent 传 taskName/sessionPolicy；prompt 注入交付自查块；周期维护挂会话归档 |
| `org/scripts/archive-sessions.js` | 新增：7 天会话归档 |
| `org/scripts/e2e-session-reuse.js` | 新增：E2E 验证脚本（可重复执行） |
| `org/test/session-reuse.spec.js` | 新增：单测 17 例 |
| `org/agents/night-worker/scripts/hidden-bash.c` | 重写 v3：wmain + UTF-8 临时脚本绕开 msys argv 转码 |
| `pi_workspace/bin/hidden-bash.exe` | 重编译替换（旧版备份 `.bak-20260812`） |
| `~/.pi/agent/settings.json` | 新增 compaction 块（keepRecentTokens 30000） |

## 七、待生效说明
- butler.js 改动（session 解析/自查块/归档挂载）随 butler 下次重启生效（当前 PID 17628 运行旧代码；已有 restart-butler-on-idle 预约机制，重启后自动加载）
- lib/spawn.js + session-reuse.js 是运行期 require，**新派发任务立即生效**（不依赖重启）
- hidden-bash.exe v3 已即时生效（pi spawn 按路径加载）
