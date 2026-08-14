# HK 泰拉瑞亚 2 人服务器部署报告（TShock）

- 日期：2026-08-06 23:51
- 执行：night-worker
- 服务器：HK（Rocky Linux 9.7，4核/3.8G）

## 方案选择：TShock 6.1.0

采用 **TShock 6.1.0**（for Terraria 1.4.5.6，官方 Pryaxis 最新版），理由：
- 权限/管理/防作弊体系完善（组权限、注册登录、封禁、白名单、命令面板）
- 相比官方 TerrariaServer 更适合 2 人好友服（可设密码 + 注册制 + 人数限制）
- 基于 .NET 9（本次已同时安装 dotnet-runtime-8.0 和 9.0；TShock 6.x 实际需要 .NET 9，8.0 保留备用于其他场景）

## 安装配置

| 项目 | 值 |
|---|---|
| 安装路径 | /data/terraria/tshock/（TShock 主程序，96M） |
| 世界文件 | /data/terraria/worlds/HKWorld.wld（小世界 2.9M） |
| 世界配置 | 小世界 / 专家难度 / 腐化世界 / 世界名 HKWorld |
| 端口 | 7777/tcp（0.0.0.0 全接口监听，公网+Tailscale 均可连） |
| 最大玩家 | **2**（MaxSlots=2） |
| 服务器密码 | 已设置于 config.json（16 位随机强密码，存 /data/terraria/.server-pass root:600，不入本报告） |
| UUID 自动登录 | 已禁用（DisableUUIDLogin=true，防冒用） |
| 服务器名 | "HKWorld 2P" |

配置备份：`/data/terraria/tshock/tshock/config.json.bak-20260806`

## systemd 服务（terraria.service）

- 专用用户 `terraria`（nologin，数据目录 owner）
- ExecStart：`TShock.Server -world /data/terraria/worlds/HKWorld.wld`
- MemoryMax=1024M（实测空闲约 340-400M，峰值 407M）
- Restart=on-failure / RestartSec=5 / 开机自启（enabled）
- NoNewPrivileges + PrivateTmp 加固

## 端口与连接方式

- **公网连接**：`103.100.159.111:7777`（HK 公网 IP，TCP 握手验证 ✅）
- Tailscale：`100.97.18.59:7777`（本机验证 ✅）
- firewalld 已永久放行 7777/tcp（public zone）
- 客户端需 Terraria **1.4.5.6** 版本（与 TShock 6.1.0 协议一致）

## 安全决策说明

- **公网可达**（用户需和朋友玩，朋友无 Tailscale）→ 三层防护：① 16 位随机强密码（进服必需）② TShock 注册制（新玩家须注册账号，进服前自动登录验证）③ 最大玩家 2 人硬限制
- UUID 自动登录已关闭：服务器公开，防止玩家 UUID 泄露被冒用自动登录
- 密码只存 HK 本地（/data/terraria/.server-pass，root 可读），报告不含明文

## 首次使用指引（服主）

1. 首次进入游戏：连接 `103.100.159.111:7777`，输入服务器密码
2. 进服后执行 `/setup 7585000` 获取服主权限（TShock 一次性认证代码，已在服务器日志/ setup-code.txt 中）
3. 注册账号：`/register <密码>`，此后登录 `/login <密码>`
4. 朋友进服：提供服务器密码 + 他们自己注册账号即可

## 资源占用

- 空闲内存：~340-400M（上限 1G），服务器整体可用内存 1.5G，无压力
- 世界生成已完成，运行时 CPU 占用低（负载已回落）

## 验证结果

- ✅ systemctl active（含重启稳定性测试：restart 后 15s 内恢复监听）
- ✅ 端口监听 0.0.0.0:7777
- ✅ 日志无错误，世界加载成功，"服务器已启动"
- ✅ 本地 TCP 握手成功
- ✅ 公网 103.100.159.111:7777 TCP 握手成功

## 回滚

```bash
systemctl disable --now terraria
rm -f /etc/systemd/system/terraria.service && systemctl daemon-reload
rm -rf /data/terraria /root/.local/share/Terraria
firewall-cmd --permanent --remove-port=7777/tcp && firewall-cmd --reload
dnf remove -y dotnet-runtime-9.0 dotnet-runtime-8.0
```

## 备注

- .NET 8 为安装时顺带安装（Rocky AppStream 默认），TShock 6.1 实际需要 .NET 9；若日后确认无他用可移除 8.0
- 世界难度选专家（用户未指定，取适中档）；如需经典/大师难度可删世界重生成（交互式 n 新建）
- setup 认证码为一次性管理入口，若泄露可重启服务获取新码（setup-code.txt 更新）

