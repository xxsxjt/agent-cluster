# 容灾穿透：本机 cloudflared + 双端容灾设计

> 任务：disaster-recovery（B 部分）· 复派 disaster-recovery-improve 完善/补验
> 日期：2026-08-08 · Agent：night-worker

## 0. 源任务失败原因（improve 起因）

源任务 `disaster-recovery.DONE = .FAILED: agent_settled 后进程未退出（空转超时，已强制结束）`。

**实际核查结论**：源 agent 的核心工作**已完成**——已安装 cloudflared、创建并启动基于 token 的远程托管 tunnel（tunnel ID `dabb3758-6d69-4925-8c61-79421530e2cb`）、映射 `remote.xxssxx.top` → 本机 8787。失败根因是**进程收尾环节异常**：agent_settled（认为任务做完）后子进程未正常退出、进入空转，被超时强杀，导致**没来得及写 `.DONE` 标记**。即"事做了、证没留、标记没写"。

本次 improve 的实质工作 = **补足验证证据 + 完成故障演练 + 补齐 artifact 与标记**（隧道本体已就绪）。

---

## 1. 拓扑图（双集群容灾）

```
                       ┌───────────────────────────────────────┐
                       │           Cloudflare Edge             │
                       │   remote.xxssxx.top (Anycast DNS)      │
                       └───────┬───────────────┬────────────────┘
                出站连接(隧道A)│               │出站连接(隧道B)
          ┌────────────────────┘               └─────────────────────┐
          ▼                                                           ▼
 ┌───────────────────┐                                    ┌─────────────────────┐
 │  本机 Windows      │                                    │   HK 服务器          │
 │  cloudflared PID   │                                    │  cloudflared PID 720 │
 │  37960 (token run) │                                    │  /etc/cloudflared    │
 │  dabb3758 tunnel   │                                    │  config.yml run      │
 │  → 127.0.0.1:8787  │                                    │  → 127.0.0.1:20000   │
 │  org-web 控制台    │                                    │  org-web 控制台       │
 └───────────────────┘                                    └─────────────────────┘
        │   ▲                                                   │   ▲
        │   └── Tailscale mesh (100.x.x.x) 互检/数据同步 ────────┘   │
        └────────────────── 独立出站，互不依赖 ───────────────────────┘
```

**关键设计**：两台机器各自跑**独立的 cloudflared 出站隧道**（本机 = token 远程托管；HK = config.yml 本地托管）。两者都是**从各自主机直接向 CF Edge 建出站连接**，彼此之间无依赖。因此任一端崩溃，另一端的外网穿透不受影响。

---

## 2. 本机 cloudflared 配置（token 已脱敏）

- **二进制**：`C:\Users\du_ji\org\agents\night-worker\tools\cloudflared-windows-amd64.exe`（tasklist 显示进程名 `cloudflared-windows-amd64`）
- **运行方式**：`tunnel --edge-ip-version 4 run --token <JWT> --protocol http2`（远程托管 token，JWT 内含 accountID=`6f07d955...`、tunnelID=`dabb3758-6d69-4925-8c61-79421530e2cb`）
- **PID 文件**：`C:\Users\du_ji\pi_workspace\org\cloudflared-local.pid` = `37960`
- **对外域名**：`https://remote.xxssxx.top/`（DNS 解析到 CF Anycast `104.21.69.181` / `172.67.211.5`）
- **转发目标**：本机 org-web 控制台 `127.0.0.1:8787`（`--host 0.0.0.0 --token`）
- **凭据安全**：token 以 JWT 形式存在于进程命令行，未明文落盘到 artifact/报告；`.cloudflared/cert.pem` 为本机 CF 证书（`7d55c1fd...` 账户），仅含 zone/account/API 信息，不写 token 明文。

> 注：`.cloudflared/89974964-*.json` + `cert.pem` 为 7-14 旧隧道遗留（另一 tunnel）；本次生效的是 `dabb3758` token 隧道。

---

## 3. 双端容灾设计

