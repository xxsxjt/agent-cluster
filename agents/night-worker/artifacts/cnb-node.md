# CNB 空间1 接入智能体集群（开发执行节点）

- 日期：2026-08-09 02:3x（UTC+8）
- Agent：night-worker（provider: opencode-go / deepseek-v4-flash）
- 范围：CNB 云开发空间1 环境初始化 + pi CLI 部署 + 集群节点接入 + 任务分流验证

---

## 1. 环境初始化（CNB1，root，Debian 13）

SSH：`ssh -i C:\Users\du_ji\.ssh\id_rsa_cnb -4 cnb-gls-1jvh9pvfd-001.c57579b7-31ca-4066-9f99-554e02bec416-7hg@cnb.space`

| 项 | 状态 |
|---|---|
| 系统 | Debian GNU/Linux 13 (trixie)，x86_64，8 核 / 16GiB / 磁盘 256G |
| curl/wget/git | 自带 ✅ |
| node | v22.23.1（自带，npm 10.9.8 **正常可用**——HK 同版本坏但 CNB 正常，直接用 npm -g）|
| pi CLI | `npm install -g @earendil-works/pi-coding-agent@0.83.0` → `/usr/local/bin/pi` = 0.83.0 ✅（与 HK/本机版本一致）|
| openjdk | `apt install openjdk-21-jdk-headless` = **21.0.11**（Debian 13 无 openjdk-17，用 21）|
| gradle | 下载 **8.14.3** 稳定版装到 /opt/gradle，symlink /usr/local/bin/gradle（apt 只有 4.4 太旧，手动装最新）|
| 执行目录 | `/data/cnb-org/{inbox,logs,tasks}` ✅ |

## 2. pi 配置（CNB 跑模型用）

- 精简 `~/.pi/agent/models.json` + `auth.json`，仅 3 个可信渠道：**opencode-go / deepseek / aliyun-tokenplan**（key 从本机原样搬运，不入报告）。未复制 sub2-luna/omniroute 等黑名单第三方渠道。
- 已验证 pi 在 CNB 通过 opencode-go/deepseek-v4-flash RPC 成功跑通（见 §4）。

## 3. 集群节点接入（org.json + 路由）

### org.json
- 新增节点 `cnb-dev`：label「CNB 开发节点（空间1）」、role dev、parent `grp-cloud`、spawnType `pi`、`remoteSide: cnb`、`space: 1`。
- `grp-cloud.children` 加入 `cnb-dev`。备份 `org.json.bak-cnb-20260809`。
- 身份 `agents/cnb-dev/identity.json`（capabilities: build/gradle/maven/npm/java/git/pi-cli，含 SSH host/key 供参考）。

### 执行链路（SSH 桥，仿 HK hk-task）
- `scripts/cnb-task.js`：本机→CNB SSH 桥（scp 投递 → 拉起 CNB 端执行器 → 轮询 .DONE → 拉回日志/结果）。支持 `--space 1|2|3`（空间 2/3 主机映射待用户启动后补）。可达性检查快速失败——CNB 空间可能休眠，SSH 失败会提示"空间休眠请启动后重试"，幂等可重试。
- `scripts/cnb-exec.js`（CNB 端）：读任务文件 → 提取 ```bash/sh 代码块执行 → 按 .DONE 路径写终态。

### butler.js + route-auto.js 路由（构建类→CNB）
- `lib/route-auto.js` 重构 `pickSide(task)` 返回 `local|hk|cnb`：
  - 服务器/重活标记 → `hk`（ssh/scp/部署/systemctl/docker/大计算）
  - Windows 专属构建（msvc/msbuild/visual studio/dotnet/.exe/win构建）→ `local`
  - **跨平台构建（gradle/maven/npm build/compile/android/apk/go build/tsc）→ `cnb`**
  - 其余 → `local`（安全默认）
- `butler.js`：routeTask 加 `target: cnb` + auto 判侧命中 cnb；dispatch 加 `dispatchToCnb`（仿 dispatchToHk，调 cnb-task.js）；任务头解析加 `space:` 字段。
- 单元测试：9 组样例全部命中预期（gradle→cnb、npm build→cnb、exe打包→local、msbuild→local、部署nginx→hk、android apk→cnb 等）。

## 4. 任务分流验证（端到端）

派测试任务 `cnb-node-test`（生成环境快照 + pi RPC 跑模型），经 `cnb-task.js` 投递到 CNB：

**环境快照**（CNB 真实输出）：
```
主机名: 5f458bab9219   系统: "Debian GNU/Linux 13 (trixie)"
CPU 核数: 8   内存: 16Gi
node: v22.23.1   java: 21.0.11   gradle: Gradle 8.14.3   pi CLI: 0.83.0
```

**pi RPC 跑模型**（opencode-go / deepseek-v4-flash）：
```
{"id":"p-cnb-verify","type":"response","command":"prompt","success":true}
```
→ **CNB 端 pi 成功连接模型渠道并处理 prompt**，AI 能力验证通过 ✅。

桥全程：CNB 可达 → scp 投递 → 拉起 cnb-exec → 1 代码块执行 → .DONE 拉回本地 inbox，E2E 秒级闭环。

## 5. 遗留 / 后续

1. **butler 路由需重启生效**：运行中的 butler（PID 35404）为旧代码，`dispatchToCnb` + auto 路由（构建→cnb）需重启但ler 才生效。按 interconnect-final 的**延迟重启策略**（等当前任务 .DONE 退出后再重启），未在此刻强杀。重启：`scripts/bootstrap.js start`。
2. **CNB 空间可能休眠**（云开发环境闲置回收）：派发时 SSH 失败会提示启动空间，幂等可重试。
3. **空间 2/3 待接**：用户启动空间后，往 `scripts/cnb-task.js` 的 `CNB_SPACES` 补 host 映射 + org.json 加节点即可（流程同上）。
4. **Android SDK 未装**：路由已含 android/apk→cnb，但 CNB 暂无 Android SDK（需时按需装，体积大）。
5. **CNB 端无常驻进程**：cnb-exec.js 由桥按需拉起（nohup 单次），无 daemon/systemd——对可能休眠的云空间更稳（无需守护，唤醒即用）。

## 6. 保密
- 全文不含任何明文 token/凭据；CNB pi 配置（models.json/auth.json）权限 600，仅含可信渠道，黑名单第三方渠道未复制。