---

## 世界重建为旅行模式（2026-08-07 01:00）

- 执行：server-admin / terraria-journey
- 变更：专家模式（Expert）→ **旅行模式（Journey）**

### 操作记录

| 步骤 | 结果 |
|---|---|
| 停止服务（主会话已做） | `systemctl stop terraria` |
| 旧专家世界备份（主会话已做） | `/data/terraria/worlds/HKWorld-expert.bak-20260807`（2961313 字节）|
| 原 HKWorld.wld 删除（主会话已做） | 已删 |
| 旅行模式世界生成 | `TShock.Server -autocreate 1 -worldname HKWorld -world /data/terraria/worlds/HKWorld.wld -difficulty 3` |
| 难度确认 | 生成日志：`Creating world - Seed: 1211498039, Width: 4200, Height: 1200, Evil: -1, Difficulty: 3` ✅ |
| 文件属主修正 | `chown terraria:terraria HKWorld.wld` |
| 服务启动 | `systemctl start terraria` → active (running) ✅ |
| 端口验证 | `0.0.0.0:7777` LISTEN ✅ |
| config.json 未改动 | ServerPassword/MaxSlots=2/DisableUUIDLogin=True/ServerName 均原值 ✅ |
| Users 表 | COUNT=0（服主首次注册机制有效）✅ |

### 注意事项

- **腐化类型**：TShock 6.1.0 不接受 `-worldevil` 参数（初始化报错并终止），世界由底层 Terraria 引擎以 `Evil: -1`（随机）生成。实际腐化/猩红类型需进游戏确认；如需指定腐化，可删除 HKWorld.wld 后改用交互式生成（n→1→4→0→HKWorld）。
- **旧专家世界备份路径**：`/data/terraria/worlds/HKWorld-expert.bak-20260807`

### 连接信息（不变）

- 公网：`103.100.159.111:7777`，客户端 Terraria 1.4.5.6
- Tailscale：`100.97.18.59:7777`

---

## 世界重建为专家模式（2026-08-07 02:50）

- 执行：server-admin / terraria-expert
- 变更：旅行模式（Journey）→ **专家模式（Expert）**
- 原因：TShock 6.1 + 1.4.5.6 下旅行模式共享研究被官方硬禁用，用户放弃旅行模式

### 操作记录

| 步骤 | 结果 |
|---|---|
| 停止服务 | `systemctl stop terraria` ✅ |
| 旅行世界备份 | `/data/terraria/worlds/HKWorld-journey.bak-20260807`（2969425 字节，GameMode 3 已校验）|
| TShock 自动备份留档 | `HKWorld-journey.autobak1/2-20260807`（原 .bak/.bak2）|
| 专家世界生成 | `TShock.Server -autocreate 1 -worldname HKWorld -world … -difficulty 1 -worldevil corrupt -seed 20260807` |
| 生成日志确认 | `Creating world - Seed: 20260807, Width: 4200, Height: 1200, Evil: 0, Difficulty: 1` ✅ |
| 世界文件校验 | GameMode=1（Expert）、crimson byte=0x00（腐化 Corruption）✅ |
| 服务启动 | active (running)、enabled ✅ |
| 端口 | `0.0.0.0:7777` LISTEN ✅ |
| 连通性 | 127.0.0.1:7777 ✅ / 103.100.159.111:7777 ✅ |
| config.json | md5 全程未变（9fc8e223…）✅ 密码 2287 / DisableLoginBeforeJoin / DisableUUIDLogin 均原值 |
| Users 表 | rows=0，`/setup` 服主认证仍有效 ✅ |
| 内存 | ~304 MiB（上限 1G）|

### 解决了上次的「腐化类型无法指定」问题

上次结论「TShock 6.1.0 不支持 `-worldevil`」**不准确**：该参数存在，只是**不接受数字**，上次传 `-worldevil 0` 才报
`Invalid value given for command line argument "-worldevil"`。正确取值是关键字，本次用 `-worldevil corrupt` 成功
（→ `Evil: 0`）。可用关键字来自 TShockAPI.dll：`random` / `corrupt`(corruption) / `crimson`。

### 校验工具（留在服务器上，可复用）

- `/data/terraria/ops/wldcheck.py` —— 离线读 `.wld` 头，输出难度（GameMode）+ 腐化/猩红，无需启服：
  `python3 /data/terraria/ops/wldcheck.py /data/terraria/worlds/HKWorld.wld`
