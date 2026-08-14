# HK 部署智能体集群框架（T1）—— 部署报告

- 任务：hk-org-deploy（T1：HK 部署 org 框架，为取代服务器 ai助手 打地基）
- 执行：night-worker · 2026-08-06 16:2x-16:4x
- 服务器：HK（100.97.18.59，Tailscale 直连）
- 前置探索：`artifacts/dual-cluster-explore.md`（本任务为其中 T1+T2 合并落地）
- 保密：全文不含任何明文 token/凭据（web token 只存 HK 本地 600 权限文件）

---

## 一、同步清单（白名单，本地 → HK `/data/agent-cluster`）

本地 `C:\Users\du_ji\pi_workspace\org` → HK `/data/agent-cluster`（tar 打包 + scp + 解包，160K）：

| 类别 | 内容 |
|------|------|
| 根文件 | org.json、butler.js |
| lib/ | memory.js、model-router.js、registry.js、spawn.js、twin-daemon.js、twin-log.js（全部） |
| scripts/ | bootstrap.js |
| web/ | server.js、app.js、index.html、style.css、selftest.js、vendor/vue.global.prod.js |
| knowledge/ | assets.md、changelog.md、conventions.md、pitfalls.md、reference-repos.md、references-*.md（全部 8 个） |
| agents/ | 15 个 identity.json + twin/AGENTS.md + coo/AGENTS.md（仅骨架与人格，**不含** chat/、memory/、tasks/、sessions/、artifacts/ 等数据） |

**排除**：inbox/、logs/、agents/*/chat/、任何 secrets/.env/凭据、night-worker 工作产物。

**本地零改动**：只读打包，未修改/删除本地任何文件；本地 butler/twin 进程未受扰动（PID 正常存活）。

## 二、HK 端适配补丁（最小侵入，均已备份）

HK 无 pi/claude CLI，原版 spawn.js 硬编码 `cmd.exe`（Windows 专属）会导致 HK 上派发任务时 butler 崩溃。打两处补丁：

### 1. `lib/spawn.js`（备份 `lib/spawn.js.orig-hk-20260806`）
- `spawnAgent()` 入口：非 Windows 平台下 `type==='claude'|'pi'` → 回退 `'hk-exec'`（node 直执行）
- 新增 `hk-exec` 分支：`spawn('node', [hk/hk-exec.js, agentId, agentDir])`，任务内容经 stdin 传入
- 所有子进程统一挂 `child.on('error')` → 写 spawn-debug.log（防 unhandled error 崩溃管家）
- ⚠️ 补丁执行中踩坑：首轮 sed 脚本漏改首个 `if (type === 'claude')`（其余是 `else if`），导致仍走 cmd.exe 分支报 ENOENT；已补改并重启但 butler 验证

### 2. `lib/twin-daemon.js`（备份 `lib/twin-daemon.js.orig-hk-20260806`）
- 非 Windows 且无 `PI_BIN` 时：分身大脑（pi rpc 子进程）**禁用**，直接返回 dead stub——巡查/状态/TCP 通道照常
- `brainAsk` 对 dead stub 返回友好 503：「HK 端无 pi CLI，分身大脑不可用（T5 将接入 hermes/API）」

### 3. 新增 `hk/hk-exec.js`（71 行，node 直执行器）
- 从 stdin 读任务全文 → 提取 `.DONE` 路径（「创建标记文件（一行摘要）：<路径>」）→ 执行 ```sh/bash 代码块（可选）→ 写 .DONE / .FAILED
- 这是 HK 端「轻执行」模式的地基：后续 API 调用型任务可直接在此扩展

## 三、systemd 单元（3 个，参照 xxsx-hermes.service 风格）

| 单元 | 进程 | ExecStart | 资源上限 |
|------|------|-----------|----------|
| org-butler.service | 管家 | `/usr/local/bin/node /data/agent-cluster/butler.js` | MemoryMax=384M、CPUQuota=100%、TasksMax=128 |
| org-twin.service | 分身巡查 | `/usr/local/bin/node /data/agent-cluster/lib/twin-daemon.js` | MemoryMax=384M、CPUQuota=50%、TasksMax=128 |
| org-web.service | web 控制台 | `node web/server.js --host 100.97.18.59 --port 8788` | MemoryMax=256M、CPUQuota=50%、TasksMax=64 |

- 专用用户 **org-runner**（system 用户，nologin），`/data/agent-cluster` 属主 org-runner
- 沙箱对齐 hermes：NoNewPrivileges/PrivateTmp/PrivateDevices/ProtectSystem=full/ProtectHome/ProtectKernel*/Restrict*/LockPersonality/RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/SystemCallArchitectures=native，ReadWritePaths=/data/agent-cluster
- UMask=0077、Restart=on-failure（5s）、TimeoutStopSec=30、KillSignal=SIGINT
- 三个单元均 `enabled`（开机自启）+ `active`
- web token：`openssl rand -hex 24` → `/etc/org-agent-cluster/web.env`（chmod 600，EnvironmentFile 引用，**不入本报告**）

