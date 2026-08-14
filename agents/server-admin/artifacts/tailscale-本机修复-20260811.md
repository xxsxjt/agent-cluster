# Tailscale 本机修复 — 连接验证证据

任务: nextday-2026-08-11-Tailscale-本机修复-152618
执行: server-admin (2026-08-12 ~15:57)
来源: daily-meeting-2026-08-11

## 结论

本机 Tailscale 已恢复对 HK 的**直连**通道（非 DERP 中继、非 sshd 反向隧道兜底）。
`tailscale up/authkey` 认证保持有效（BackendState=Running, HaveNodeKey=true, 无 AuthURL）。
本机→HK 直连已可用，反向隧道兜底不再必要。

## 节点信息

| 项 | 值 |
|---|---|
| 本机 Tailscale IP | 100.103.204.86（node/虚无圣玑, Windows, v1.98.10） |
| HK Tailscale IP | 100.97.18.59（xxsx-main-hk, Linux） |
| HK sshd 端口 | 43891（非 22） |
| 认证状态 | Running / HaveNodeKey=true / AuthURL=""（已认证） |

## 连接验证证据（2026-08-12 ~15:57）

### 1. tailscale status（本机侧）
```
100.97.18.59  xxsx-main-hk  xxsxjt@  linux  active; direct 103.100.159.111:41641, tx 1324860 rx 408692
```
- 状态 active，且为 **direct**（UDP 直连），非 relay/DERP。

### 2. ICMP ping HK（本机）
```
100.97.18.59 的回复: 时=16ms / 23ms / 18ms
数据包: 已发送=3，已接收=3，丢失=0 (0% 丢失)
平均=19ms
```

### 3. SSH 直连 HK（tailscale 内网 IP，端口 43891，不经过 US 跳板）
```
$ ssh -p 43891 root@100.97.18.59 "echo HK_DIRECT_TAILSCALE_OK; hostname"
HK_DIRECT_TAILSCALE_OK
twjnrahg6gsg
```
- 说明：端口 43891 为 HK 上 sshd 监听端口。

### 4. HK 侧视角（tailscale status 反向确认本机）
```
100.103.204.86  node  xxsxjt@  windows  active; direct 120.230.140.225:16689, tx 449472 rx 1328220
```
- HK 侧同样看到本机为 **direct** 直连，双向 UDP 直连成立。

### 5. 直连 host 别名验证（走 ~/.ssh/config 新增 `hk` 别名）
```
$ ssh hk "echo CONFIG_HK_DIRECT_OK; hostname"
CONFIG_HK_DIRECT_OK
twjnrahg6gsg
```

## 变更

1. `~/.ssh/config` 新增直连别名：
   ```
   Host hk hk-direct
       HostName 100.97.18.59
       User root
       Port 43891
       IdentityFile C:/Users/du_ji/.ssh/id_ed25519_xxsx_hk
       IdentitiesOnly yes
       StrictHostKeyChecking no
       ServerAliveInterval 30
       ServerAliveCountMax 3
   ```
   - 直接走 Tailscale 内网 IP，不再依赖 `hk-via-us`（US 跳板 ProxyJump 兜底）。
   - `hk-via-us` 保留作尾随兜底，未删除。

## 备注

- 本机 Tailscale 认证本来有效（未掉线），任务描述的"掉线需 re-auth"场景本次未触发；但本次已完成直连恢复验证并固化直连 host 配置。
- 反向隧道（sshd -R / 反向代理）兜底仍保留在侧，但日常直连通道已恢复，无需使用兜底。