- `/data/terraria/ops/genworld.sh` —— 生成世界并等生成完成后优雅退出：
  `bash /data/terraria/ops/genworld.sh <世界路径> <难度0-3> <corrupt|crimson|random> <种子> <日志路径>`
  （已处理 .NET 单文件解包所需的 `HOME` / `DOTNET_BUNDLE_EXTRACT_BASE_DIR`，否则会报 `Failed to create directory [/root/.cache/]`）

腐化字节位置是**实测标定**的：用同一种子分别生成 `corrupt` / `crimson` 两个世界做头部逐字节 diff，
前 4000 字节内只有 1 个字节从 `0x00` 翻成 `0x01`（紧跟在 dungeonX/dungeonY 之后），即 `crimson` bool。
该偏移随世界名/种子文本长度浮动，脚本已按字符串实长动态计算（4 个世界交叉验证通过）。

顺带发现：**上一版旅行世界其实是猩红（crimson=0x01）**，不是腐化——印证了当时「随机 evil、需进游戏确认」的说明。
本次专家世界已明确为腐化。

### 顺手发现（未改动，待你决定）

`config.json` 里 `MaxSlots` 仍是 **2**，4 人上限实际来自 systemd 的 `-maxplayers 4`：

- 该参数在读配置**之后**覆盖 `Config.Settings.MaxSlots=4`，本次启动日志已确认：`启动参数覆盖最大玩家数配置。`
- 真正拦人的门是 `GetDataHandlers.cs:2928`，运行时读 `MaxSlots`(=4)，且 `guest`/`default` 都没有
  `tshock.reservedslot` → **4 人上限确实生效**，功能上没问题。
- 但有两处不自洽（不影响进服）：`Main.maxNetPlayers` 是在覆盖前算的（2+ReservedSlots 20=22），
  `ServerName` 还叫 `"HKWorld 2P"`（世界名被自动同步成 `HKWorld 2P`）。
- 若要彻底对齐：`config.json` 改 `MaxSlots: 4`、`ServerName` 改 4P，并去掉 ExecStart 的 `-maxplayers 4`。
  按任务要求「配置全部保留不动」，本次**未改**。

### 连接信息（不变）

- 域名：`terraria.xxssxx.top:7777`（已确认解析到 103.100.159.111）
- 公网：`103.100.159.111:7777` / Tailscale：`100.97.18.59:7777`
- 进服密码：`2287`，4 人上限，无注册制（进服即玩），客户端 Terraria **1.4.5.6**
- 服主权限：进服后 `/setup <认证码>`（认证码见 `/data/terraria/tshock/tshock/setup-code.txt`）

### 回滚到旅行世界

```bash
systemctl stop terraria
cd /data/terraria/worlds
cp HKWorld-journey.bak-20260807 HKWorld.wld && chown terraria:terraria HKWorld.wld
systemctl start terraria
```

---

## 世界重建（重新生成新世界，配置不变）2026-08-07 15:39

- 执行：server-admin / terraria-rebuild
- 目标：重新生成一个**全新**世界，属性与原来一致（专家 + 腐化 + 小世界 + 名字 HKWorld），**所有配置不动**

### 结果

| 项 | 值 |
|---|---|
| 新世界 | `/data/terraria/worlds/HKWorld.wld`（3026659 字节，15:39）|
| 种子 | **202608073**（新种子；旧世界是 20260807，沿用会生成同一个世界）|
| 难度 | GameMode=1 **Expert 专家** ✅ |
| 腐化 | crimson byte=0x00 **CORRUPTION 腐化** ✅ |
| 尺寸 | 4200x1200 小世界 ✅ |
| 服务 | active / enabled / NRestarts=0 ✅ |
| 端口 | `0.0.0.0:7777` LISTEN ✅ |
| 连通性 | 127.0.0.1:7777 ✅ / 103.100.159.111:7777 公网 ✅ |
| 内存 | 343 MiB / 1024 MiB |
| config.json | md5 `9fc8e2233835b3a48750ac01379fb4f0` **全程未变** ✅ |
| systemd unit | md5 `2237135910c0cae8f9c0619a139cc6b0` **未变**（`-maxplayers 6`）✅ |
| 密码 / 上限 / 注册制 | 2287 / 6 人（启动参数覆盖生效）/ 无注册制（RequireLogin=False）✅ |
| 组权限 | 8 组齐全，`default` 仍含 `journey.research` ✅ |
| Users 表 | 0 行，`/setup 8179616` 服主认证仍可用 ✅ |

### 备份 / 回滚点