## 四、验证结果（全部通过 ✅）

| # | 验证项 | 结果 |
|---|--------|------|
| 1 | `systemctl is-active org-butler org-twin org-web` | 全 active |
| 2 | `systemctl is-enabled` | 全 enabled（开机自启） |
| 3 | 本地经 Tailscale `curl http://100.97.18.59:8788/api/state`（带 token） | ✅ 返回组织树，21 节点，`ok:true`，orgRoot=/data/agent-cluster |
| 4 | 无 token / 错误 token | 401 拒绝 ✅ |
| 5 | 静态页面 `/?token=` | 200 ✅ |
| 6 | `/api/agent?id=server-admin` | ✅ 返回节点详情（含 label/agentDir/spawnType） |
| 7 | butler 日志 | 启动正常、无崩溃循环；HK 端 org.json 运行时状态正常更新（lastTaskAt/lastDoneAt） |
| 8 | twin-daemon 日志 | 启动正常，「分身大脑禁用（HK 无 pi）」按预期降级；TCP 18788 通道已开 |
| 9 | **空任务闭环** | 投递 `inbox/hk-smoke-test.md`（agent: server-admin）→ 派发（PID=680879）→ hk-exec 执行 code=0 → `.DONE`：「✅ hk-exec 空任务完成」✅ |
| 10 | 本地 org 完整性 | 打包后本地文件 mtime 未变、本地 butler/twin 正常、无反向污染 |
| 11 | hermes 共存 | `xxsx-hermes.service` 全程 active，未停止未修改 |
| 12 | 日志体积控制 | 新增 `/etc/logrotate.d/agent-cluster`：daily / rotate 7 / maxsize 20M / compress / copytruncate |

### 端口变更说明（重要）
探索方案原定 8787，但 **8787 已被 `xxsx-games.service`（XXSX Games room relay，127.0.0.1:8787，跑 4 天+）占用** → HK org web 实际使用 **8788**（绑定 tailscale0 100.97.18.59）。

### 防火墙
`tailscale0` 加入 firewalld **trusted zone**（permanent + reload）——8788 仅 Tailscale 内网可达；公网 eth0 zone 未开放 8788。Token 鉴权双保险。

## 五、资源占用（hermes 共存）

| 项 | 值 |
|----|-----|
| org-butler | ~54 MB RSS |
| org-twin | ~56 MB RSS |
| org-web | ~55 MB RSS |
| **org 合计** | **~165 MB**（远低于各单元 384M 上限） |
| 服务器总内存 | 3878 MB 总 / 1686 MB available（部署后仍余 1.6G+） |
| 磁盘 | /data 剩 9.0G（agent-cluster 仅 160K 代码 + 日志） |
| xxsx-hermes | active，未受影响 |

## 六、边界与后续

- ✅ 未停止/修改 hermes；未删服务器任何现有文件；同步白名单单向（本地→HK），不反向
- ✅ 补丁全部有 .orig 备份；web token 不落报告不入 git
- ⚠️ HK 端任务目前只能走 **node 直执行**（hk-exec 代码块）或 API 调用模式——后续 T4/T5 接入 hermes/new-api 做重活
- 下一步（T3）：本地 server.js 加 `/api/remote/state` 代理 → 本地控制台并排渲染「服务器集群」树
- 下一步（T6）：单向同步脚本落地时，注意 HK 端 spawn.js/twin-daemon.js 补丁需在同步后重放（或纳入同步白名单脚本）
