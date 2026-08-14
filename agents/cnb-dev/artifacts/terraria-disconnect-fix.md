# 泰拉瑞亚偶发单用户断连排查报告（terraria.xxssxx.top → 6666）

- 日期：2026-08-11 14:40
- 执行：cnb-dev（terraria-disconnect-fix）
- 目标：玩家经域名 terraria.xxssxx.top 连 6666 世界（HKWorld3 / terraria3.service）偶发单用户断连、可直接重连
- 服务端：HK Rocky Linux 9.7（TShock 6.1.0，Terraria 1.4.5.6，PID 2009938，active 20h）

## 一、四路排查结论（按任务嫌疑排序）

### 1. DNS / Cloudflare 配置 —— ✅ 无问题（排除 CF proxied）
- `nslookup terraria.xxssxx.top` → **103.100.159.111**（HK 源 IP，非 CF IP）
- 域名 NS 是 Cloudflare（zeus/grannbo.ns.cloudflare.com），但该记录**直解析到源 IP** = **DNS-only（灰云）**，非 proxied（橙云）
- 重要修正：任务假设"泰拉瑞亚是 UDP 协议、CF proxied 不支持 UDP"。**实测 TShock 仅监听 TCP 6666**（`ss -tulnp` 仅 TCP LISTEN，firewall 只放行 6666/tcp）。Terraria 1.4.5.6 联机实为 **TCP**。因此 CF proxied 的 UDP 隐患**不适用**，且当前本就是 DNS-only，**无需改动 DNS**。

### 2. TShock 超时设置 —— ✅ 无问题（排除服务端超时踢出）
- `tshock3/config.json` 全量检索 **无 socket / timeout / ReceiveTimeout / DisableSocketSecurity / ConnectionDrop 等任何超时相关项**（TShock 6.1 已无 DisableSocketSecurity 概念）
- 系统 TCP keepalive 为内核默认（keepalive_time=7200s），无异常收紧
- journal 日志**无任何"超时/踢出/失去响应"记录**（仅因同 IP 双开被踢"你已经从相同的IP地址进入了游戏"——那是玩家多开，非本问题）
- 结论：**非服务端超时踢人**；日志中玩家离开均为正常离开或网络断连（TShock 对两者显示相同"XX离开了游戏"），无法从现有 DebugLogs=false 日志区分

### 3. HK 网络丢包 —— ⚠️ 轻微抖动，但非丢包
- `ping -n 60 103.100.159.111`：**0 丢包**，平均 25ms（正常 16-18ms）
- 存在一次 **109ms 尖峰**（跨境线路瞬时抖动），但整体稳定，未达到断连级别

### 4. 服务端日志 —— 确认无服务端异常
- 服务 active 20h 无重启、无崩溃，Memory 711M（max 1.5G），无 OOM
- 6666 端口大量**海外 IP 扫描连接**（185.180.141.x、195.170.172.x、85.217.x 等，均"版本不符被踢"）——公网暴露端口正在被扫描，但未造成半开连接风暴（SYN-RECV 仅 1）
- 无 iptables drop/REJECT 针对 6666；当前无玩家在线时无 ESTAB 残留

## 二、根因判断

**最可能根因：客户端本地网络波动 / 跨境线路瞬时抖动导致的 TCP 断连。**
依据：
- 单用户（非全体）断连 → 排除服务器/公网出口故障
- 无规律、可立即重连、重连成功 → 排除封禁/持续故障/版本不匹配
- 服务器端无任何超时踢人、无崩溃、无丢包 → 责任不在服务端
- 跨境线路存在 109ms 尖峰 → 玩家与 HK 之间的链路存在瞬时抖动窗口，恰逢玩家本地 Wi-Fi/路由闪断或跨境路由抖动时，TCP 连接被 RST/超时断开，玩家重连即恢复

**次要因素（非根因但值得关注）：** 6666 端口对公网全开放且正被海外扫描，虽未引发故障，但建议加白名单限制（见下）。

## 三、结论与建议（按优先级）

| 优先级 | 建议 | 是否改动 | 说明 |
|---|---|---|---|
| P0 | **无需改动 DNS**（当前即 DNS-only 灰云，正确） | 不改 | 已确认非 proxied，非 UDP，无 CF 隐患 |
| P0 | **服务端配置无需调整**（无超时项可调、无踢人 bug） | 不改 | 排除服务端因素 |
| P1 | **向玩家排查本地网络**：断连时观察自家 Wi-Fi/宽带是否闪断、路由器日志、光猫信号 | 不改（玩家侧） | 最吻合"单用户+可重连"特征 |
| P1 | **如要精确定位下次断连**：改 `config.json` 的 `DebugLogs: true`（当前 false）+ 观察 journal，断连时会记录更详细连接层信息 | 需重启 terraria3 | ⚠️ 玩家可能在线，重启会踢人——**须选无人在线时段**，或先与玩家约定 |
| P2 | **给 6666 加访问白名单**（firewalld rich rule 仅允许玩家 IP 段），屏蔽海外扫描 | 需改防火墙 | 降低扫描噪音，非断连根因 |

## 四、验证方式 / 未做改动说明

- **未做任何服务端改动**（DNS 无需改、TShock 无超时项可改、未擅自重启踢在线玩家）
- 验证通过：DNS 解析 ✅ / 端口 TCP-only ✅ / 服务 active ✅ / 日志无超时踢人 ✅ / ping 0 丢包 ✅ / config 无超时项 ✅
- 如需进一步取证，唯一可选动作是开 DebugLogs（但会踢在线玩家，需先说明时段）

## 五、回滚

本报告未做改动，无回滚项。若日后开启 DebugLogs：改回 `"DebugLogs": false` 并重启即可。