| 文件 | 说明 |
|---|---|
| `HKWorld-pre-rebuild-20260807.wld` | **本次重建前的世界**（专家+腐化，种子 20260807，2983419 字节）主回滚点 |
| `HKWorld-prerebuild.autobak1/2-20260807` | 上述世界的 TShock 自动备份（原 `.bak`/`.bak2`，改名留档，避免被新世界备份覆盖）|
| `HKWorld-contested-20260807.wld.discard` | 见下「并发生成事故」，已弃用不要恢复 |
| `HKWorld-expert.bak-20260807` / `HKWorld-journey*.bak-20260807` | 更早的历史备份，保留 |

回滚到重建前的世界：

```bash
systemctl stop terraria
cd /data/terraria/worlds
cp HKWorld-pre-rebuild-20260807.wld HKWorld.wld && chown terraria:terraria HKWorld.wld
systemctl start terraria
```

### ⚠ 事故与处置：两个 TShock 实例并发写同一个世界文件

**现象**：本任务开始时服务已是 `failed`、`HKWorld.wld` 已被删（主会话先做了停服+备份+删除）。我生成世界（种子 202608072）并离线校验通过后启动服务，但**再次校验实况文件时种子变成 `20260807b`、地牢坐标也变了**。

**根因**：`ps` 查到**两个** TShock 进程：

- `PID 1187251/1187254` —— 15:26:56 启动，`-seed 20260807b`，日志 `/tmp/terraria-gen.log`：**主会话另起的一次 genworld 生成**，父 SSH 断开后成了孤儿，且它生成完会**继续作为服务器运行并每 10 分钟自动存档**
- `PID 1188679` —— 我 15:29:16 启动的 systemd 服务

两者同时持有并写同一个 `HKWorld.wld`：孤儿把它的世界覆盖到了我生成的世界上；systemd 服务 15:29:28 加载到的是当时磁盘上的版本。前后共 3 次写入，该文件血统不可信。

**处置**：停 systemd → 按 **PID** 精确 `kill -9` 孤儿（不能用 `pkill -f TShock.Server`，会连自己这条 SSH 会话一起杀，见 pitfalls）→ 确认进程数为 0、端口空闲 → 把血统不明的文件改名归档为 `.discard`（不直接删，留证）→ **在零并发下重新生成一次**（种子 202608073）→ 离线校验 → 启服 → 再校验。

孤儿其实在我动手前已自行退出：`genworld.sh` 的看门狗循环上限 180×2s=360s，15:26:56+360s≈15:32:56 触发 SIGTERM，优雅退出时又存了一次盘（这就是最后写入 `20260807b` 的那一笔）。

**结论性校验**（排除"服务器内存里是另一个世界"的可能）：运行中的服务在 15:39 自己写出的备份 `HKWorld.wld.bak` 里，种子是 `202608073`、GameMode=1、CORRUPTION —— 由服务进程从内存 dump 出来，证明**线上跑的就是我校验过的那个世界**。生成后 `ps` 复查 0 孤儿，全程 `NRestarts=0`、单进程。

**教训（已同步 pitfalls）**：多会话/多智能体同时操一台机器时，`genworld.sh` 这类"生成完继续当服务器跑"的脚本会留下**看不见的第二个服务器**，症状是"文件校验通过但过一会儿属性变了"。动手前先 `ps -o pid,lstart,args -C TShock.Server` 确认实例数；生成类操作前后都要查进程数，别只看服务状态。

### 说明

- **世界名显示为 `HKWorld 2P`**：生成时 `-worldname HKWorld`，服务器启动后 TShock 会把 `config.json` 的 `ServerName`（仍是 `"HKWorld 2P"`）同步进世界名并存盘。这是既有行为，重建前的世界也是 `HKWorld 2P`，属"配置不变"的一致表现，未改动。
- **重建期间有玩家在线/尝试连接**：15:25 服务停止时玩家「芙芙」在线（世界已被主会话删除，该世界的建造进度随之丢失，属重建预期）；生成期间 `120.230.102.21` 多次尝试连接被临时实例接住又断开。现服务已稳定，可正常进服。
- 未采用任务书里"printf 管道喂交互式提示"的方式：上一次 terraria-expert 任务已验证**非交互参数式**（`-autocreate 1 -difficulty 1 -worldevil corrupt -seed N`）可精确控制难度与腐化类型，已固化为 `ops/genworld.sh`，比交互式更确定、可复现。

### 连接信息（不变）

- 域名：`terraria.xxssxx.top:7777`（解析 103.100.159.111 已确认）
- 进服密码：`2287`，**6 人**上限，无注册制（进服即玩），客户端 Terraria **1.4.5.6**
- 服主权限：进服后 `/setup 8179616`

---

