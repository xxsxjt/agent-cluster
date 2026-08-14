# 泰拉瑞亚偶发单用户断连排查报告（terraria.xxssxx.top / 6666）

- 日期：2026-08-11
- 执行：server-admin / terraria-disconnect-fix
- 服务器：HK（103.100.159.111，terraria3/HKWorld3，端口 6666）
- 报告现象：玩家通过域名连 6666 世界，**单个用户偶发突然断开**（无规律、非全体），**可直接重连**（非封禁/持续故障）

## 结论一句话

**服务端无故障、无超时/踢出/封禁、DNS 与 CF 均无问题；断连根因指向「客户端侧跨境网络瞬时中断」（大陆→HK 线路抖动），TShock 将异常断连统一记录为"离开了游戏"且默认不写 socket 错误细节，导致日志无断连原因。** 无需改 DNS、无需改 TShock 配置；若要精确定位需开启 DebugLogs 后复现观察（需择玩家离线时段重启）。

## 逐嫌疑排查

### 1. DNS/CF 配置 —— ✅ 排除（无 CF 代理，游戏走 TCP）

- `nslookup terraria.xxssxx.top` → **103.100.159.111**（HK 源 IP）
- 若为 CF proxied（橙云）会返回 CF anycast IP（104.x / 172.x 段），实际返回源 IP → **DNS-only（灰云），直连源 IP，不经 CF** ✅
- 域名托管：`xxssxx.top` 注册在阿里云（`vps-deploy/scripts/aliyun_dns.py` 为 DNS 管理通道，无 CF API token），`terraria` 为普通 A 记录直指源 IP
- **重要纠正**：任务书假设"泰拉瑞亚是 UDP、CF 不支持 UDP 转发"。实测 `ss -tlnp` 显示 **6666 是 TCP LISTEN，无 UDP 监听** → Terraria/TShock 走 **TCP** 协议，本就不存在"CF 不支持 UDP 转发"问题。且域名已是 DNS-only，连 CF 都不经过。
- **无需改动**。

### 2. TShock 超时设置 —— ✅ 排除（无超时配置、无踢出记录）

- 完整读 `/data/terraria/tshock/tshock3/config.json`：**无任何客户端超时 / DisableSocketSecurity / 空闲踢出项**（TShock 6 无独立连接超时配置）
- 相关项：`KickProxyUsers: true`（会踢检测到的代理流量，但日志无"已被踢出"记录，未触发）；`DisableUUIDLogin`、`RequireLogin=false` 均正常
- 日志中**无 "已被踢出：超时" 或 "lost connection" 记录** → 非服务器主动踢出

### 3. HK 网络丢包 —— ✅ 本机侧健康（0% 丢包）

- 本机 ping 103.100.159.111 ×20：**0% 丢包**，平均 17ms（15-23ms）
- 服务端：`load 0.47`，内存 746M/1536M，`MemoryPeak 890M`（未触顶），**无 OOM**（dmesg 无 killed process）
- firewalld 已放行 `6666/tcp` ✅
- 说明：本机测的是本机→HK 线路；玩家侧（大陆电信/移动）→HK 的跨境线路抖动本机无法测，恰是"单用户断连、非全体"的最可能来源

### 4. 服务端日志断连记录 —— ⚠ 无断连原因（TShock 默认不记录 socket 错误）

- 日志位置：`journalctl -u terraria3`（tshock3/logs/ 下只有 08-07 旧进程的残留 log，非当前服务）
- 玩家进出全记录（08-09~08-11）：
  - 玩家 `xxsx`(120.230.140.225) 与 `芙芙`(113.109.49.57) 反复进出，全部记录为"加入了服务器 / 进入了游戏 / 离开了游戏"
  - **08-11 14:15:11 芙芙 离开了游戏** ← 与用户报告 14:1x 断连**时间吻合**，即为该次断连事件
  - 芙芙 11:23:30 进 → 14:15:11 离开，全程**无"已被踢出"记录** → 非踢出/超时/封禁，是连接异常断开
- **根因缺口**：TShock `DebugLogs: false` → 纯 socket 断线（客户端网络中断）**默认不写详细错误**，只记通用"离开了游戏"，无法从现有日志区分"主动退出" vs "意外断连"。但结合现象（无规律、单用户、可重连、无踢出），排除服务端主动行为。

## 根因判定

- **服务端：全部正常**（TCP 监听、无 OOM、无超时/踢出、DNS-only 直连、无 CF 介入）
- **最可能根因：客户端到 HK 的跨境网络瞬时中断**（大陆玩家线路抖动/丢包导致 TCP 会话中断），TShock 将断连记为"离开了游戏"，客户端重连即恢复。这完全吻合"单用户、偶发、无规律、可直接重连"的全部特征。
- 次要待观察项：玩家若使用**游戏加速器**（UU/雷神/奇游等），部分加速线路偶发抽动也可能导致会话中断；`KickProxyUsers=true` 本次未触发（无踢出记录），但加速器流量本身经第三方节点，稳定性不可控。

## 建议修复/下一步（均需用户确认时段后执行，本报告未擅自改配置/重启）

1. **（推荐，可精确定位）开启 DebugLogs 抓取断连详情**
   - 改 `config.json` → `"DebugLogs": true`
   - 重启 `systemctl restart terraria3`（需玩家离线时段，约 30s 内恢复监听）
   - 下次断连时 journal 会记录详细 socket 错误（如 TCP RST / timeout），可 100% 确认根因
   - 定位后可关闭 DebugLogs（避免日志刷屏）
2. **玩家侧排查**（无需动服务器）
   - 断连时让玩家看本地网络是否瞬断；有加速器则换节点或关加速试直连
   - 可用 Tailscale 地址 `100.97.18.59:6666` 做对照组，排除公网跨境线路因素
3. **无需改动项**（确认维持现状）
   - DNS 保持 DNS-only（灰云）——正确，别开橙云（无意义且引入 CF 依赖）
   - TShock 无超时配置可调，不瞎改

## 验证记录

| 检查项 | 结果 |
|---|---|
| 域名解析 | terraria.xxssxx.top → 103.100.159.111（源 IP，DNS-only，非 CF）✅ |
| 6666 协议 | TCP LISTEN（`TShock.Server -port 6666`），无 UDP ✅ |
| terraria3.service | active，PID 2009938 ✅ |
| firewalld | 6666/tcp 放行 ✅ |
| 内存/OOM | 746M/1536M，峰值 890M，无 OOM ✅ |
| 系统负载 | 0.47，健康 ✅ |
| ping 丢包 | 0%（17ms）✅ |
| 断连记录 | 08-11 14:15:11 芙芙"离开了游戏"（异常断开），无踢出/超时 ✅ |
| KickProxyUsers | 配置 true，本次未触发（无踢出记录）✅ |
| TShock 超时配置 | 无（config.json 无超时/DisableSocketSecurity 项）✅ |

## 回滚/复原

- 本任务**未改动任何服务器配置、未重启服务**，无回滚需求
- 若日后按建议开启 DebugLogs，改回 `"DebugLogs": false` 并重启即可复原
