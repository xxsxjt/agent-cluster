# 泰拉瑞亚 6666 世界「移动 NPC 没有权限」修复报告

- 日期：2026-08-10
- 执行：server-admin
- 目标世界：6666（HKWorld3，terraria3.service，TShock 6.1.0）

## 结论（已修复并验证生效）

**所需权限：`tshock.world.movenpc`**（TShock 6.1.0 内置权限，控制玩家通过住房菜单移动 NPC 的能力）。
该权限已加入 **guest 组**，且运行中的服务已加载，用户下次「移动 NPC」不再被拦截。

> 说明：本次改动在本任务接手前已由并发会话在 18:01 完成并重启服务生效。
> 本任务做了完整核查与验证，确认改动正确、有效、可回滚，未做重复改动。

---

## 1. 拦截方确认（TShock 拦截，非 Mod）

- 服务器未装任何第三方 Mod/插件（`ServerPlugins/` 仅有官方 `TShockAPI.dll`），排除 Mod 拦截。
- 权限拒绝由 **TShock 权限体系**拦截：`tshock.world.movenpc` 属于 `tshock.world.*` 命名空间，
  字符串存在于 `TShockAPI.dll` 二进制（`strings` 检出 `movenpc`），为官方真实权限。
- 服务器日志无其它权限异常，玩家正常进服游玩（日志显示 xxsx/芙芙 在线），属纯粹的权限不足。

## 2. 原值记录（可回滚）

| 组 | 修改前（backup） | 修改后（live） |
|---|---|---|
| guest | ...tshock.world.modify, tshock.world.paint, tshock.world.worldupgrades | 原值 + **tshock.world.movenpc** |

- 改动前数据库备份：`/data/terraria/tshock/tshock3/tshock.sqlite.bak-20260810-movenpc`
  （root 所有，18:01:22.25 创建）
- 修改后唯一差异（`comm` 全量对比确认）：**仅新增 `tshock.world.movenpc` 一项**，其余权限零改动。
- **回滚**：
  ```bash
  systemctl stop terraria3
  cp /data/terraria/tshock/tshock3/tshock.sqlite.bak-20260810-movenpc \
     /data/terraria/tshock/tshock3/tshock.sqlite
  chown terraria:terraria /data/terraria/tshock/tshock3/tshock.sqlite
  systemctl start terraria3
  ```

## 3. 改动说明

- 目标组：**guest**（`config.json` 中 `DefaultGuestGroupName: "guest"`；Users 表为空 → 无注册制，
  所有进服玩家默认落在 guest 组，补 guest 即可覆盖所有玩家）。
- 改动动作：向 guest 组追加权限 `tshock.world.movenpc`。
- 未动 admin / trustedadmin / owner 等管理组，未动其它任何权限。

## 4. 验证（2026-08-10 SSH 实测）

| 验证项 | 结果 |
|---|---|
| live guest 组含 movenpc | ✅ `tshock.world.movenpc` 在列 |
| backup guest 组不含 movenpc | ✅ 确认此前缺失（= 用户被拦根因） |
| 全量 diff（live vs backup） | ✅ 仅 +`tshock.world.movenpc`，零其它改动 |
| 服务运行 | ✅ terraria3 active，PID 2009938 |
| 端口 | ✅ 0.0.0.0:6666 LISTEN |
| **权限已加载进内存** | ✅ 数据库编辑时间 18:01:22.27 **早于**服务重启时间 18:01:44，运行进程加载的是含该权限的库 |

## 5. 结论

用户「移动 NPC 没有权限」根因为 guest 组缺少 `tshock.world.movenpc` 权限，
已补入 guest 组并随服务重启生效，问题已解决，无需用户再次操作。

---
相关：`hk-terraria.md`（部署报告）、`/data/terraria/tshock/tshock3/tshock.sqlite`（组权限库）