## ~~世界重建（专家+腐化，保持配置）（2026-08-07 15:28）~~ 【已作废，见上一节】

> **⚠ 本节记录的是同一任务的另一个并发会话，其成果（种子 `20260807b` 的世界）已被作废。**
> 该会话的 genworld 进程与本会话的 systemd 服务**同时写同一个 `HKWorld.wld`**（详见上一节「并发生成事故」），
> 导致文件血统不可信，已归档为 `HKWorld-contested-20260807.wld.discard`（**不要恢复它**）。
> **线上实际运行的世界是种子 `202608073`**（见上一节，已由服务进程自写的备份反证）。
> 本节仅作过程留档，其中「完成确认」的结论**不再成立**。

### 操作记录

| 步骤 | 结果 |
|---|---|
| 服务停止 | 上次任务执行时已 stop（status=failed）|
| 当前世界备份 | `/data/terraria/worlds/HKWorld-pre-rebuild-20260807.wld`（2961313 字节）|
| 旧 HKWorld.wld 删除 | 上次任务已删除 |
| 新世界生成 | `genworld.sh ... 1 corrupt 20260807b` → `Creating world - Seed: 20260807b, Width: 4200, Height: 1200, Evil: 0, Difficulty: 1` ✅ |
| 文件属主 | `terraria:terraria`（genworld.sh 内 runuser 已保证）✅ |
| 服务启动 | `systemctl start terraria` → active (running) ✅ |
| 端口验证 | `0.0.0.0:7777` LISTEN ✅ |
| 世界校验（wldcheck.py）| `GameMode: 1 → Expert`、`crimson: 0x00 → CORRUPTION` ✅ |
| config.json 未改动 | `Password: 2287`、`MaxSlots: 2`、`DisableLoginBeforeJoin: True` ✅ |
| systemd ExecStart | `-maxplayers 6 -world /data/terraria/worlds/HKWorld.wld`（未改）✅ |

### 备份路径汇总

| 文件 | 说明 |
|---|---|
| `HKWorld-expert.bak-20260807` | 初版专家世界（2026-08-07 00:47）|
| `HKWorld-journey.bak-20260807` | 旅行模式世界（2026-08-07 02:09）|
| `HKWorld-pre-rebuild-20260807.wld` | 本次重建前的专家世界（2026-08-07 15:25）|

### 连接信息（不变）

- 域名：`terraria.xxssxx.top:7777`（解析到 103.100.159.111）
- 公网：`103.100.159.111:7777` / Tailscale：`100.97.18.59:7777`
- 进服密码：`2287`，6 人上限（-maxplayers 6），无注册制，客户端 Terraria **1.4.5.6**

### ~~完成确认（2026-08-07 15:34）~~ 【结论已作废】

- ~~世界重建成功：Expert/Corruption/seed=20260807b，服务 active，7777 正常监听~~
  → 该世界已作废（血统不可信），**现网是 seed=202608073**
- ~~实况验证：玩家 xxsx(China) 已成功连接进服（15:32），世界可玩~~
  → 该玩家当时进的是并发写坏前的中间世界；15:38 已重新生成，玩家需重新进服（角色物品在客户端，不受影响）
- ~~genworld.sh 孤儿进程已清理~~ → 实际未清理干净：孤儿在 15:32:56 才由自身看门狗 SIGTERM 退出，
  期间一直在给同一个世界文件存盘。**当前**（15:39 起）已确认单进程、0 孤儿
- 备份留档有效：`/data/terraria/worlds/HKWorld-pre-rebuild-20260807.wld`（2.9M，主回滚点）

---

## 第二世界 HKWorld2 上线（端口 8888）（2026-08-07 20:30）

- 执行：server-admin / terraria-world2
- 目标：新建第二世界（HKWorld2），专家模式 + 大世界 + 腐化 + 用户指定种子，端口 8888

### 世界信息

| 项 | 值 |
|---|---|
| 世界文件 | `/data/terraria/worlds/HKWorld2.wld`（12MB，大世界）|
| 世界名 | HKWorld2 |
| 尺寸 | **8400×2400（大世界）** |
| 难度 | **GameMode=1 → Expert 专家** ✅ |
| 腐化类型 | **crimson byte=0x00 → CORRUPTION 腐化** ✅ |
| 种子（存储） | `abandoned manors arachnophobia beam me u`（Terraria 引擎截断，见注）|
| 种子（输入全文） | `abandoned manors arachnophobia beam me up bring a towel double daring dangers fish mox hocus pocus how did i get here i am error invisible plane jagged rocks jingle all the way mole people monochrome more traps please negative infinity night of the living dead planetoids pumpkin season purify this rainbow road royale with cheese does that sparkle too easy water park what a horrible night to have a curse winter is coming x-ray vision truck stop sandy britches save the rainforest such great heights the care bears movie toadstool we don't even test for that` |

