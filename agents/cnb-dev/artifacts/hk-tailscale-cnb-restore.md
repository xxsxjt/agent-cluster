# hk-tailscale-restore 完善 + 补验记录（cnb-dev，2026-08-11 19:1x）

任务：hk-tailscale-restore-improve（由分身-管家讨论派发，agent=cnb-dev）

## 一、源任务失败原因（查明）
- 源任务 `hk-tailscale-restore.DONE` 内容为 `.FAILED: <乱码>`（编码损坏，无法读取具体原因）。
- 源任务无 artifact 产出（`agents/cnb-dev/artifacts/` 下无 hk-tailscale 相关文件），说明源任务未实际完成执行即标记失败。
- 本次逐项实测查明**真实情况**：HK 侧 Tailscale 服务本来就正常；真正断链的根因在本机。

## 二、根因分析
### 1. HK 侧 Tailscale：正常，无需修复
- `tailscale status`（HK 上）：HK 节点 `xxsx-main-hk 100.97.18.59` connected；tailscaled.service active (running) 自 8-07 起；crond active+enabled。
- HK 侧服务无故障。此前"SSH 超时"是因为本机节点离线导致经 Tailscale IP(100.97.18.59) 的链路断，但**公网 SSH(103.100.159.111:43891) 一直通**。

### 2. 本机（Windows）Tailscale 离线：真实根因，需用户重新认证
- 本机 tailscaled 卡 `NoState`，`tailscale status` 报 "Tailscale is starting. Please wait."
- 日志根因（`%ProgramData%\Tailscale\Logs\tailscale-service-*.txt`）：
  - `profile data directory: profile not found`
  - `Switching ipn state NoState -> NeedsLogin (WantRunning=false)`
  - `health(login-state): error: You are logged out. The last login error was: fetch control key: ... context canceled`
- 诊断结论：本机 profile 登录凭据丢失——`profile-data/23b5/` 目录下只有空 `netmap-cache` 目录，无实际登录 key 文件；daemon 因此判定 logged out（loggedIn=false），无法用已保存身份连接协调服务器。
- 已排除网络因素：controlplane.tailscale.com 经代理(127.0.0.1:7890)与直连均可达（HTTP 302）。
- **这是既有已知卡点**（此前 review-batch-123045 / channel-intelligence 已记录：本机 Tailscale NeedsLogin，需 GitHub OAuth 交互式或 authkey，执行者无法独立完成）。

## 三、本次完成的修复/部署
### HK 侧 CNB 保活部署（源任务第 2 目标，本次实际落地）
1. 从本机 DPAPI 仓取 `cnb_git_token`（脱敏，未回显明文）并 scp 到 HK；scp 脚本 `hk-cnb-pull.sh` 与 SSH key `id_rsa_cnb` 到 HK `/root/.ssh/`。
2. HK 上执行 `hk-cnb-pull.sh <token>`：
   - token 写入 `/data/agent-cluster/secrets/cnb-token`（600）
   - 保活脚本 `/usr/local/bin/cnb-keepalive-hk.sh`（24/7 心跳+自动重启被回收空间）
   - cron `/etc/cron.d/org-cnb-keepalive`（每 5min 保活）+ `/etc/cron.d/org-git-sync`（每 10min git pull）
3. 确认 HK cron 调度机制：HK 用 **crond.service**（Vixie，非 cron.service），active+enabled，故 cron.d 规则生效（源脚本部署时可正常执行）。

## 四、验证证据
- **HK 保活 cron 每 5min 实际执行**：`/data/agent-cluster/logs/cnb-keepalive.log` 显示 18:50→19:09 连续 `xxssxx.top/1|2|3 heartbeat ok`；且空间1/2 被回收 closed 后自动 `start 已提交`。
- **CNB 三空间均 running**（`node scripts/cnb-ctl.js list`）：
  - 空间1 `cnb-m31-1jvo87aaq` running（19:09 保活自动 start）
  - 空间2 `cnb-2a8-1jvo87ai2` running（19:09 保活自动 start）
  - 空间3 `cnb-jio-1jvo7q0g3` running（heartbeat 维持）
- **HK 侧 Tailscale 正常**：tailscaled connected、crond active+enabled。
- **git 同步主端正常**：本机 `logs/git-sync.log` 显示 18:47-19:07 连续 commit+fetch+rebase+push 成功，cnb remote 指向 cnb.cool/xxssxx.top/1。

## 五、遗留（未完成项，如实记录）
1. **本机 Tailscale 重新认证（需用户介入）**：本机 profile 登录凭据丢失，daemon 判定 logged out。修复需
   - 方式 A：用户在本机执行 `tailscale up`，按提示在浏览器完成 GitHub OAuth 登录（交互式）；或
   - 方式 B：在 Tailscale admin console 生成 authkey 提供（`tailscale up --authkey <key>`）。
   - 非执行者（cnb-dev/agent）能独立完成，已如实标记，不谎报已恢复。
2. **HK org git 化未做（有覆盖风险）**：`/data/agent-cluster` 是手动部署的 HK org 实例（butler/twin 在跑），**非 git 仓库**。`org-git-sync` cron 每 10min pull 因非 git 仓库而失败（stderr 已丢弃，不会刷屏/损坏，仅 pull 不生效）。要打通 HK 作为第二节点 git 拉取，需将 HK org 安全纳入 git（风险：可能覆盖 HK 本地运行文件），属 cnb-sync 架构改造，本次未强行操作。
3. HK 侧 tailscale 链路恢复正常后，本机节点上线即恢复 HK→本机 8787 的 Tailscale 通道（app-fixes-b 曾用 cloudflared 隧道替代）。

## 六、结论
- 源任务核心验收点中，**HK 侧 CNB 保活部署已完整落地并验证生效**（三空间 running + cron 每 5min + 自动恢复回收空间）。
- **HK 侧 Tailscale 本无故障**；真正的链路断根因是本机节点离线，需用户重新认证（无法自动）。
- 本次为"完善/补验"任务：补足了验证证据、完成了可自动化的 HK 保活部署、查明了失败根因，并对无法自动的项如实标记。
