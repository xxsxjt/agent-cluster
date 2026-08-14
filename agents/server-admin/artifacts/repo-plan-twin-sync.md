# 仓库 1-5 分配方案 + 分身思维同步验证

- 日期：2026-08-12 17:5x
- 执行：server-admin（任务 repo-plan-twin-sync）
- 依据：用户 2026-08-11 22:1x "本机作为最高权限总控和监控，其他全部任务都丢上去，现在有 1、2、3、4、5 仓库，让服务器那边看着分配，不够跟我说" + "服务器那边有同步我的分身思维吧"

## 一、5 仓库盘点与分配方案

### 1.1 现状盘点（cnb.cool 平台实测，API workspace/list + SSH 各空间）

| 空间 | slug | 状态 | 配置 | 现状 |
|---|---|---|---|---|
| 1 | xxssxx.top/1 | ✅ 运行中（cnb-glg-1jvqlteb2） | 8核16G Debian 13 | org 主仓 git clone（agents/knowledge/butler.js 全量），openjdk-21+gradle 8.14.3+pi 0.83.0 |
| 2 | xxssxx.top/2 | ✅ 运行中（cnb-et8-1jvqm1ikm） | 8核16G Debian 13 | workspace 空（8K），构建工具链已装，尚未挂载 org |
| 3 | xxssxx.top/3 | ✅ 运行中（cnb-42o-1jvqifs8h） | 8核16G Debian 13 | workspace 仅存储测试残留（persist-probe/test-persist），无 org |
| 4 | xxssxx.top/4 | ❌ **未创建** | — | cnb.cool 平台无此仓库（API 无创建端点，git ls-remote 无此仓库） |
| 5 | xxssxx.top/5 | ❌ **未创建** | — | 同上 |

> ⚠️ **关键差异报告**：用户以为有 5 个仓库，平台实际只有 1/2/3 三个仓库。4/5 需用户在 cnb.cool 网页端创建仓库后，服务器侧才能 start 空间接入。

### 1.2 分配方案（已落地 org.json spacePlan）

| 空间 | 角色 | 用途 | 状态 |
|---|---|---|---|
| 1 | dev-main | **开发主力**：org 框架/日常任务/编排主仓（git 同步通道） | active |
| 2 | build | **构建机**：Android/Java/Gradle/Maven 跨平台构建（工程同步上云落点） | active |
| 3 | test | **测试沙箱**：隔离测试/验证，不污染主力 | active |
| 4 | data | **大数据/存储**：归档、数据集、批处理（规划） | not-created |
| 5 | incubate | **新项目孵化**：内容出海/新业务试跑（规划） | not-created |

**分配逻辑**：
- 空间1 承接 org 主仓 git 通道（本机 push → 空间1 pull 同步），日常任务主执行点
- 空间2 专司构建（重活独立，不挤占开发），Android/MC 工程上云构建落点
- 空间3 测试隔离（跑测试不污染主力）
- 空间4/5 留给未来重负载（大数据/新业务），避免全压 1-3

**Android 工程同步上云评估**：工程代码 git 化（org 仓库/独立私有仓），构建重活路由空间2（已装 openjdk-21+gradle 8.14.3）；**不需要单独占一个空间**——构建在空间2 跑，代码走 git，空间1 已有 git 通道模式可复用。

### 1.3 落地项

1. `org.json` 新增顶层 `spacePlan` 字段（5 仓库角色/用途/状态，load-note 负载说明）
2. `scripts/cnb-ctl.js` CNB_SPACES 增加 4/5（slug+规划用途），`cnb-ctl list` 现显示 5 空间（4/5 0 实例=未创建）
3. 已提交 git 并推送 cnb 仓库（b37bf55）

## 二、分身思维同步（user-twin 脱敏版）

### 2.1 同步状态

| 端 | 路径 | 状态 | 校验 |
|---|---|---|---|
| 本机（git 源） | org/knowledge/twin-mind/SKILL.md | ✅ | 31765B，git 已跟踪 |
| HK | /data/agent-cluster/knowledge/twin-mind/SKILL.md | ✅ 已存在（08-12 12:57/13:53） | md5 与本地工作区一致（CRLF 原样 scp） |
| CNB 空间1 | /workspace/knowledge/twin-mind/SKILL.md | ✅ 已存在 | md5=0dec7589（LF）= git 跟踪版本（本地工作区 CRLF 去 \r 后一致） |

- 内容一致性确认：本地工作区（CRLF）→ `tr -d '\r'` 后 md5 = git 版本 md5 = 空间1 版本 md5 = `0dec75899dc1ff52ff6779d2763484b6`；HK = 本地工作区 scp 原样（CRLF），内容等价 ✓
- 机制：HK 走 dual-sync.js scp 同步（12:57 已同步）；CNB 走 git 通道（本机 push → 空间1 pull）

### 2.2 本次操作

1. 推送 git：`442063a..a79c925`（含 twin-mind 完整内容 + 修复）
2. 空间1 实例当时已回收（closed）→ `cnb-ctl start 1` 拉起新实例 cnb-glg-1jvqlteb2 → `git rebase origin/master` → HEAD=a79c925 → twin-mind 就位
3. 验证 CNB 执行任务可读：`/workspace/knowledge/twin-mind/SKILL.md` 存在且内容与本地 git 一致

### 2.3 隐私边界（已遵守）

- ✅ 仅同步 user-twin（脱敏：只留思维模式/决策启发式/心智模型，无原始聊天数据）
- ✅ user-profile（含微信画像/身份/账号）**未同步**——.gitignore 有 secrets/、*wechat*.json、agents/twin/ 等保护；user-profile 在 .agents/skills（本机全局 skill 目录），不在 org 仓库内
- ✅ 推送前审计：58 个未推送提交全量 diff，确认无 wechat/chat-session/user-profile 敏感文件

## 三、顺带修复（审计发现）

**隐私风险修复**：`agents/night-worker/archived-sessions/` 138 个会话归档 jsonl 于 08-05 sync 提交误入 git 跟踪（.gitignore 只覆盖 `sessions-archive*/`、`chat-archive*/` 下划线命名，漏了 `archived-sessions/`）：
- `git rm --cached -r` 移除跟踪（本地文件保留）
- .gitignore 补 `agents/*/archived-sessions/`
- 提交 a79c925 并推送——**远程 cnb/master 从未含这些文件（0 个），无历史泄漏** ✓

## 四、需要用户动作

1. **空间 4/5 未创建**：用户在 cnb.cool 网页创建仓库 xxssxx.top/4、xxssxx.top/5（平台 API 无创建端点），服务器侧即可 `cnb-ctl start 4/5` 接入
2. 若 4/5 用途想调整（大数据/存储 vs 新项目孵化），说一声即可改 org.json spacePlan