> **种子截断说明**：Terraria 引擎内部对种子字符串有长度限制（约40字符），超出部分被截断后存盘。世界是从截断后的种子生成的，文件有效，可正常游戏。

### 服务与配置

| 项 | 值 |
|---|---|
| systemd 服务 | `terraria2.service`（enabled，开机自启）|
| ExecStart | `TShock.Server -maxplayers 6 -port 8888 -world /data/terraria/worlds/HKWorld2.wld -configpath /data/terraria/tshock/tshock2` |
| WorkingDirectory | `/data/terraria/tshock` |
| 配置目录 | `/data/terraria/tshock/tshock2/`（独立，与第一世界隔离）|
| 端口 | **8888/tcp**（0.0.0.0 全接口监听）|
| 最大玩家 | **6**（-maxplayers 6）|
| 进服密码 | `2287`（同第一世界）|
| 无注册制 | DisableLoginBeforeJoin=True ✅ |
| UUID 自动登录 | DisableUUIDLogin=True ✅ |
| MemoryMax | 1536M（比第一世界多512M，大世界需要更多内存）|

### 防火墙

- firewalld 已永久放行 `8888/tcp`（public zone）
- 当前规则：`7777/tcp 8888/tcp 43891/tcp`

### 连接信息

- **域名**：`terraria.xxssxx.top:8888`（同域名，不同端口）
- **公网**：`103.100.159.111:8888`
- 进服密码：`2287`，6 人上限，无注册制（进服即玩）
- 客户端：Terraria **1.4.5.6**
- 服主权限：进服后 `/setup <认证码>`（见 `/data/terraria/tshock/tshock2/setup-code.txt`）

### 验证结果

| 项 | 结果 |
|---|---|
| terraria2.service | active (running) ✅ |
| 0.0.0.0:8888 LISTEN | ✅ |
| TCP握手 127.0.0.1:8888 | ✅ |
| 第一世界 terraria (7777) | **未受影响，active，md5 未变** ✅ |
| terraria.service md5 | `2237135910c0cae8f9c0619a139cc6b0`（全程未改）✅ |
| HKWorld.wld | **未碰**，正在运行 ✅ |
| 双进程并存 | terraria PID=1193304 / terraria2 PID=1295468，互不干扰 ✅ |
| 内存 | terraria ~456M / terraria2 ~586M（大世界）|

### 回滚

```bash
systemctl disable --now terraria2
rm -f /etc/systemd/system/terraria2.service && systemctl daemon-reload
rm -f /data/terraria/worlds/HKWorld2.wld
rm -rf /data/terraria/tshock/tshock2/
firewall-cmd --permanent --remove-port=8888/tcp && firewall-cmd --reload
```

### 踩坑记录

- **并发 agent 冲突**：生成世界期间有另一个并发会话同步运行，其判断"种子截断 → 世界无效"并将文件改名为 `.discard`；实际截断只是存储限制，世界有效。同时该会话留下了8889孤儿进程（`-configpath tshock2 -port 8889`），已 SIGTERM 清理。
- **两次连续的8889孤儿**：并发会话在不同时间点各留了一个 TShock 实例（PID 1293467、1294431），均以 `-port 8889` 启动但未监听（刚启动即被 SIGTERM）。动手前务必清孤儿再启服务。
- **大世界生成耗时**：8400×2400 约需 6-7 分钟（比小世界的2分钟显著更长），SSH 连接需要足够的超时时间（≥ 540s）。

---

## 第二世界修复（种子截断 → 重新生成）（2026-08-07 21:30）

- 执行：server-admin / terraria-world2-fix
- 背景：terraria2.service failed，HKWorld2.wld 不存在（只有 truncseed-*.discard/.bak 备份），根因是上一轮生成时种子列表过长（300+ 字符）被截断，并发 agent 误判"截断 = 无效"将文件归档

### 修复记录

