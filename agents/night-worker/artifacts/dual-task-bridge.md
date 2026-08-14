# 本机 → HK 任务分发桥（dual-task-bridge）—— 报告

- 任务：dual-task-bridge（长任务/重活挂 HK 执行，分担 Windows 负载）
- 执行：night-worker · 2026-08-07 02:30-02:40
- 前置：hk-org-deploy（HK org 框架 3 服务 active）、hk-pi-cli（HK pi CLI 0.83.0 + 本地 new-api 渠道）
- 保密：全文不含任何明文 key/token；SSH 凭据走 `~/.ssh/id_ed25519_xxsx_hk` 路径引用

---

## 一、交付物

| 文件 | 作用 |
|------|------|
| `scripts/hk-task.js`（新增，~260 行） | 桥本体：本地任务文件 → scp HK inbox → 轮询 .DONE/.FAILED → 拉回本地 inbox + HK 日志/结果 |
| `butler.js`（增强 3 处，已重启生效） | ① parseTask 解析 `target:`/`timeout:` 头部；② routeTask 对 `target: hk` 直接返回 'hk'；③ dispatch 加 `dispatchToHk()` 分支——spawn `node scripts/hk-task.js <taskfile> --wait`，active 管理/完成标记/日志收尾完全复用主流程 |
| 测试任务 ×3 | `hk-cpu-test` / `hk-cpu-test2` / `hk-butler-e2e`（.md 已归档 inbox/archive/，.DONE 留档） |

## 二、用法

任务文件头部声明（本机 inbox 投递即可，butler 自动识别）：

```md
agent: server-admin   # HK 端路由节点（HK org.json 已同步）
target: hk            # 关键：走 HK 远程执行桥
timeout: 300          # 可选：最大等待秒数（默认 7200）
```

任务正文可含 ` ```sh ` 代码块（HK 端 hk-exec 执行）；结构化结果约定：
**代码块内把结果写入 `/data/agent-cluster/logs/<任务名>.result`**，桥完成时自动拉回本地 `logs/<任务名>.hk.result`。

手动模式（不经 butler 也行）：

```bash
node scripts/hk-task.js inbox/xxx.md --wait --timeout 3600   # 投递并等待结果
node scripts/hk-task.js inbox/xxx.md --no-wait               # 只投递，稍后重跑 --wait 拉取（幂等）
```

## 三、验证结果（全部通过 ✅）

| # | 验证项 | 结果 |
|---|--------|------|
| 1 | 手动桥链路 | ✅ 投递 → HK butler 捡起（≤15s）→ hk-exec 执行 → .DONE + 日志 + 结果回传 |
| 2 | HK 真实执行 | ✅ `hk-cpu-test2`：8M 迭代 CPU 计算 3.18s 在 HK 完成（4 核），结果 `calc_8M_iter: 3.18s sum_mod=770959186` 回传 |
| 3 | 本机无负载 | ✅ 任务期间本机 CPU 仅 6%（只跑轻量轮询），计算负载全在 HK |
| 4 | butler 自动路由 | ✅ `hk-butler-e2e` 投 inbox 后 butler.log：`🚀 HK 投递 [hk-butler-e2e] → scripts/hk-task.js` → `HK 桥进程退出 code=0` → `✅ 任务完成`（E2E 闭环 18s） |
| 5 | 幂等 | ✅ HK 已有 .DONE 时跳过投递直接拉回（重复 --wait 不重跑任务） |
| 6 | 失败/超时兜底 | ✅ HK 不可达/投递失败/超时均写本地 `.FAILED` 并退出非 0（butler 正常收尾） |

## 四、踩坑记录（已修复）

1. **Windows scp 端口参数是 `-P`（大写）**，`-p` 被 scp 当作本地文件名 → 首版投递失败；ssh 用 `-p`、scp 用 `-P` 已分开处理。
2. **HK sshd 老版本无 post-quantum 交换**：本机 OpenSSH 每次连接 stderr 打 PQ 警告（无害），且远端 `test -f` 未命中时 exit code=1 被误判 ssh 失败 → 轮询全红。修复：ssh() 过滤 PQ 警告行、以 stdout 内容为准（`ok` 不再依赖 exit code）。
3. **HK hk-exec 需要 .DONE 路径提示**：scp 的原始任务文件不含「创建标记文件（一行摘要）：<路径>」行 → 桥投递时自动追加执行要求包装块（临时文件 staging → scp 后删除）。

## 五、边界与后续

- ✅ 本地 butler 已重启加载新代码（PID 37808）；HK 端零改动（桥是纯本地层）
- ✅ 测试任务 .md 已归档 inbox/archive/，.DONE 留档；HK inbox 测试文件保留（HK butler 有 .DONE 不会重跑）
- 桥只做传输/轮询，任务执行完全由 HK butler 按 HK org.json 路由（agent: server-admin → hk-exec；HK 有 pi CLI，pi 型节点任务也会正常跑）
- 后续可扩展：T3 本地控制台服务器树（独立任务）、批量投递（for + --no-wait）、HK 任务超时 kill
