# HK 管家 activating 循环根因修复（2026-08-13）

> 任务：hk-stable-popup-audit（server-admin）
> 结论：**根因已定位、修复已生效、当前稳定 active**（连续运行，NRestarts=1 无重启循环，0 新 ENOENT）

## 现象

- systemd `org-butler.service` 长时间 `activating`（非 active），journalctl 显示每 5 秒崩溃重启循环
- 用户多次遇到"管理员死机"类问题
- 崩溃错误：`Error: spawn pi ENOENT`（`Unhandled 'error' event` → 主进程崩 → Restart=on-failure → 循环）

## 根因（journalctl 证据链）

1. **首次出现（8/12 11:12）**：`spawn node ENOENT` —— systemd 环境 PATH 缺 `/usr/local/bin`，`spawn('node')` 找不到可执行文件。8/12 12:49 已创建 drop-in `path.conf`（`Environment=PATH=/usr/local/bin:/usr/bin:/bin`）解决。

2. **复发（8/13 01:59-02:02）**：`spawn pi ENOENT` 循环（每 5s 新 PID：2825990→2826035→2826077…）。**pi 明明在 /usr/local/bin/pi 且 PATH 已含 /usr/local/bin——根因不是 PATH，是 `cwd` 缺失**：
   - Node `child_process.spawn` 在 `cwd` 不存在时同样抛 ENOENT（err.path 显示命令名，极具迷惑性）
   - 实证：`/data/agent-cluster/agents/system-ops/` 与 `uumit-ops/` 目录被 root 清理重建（8/12 13:44，root:root 755），**缺 memory/sessions 子目录且 org-runner 无写权限**；cnb-build/cnb-test 等 agent 目录也有被清理历史
   - spawn('pi') 的 error 事件未监听 → `Unhandled 'error' event` → 主进程崩 → systemd 重启 → 循环

3. **8/13 02:03** 已加 `limit.conf`（StartLimitIntervalSec=300 / StartLimitBurst=15）防重启风暴（治标）。

## 修复（两步）

### A. 防御补丁（8/13 02:17 已由主会话/凌晨修复轮同步，本机同源 lib/spawn.js 已 git 提交 73a0c26）
- `ensureWorkdir(cwd)`：spawn 前自动补建 agent 目录 memory/sessions，防 cwd 缺失 ENOENT
- `armErrorGuard(child)`：spawn 失败只记 logs/spawn-debug.log + 标记任务失败，**绝不抛 Unhandled 崩管家**
- 补丁注释明确标注："2026-08-13 HK 管家 systemd activating 循环：spawn pi ENOENT 未监听 → 每 5s 重启一次"

### B. server-admin 补漏（本次任务）
- `system-ops` / `uumit-ops` / `ds-bridge` / `hk` 四个 agent 目录：`chown -R org-runner:org-runner` + 补建 memory/sessions
- 写入验证：`sudo -u org-runner touch .../.wtest` → WRITE_OK
- 防同场景复发（root 属主 + 目录缺失 = 派发该 agent 任务必失败）

## 验证（8/13 02:25 实测）

| 项 | 结果 |
|---|---|
| systemctl is-active | **active**（02:19:33 起连续运行 6min+） |
| NRestarts | 1（无重启循环） |
| 02:19:33 后 ENOENT | 0 |
| pi 子任务派发 | 正常（night-worker/system-ops daily-meeting 已派发运行） |
| systemd 单元 | ExecStart 用绝对路径 /usr/local/bin/node + PATH drop-in + 重启风暴限制，三层齐备 |

## 后续建议

1. 观察 24h 确认无复发；复发时 journalctl 第一查 `logs/spawn-debug.log`（armErrorGuard 落地后所有 spawn 失败都有留痕）
2. HK `/data/agent-cluster` 非 git 仓库——改动靠本机 org 同步，建议 HK 侧也 git init 防漂移（可选）
3. 崩溃循环期间积压的 daily-meeting 任务已由 auto-optimize 自动重跑恢复，无需人工干预