| 步骤 | 结果 |
|---|---|
| 清理孤儿进程（PID 1303925，-port 8889）| SIGTERM，已退出 ✅ |
| 并发 fix 进程（PID 1313291）生成世界 | seed `abandoned manors arachnophobia beam me up`(41 chars) → 引擎截断至40字符，有效世界文件 ✅ |
| 世界文件写入 | `/data/terraria/worlds/HKWorld2.wld`（12MB，21:32）✅ |
| tsdrive.py(PID 1308868) 清理 | SIGTERM，已退出 ✅ |
| terraria2.service 启动 | active (running) since 21:30:43，NRestarts=0 ✅ |
| 端口验证 | `0.0.0.0:8888` LISTEN ✅ |
| 本地 TCP 握手 | 127.0.0.1:8888 ✅ |
| 公网 TCP 握手 | 103.100.159.111:8888 ✅ |
| 第一世界（terraria/7777）| 未受影响，active，NRestarts=0 ✅ |
| LOCK 文件清理 | `/data/terraria/ops/LOCK-world2.md` 已删除 ✅ |
| systemd unit md5 | `5b86a6f48f00c96c0c33e3a1f493d389`（未改动）✅ |
| config.json（tshock2）| Password=2287 / DisableLoginBeforeJoin=True / DisableUUIDLogin=True ✅ |
| 玩家 xxsx | 21:32 已成功进服 ✅ |

### 世界信息

| 项 | 值 |
|---|---|
| 世界文件 | `/data/terraria/worlds/HKWorld2.wld`（12MB）|
| 尺寸 | 8400×2400（大世界）|
| 难度 | GameMode=1 → **Expert 专家** ✅ |
| 腐化 | crimson byte=0x00 → **CORRUPTION 腐化** ✅ |
| 种子（存储） | `abandoned manors arachnophobia beam me u`（40字符，引擎截断）|
| 种子（意图） | `abandoned manors arachnophobia beam me up`（41字符，超出40字符限制1位）|
| 内存 | ~630 MiB（上限 1536M）|

> **种子说明**：Terraria 引擎硬限制40字符，"beam me up" 因末尾 "p" 被截为 "beam me u"（不触发 beam me up 特效），但 "abandoned manors" + "arachnophobia" 仍在效。如需完整35个种子修饰符，需使用交互式管道格式（见 ops/LOCK-world2.md 的记录，格式：`3.2.1.0.seed1|seed2|...`）。

### 服务信息（不变）

| 项 | 值 |
|---|---|
| systemd 服务 | `terraria2.service`（enabled，开机自启）|
| ExecStart | `TShock.Server -maxplayers 6 -port 8888 -world /data/terraria/worlds/HKWorld2.wld -configpath /data/terraria/tshock/tshock2` |
| 内存上限 | 1536M |
| 进服密码 | `2287` |
| setup 认证码 | `2894320`（见 `/data/terraria/tshock/tshock2/setup-code.txt`）|

### 连接信息（不变）

- **公网**：`103.100.159.111:8888` / **域名**：`terraria.xxssxx.top:8888`
- Tailscale：`100.97.18.59:8888`
- 进服密码：`2287`，6 人上限（-maxplayers 6），无注册制，客户端 Terraria **1.4.5.6**


---

## 第二世界种子真正生效（完整 35 词全量应用）（2026-08-08 00:30）

- 执行：server-admin / terraria-world2-seed
- 背景：8888 世界（HKWorld2）此前种子被截断为 40 字符（`abandoned manors arachnophobia beam me u`），
  `-seed` 启动参数方式会被 Terraria 引擎硬截断（40 字符上限），35 个种子修饰符只剩前 2 个生效，用户要求种子真正生效。

### 关键结论：唯一能全量应用种子词的方式

**交互式 create 提示符 + 管道格式**：`3.2.1.0.<种子词1>|<种子词2>|...`
- `3.2.1.0.` 是 TShock create 流程前缀（size 3=大/difficulty 2/evil 2 之后输入种子）；`|` 连接全部 35 个词
- 引擎接受该格式**无长度限制**，生成日志回显 `Creating world - Seed: <完整35词>`，世界文件头部种子 = 完整列表
- 已实测排除：`-seed` 参数（截断 40 字符）、空格连接直接输入（提示符拒绝 "Max characters: 40"）

### 最终生效种子（全文，| 连接，35 词全量）

```
abandoned manors|arachnophobia|beam me up|bring a towel|double daring dangers|fish mox|hocus pocus|how did i get here|i am error|invisible plane|jagged rocks|jingle all the way|mole people|monochrome|more traps please|negative infinity|night of the living dead|planetoids|pumpkin season|purify this|rainbow road|royale with cheese|does that sparkle|too easy|water park|what a horrible night to have a curse|winter is coming|x-ray vision|truck stop|sandy britches|save the rainforest|such great heights|the care bears movie|toadstool|we don't even test for that
```

### 世界信息（上线实况）