- **健康互检**：本机 ↔ HK 通过 **Tailscale mesh**（`100.97.18.59`，ping 18ms）+ **CF 域名**（`remote.xxssxx.top`）双通道互相可达；HK 侧另有 nginx 80/443 + org-web 8787。
- **故障转移语义**：
  - **HK 挂** → 用户仍可通过 `remote.xxssxx.top` 访问**本机**控制台（隧道A 直连 CF，与 HK 无关）。
  - **本机挂** → HK 照常（隧道B + nginx），数据一致性由 A 任务 dual-cluster-sync 同步保证。
- **隧道暴露面**：仅暴露 8787（控制台）单端口，不裸奔其他端口（本机仅 `127.0.0.1:8787` 后端，云端只有一条 hostname route）。

---

## 4. 故障演练记录（实测）

| 步骤 | 操作 | 结果 |
|------|------|------|
| 1 | HK `systemctl stop org-web`（模拟故障） | `STOPPED_OK`，服务 `inactive` |
| 2 | HK 故障期间访问 `https://remote.xxssxx.top/` | **HTTP 200**（本机控制台正常，不依赖 HK）✅ |
| 3 | HK `systemctl start org-web`（恢复） | `active`，8787 重新监听 |
| 4 | 双通道复检：CF 域名→本机 + 本机直连 8787 | 均 **HTTP 200** ✅ |

结论：**HK 故障期间外网仍可穿透本机控制台，恢复后双通道全通** —— 容灾目标达成。

---

## 5. GitHub 参考调研（含 LICENSE 结论）

| 项目 | 作用 | LICENSE | 结论 |
|------|------|---------|------|
| [tailscale/tailscale](https://github.com/tailscale/tailscale) | 自建 mesh VPN/子网路由，双端私有互连 | **BSD-3-Clause** | ✅ 可复用 |
| [cloudflare/cloudflared](https://github.com/cloudflare/cloudflared) | CF 隧道客户端本体（本机即用它） | **Apache-2.0** | ✅ 可复用 |
| [fatedier/frp](https://github.com/fatedier/frp) | 反向代理穿透 NAT（CF 隧道替代/补充方案） | **Apache-2.0** | ✅ 可复用（思路备用） |
| [syncthing/syncthing](https://github.com/syncthing/syncthing) | 双机文件级双向同步（数据一致性参考） | **MPL-2.0** | ✅ 可复用 |
| [etcd-io/etcd](https://github.com/etcd-io/etcd) | Raft 共识/主备选举（故障转移思路参考） | **Apache-2.0** | ✅ 学思路（重活，不引入） |
| [juanfont/headscale](https://github.com/juanfont/headscale) | 自托管 Tailscale 控制面（去中心化参考） | **BSD-3-Clause** | ✅ 可复用 |
| [hashicorp/consul](https://github.com/hashicorp/consul) | 服务发现/健康检查 | **BUSL（商业限制）** | ⚠️ 只学思路不复制 |
| [zerotier/ZeroTierOne](https://github.com/zerotier/ZeroTierOne) | 私有网络（Tailscale 替代） | **BUSL（非商业）** | ⚠️ 只学思路不复制 |
| [rustdesk/rustdesk](https://github.com/rustdesk/rustdesk) | 远控（本机远控备选） | **AGPL-3.0** | ⚠️ 只学思路不复制 |

**复用原则落地**：本方案实际复用的开源组件为 Tailscale（BSD-3）+ cloudflared（Apache-2.0），均为宽松协议；参考 Consul/etcd 的"健康检查+主备"设计思路，但故障转移不引入额外共识重活，采用**双独立隧道 + Tailscale 互检**的轻量方案。

---

## 6. 结论

- 源任务"失败"根因 = 进程收尾空转超时强杀、未写标记，**核心实现已完成**。
- 本次补验：隧道端到端 HTTP 200、HK 故障演练通过、双通道恢复全通。
- 交付物齐备：本机 cloudflared 隧道运行中、容灾设计落地、参考调研含 LICENSE、演练记录。