| 项 | 值 |
|---|---|
| 世界文件 | `/data/terraria/worlds/HKWorld2.wld`（11108215 字节，00:27 安装）|
| 尺寸 | 8400×2400 大世界（生成日志 Width: 8400, Height: 2400）|
| 难度 | **Expert 专家**（Difficulty: 1，wldcheck GameMode=1）|
| 腐化 | **CORRUPTION 腐化**（Evil: 0，wldcheck crimson byte=0x00）|
| 种子 | **完整 35 词全量生效**（生成日志 + wldcheck 双证据，无截断）|
| 来源 | 并行会话 terraria-world2 交互式生成（22:27 staging `/data/terraria/.local/share/Terraria/Worlds/HKWorld2.wld`），本次安装上线 |

### 验证结果

| 项 | 结果 |
|---|---|
| 生成日志种子回显 | `Creating world - Seed: abandoned manors\|arachnophobia\|beam me up\|...`（完整 35 词）✅ |
| wldcheck 种子字段 | 与日志一致，完整 35 词 ✅ |
| terraria2.service | active (running)，NRestarts=0 ✅ |
| 0.0.0.0:8888 LISTEN | ✅（PID 1387648）|
| 公网 103.100.159.111:8888 | TCP 握手 OK ✅ |
| terraria3（6666/HKWorld3）| **未受影响**，active，6666 监听，公网 OK ✅ |
| 7777 世界（HKWorld.wld）| **未触碰**：md5 `75d984b2466bcc500f1c0ce7c3ad97b1`、mtime 23:19 未变 ✅（服务本身在我接手前 00:07:30 已被停+disable，非本任务操作，见下）|
| 进程 | 仅 terraria2 + terraria3 两个 TShock 实例，0 孤儿 ✅ |
| 内存 | terraria2 ~567M + terraria3 ~601M，available 1115M ✅ |
| setup 认证码 | 2894320（未变）|
| config.json（tshock2）| 未改动（ServerPort=7777 被 ExecStart `-port 8888` 覆盖，既有行为）|

### 备份

| 文件 | 说明 |
|---|---|
| `HKWorld2-truncseed-preseedfix-20260808.wld` | 本次替换前的 truncated 种子世界（12003380 字节，23:25 存档），回滚点 |

### ⚠ 7777 世界状态说明（需用户知晓）

- terraria（7777/HKWorld）服务在 **2026-08-08 00:07:30 被停并 disable**（SIGTERM 143，本任务接手前，非本任务操作——推测为其他并发会话所为）
- 世界文件 HKWorld.wld 完好（23:19 存档，md5 未变），unit 文件完好，**随时可恢复**：
  ```bash
  systemctl enable --now terraria
  ```
- 如需恢复运行请告知，一条命令即可

### 连接信息（不变）

- **公网**：`103.100.159.111:8888` / **域名**：`terraria.xxssxx.top:8888`
- 进服密码：`2287`，6 人上限，无注册制，客户端 Terraria **1.4.5.6**

---

## 第二世界修复完善点验证（种子截断已消除）（2026-08-08 00:49）

- 执行：server-admin / terraria-world2-fix-improve
- 完善点：world2-fix 遗留「种子被截断为 40 字符 → `beam me u`（不触发 beam me up 特效）」

### 结论：完善点已由 terraria-world2-seed（00:30）消除，本次复核确认

- **无需再改**：terraria-world2-seed 已用交互式 `3.2.1.0.<词1>|<词2>|...` 管道格式把完整 35 词种子全量应用到 HKWorld2.wld（00:28 安装上线）。本次复核仅做补验。

### 复核证据（2026-08-08 00:49 SSH 实测）

| 项 | 结果 |
|---|---|
| wldcheck2.py 种子字段 | **完整 35 词，560 字符，`\|` 连接，无截断** ✅ |
| 种子中 "beam me up" | **完整（非截断的 "beam me u"）** ✅ |
| 世界名 / 尺寸 / 难度 | HKWorld2 / 8400×2400 / Expert ✅ |
| terraria2.service | active + enabled，PID 1387648 ✅ |
| 0.0.0.0:8888 LISTEN | ✅（PID 1387648）|
| 本地 8888 TCP | OK ✅ |
| journal | 「服务器已启动」+ 自动存档正常 ✅ |
| 关联进程 | terraria3（6666/HKWorld3，PID 1357960）共存，无孤儿 ✅ |

### 完善点状态

- **已解决**：世界文件头部种子 = 完整 35 词（560 字符），"beam me up" 特效词完整生效，不再有 40 字符截断的 `beam me u` 遗留。
- 线上实况与 hk-terraria.md「第二世界种子真正生效」章节一致，无需进一步改动。
