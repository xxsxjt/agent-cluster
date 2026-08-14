# 泰拉瑞亚权限全面修复报告（6666 / HKWorld3 / tshock3）

- 日期：2026-08-12 17:56
- 执行：server-admin / terraria-perms-fix
- 服务器：HK 103.100.159.111，terraria3.service（TShock 6.1.0，端口 6666，世界 HKWorld3）
- DB：`/data/terraria/tshock/tshock3/tshock.sqlite`

## 结论一句话

**用户 2026-08-11 报告的问题（召唤事件无权限 + "访客啥权限都没有"）已被今日 15:57 的会话完整修复并重启生效**（guest 组从 22 权限补全到 50 权限，含 `tshock.npc.startinvasion` 等全部正常游玩权限）；本任务完成**权限全面核验 + DB 去重净化（79 条→50 条，语义不变）+ 留档**，未重启服务（有玩家连接活动，保护在线玩家）。

## 一、权限演变时间线（还原用户报告的根因）

| 时间 | guest 组状态 | 证据 |
|---|---|---|
| 2026-08-11 23:57（用户 20:5x 报告后） | **仅 22 权限**：无 `startinvasion`、无 `tp.home/tp.self/tp.rod/tp.warp`、无 `tile.change/tile.paint/item.use/item.place`、无 `home`、无 `buff.self`、无 `npc.*`、无 `spawnboss/spawnmob` | `tshock.sqlite.bak-perms-20260811` |
| 2026-08-12 15:23 | 29 权限（第一次补全） | `tshock.sqlite.bak-perms2-20260812` |
| 2026-08-12 15:44/15:57 | **50 权限**（补全至完整，含 `startinvasion` 等）→ **15:57:28 重启服务**（PID 2645478，内存加载新权限） | `bak-perms3/perms4-20260812` + `ActiveEnterTimestamp=15:57:29` |

> 用户报告时点（8-11 晚）guest 组连 TP 回家、建造、buff 都没有，正是"访客啥权限都没有"的直接根因；`startinvasion` 缺席导致血月/日食/哥布林入侵召唤无权限。

## 二、guest vs default 对比（任务书要求）

**结论：guest（50 权限）⊇ default（46 权限），guest 已覆盖并超过 default。无需把玩家默认分组改为 default，保持 `DefaultGuestGroupName: "guest"` 即可。**

- 无注册制确认：`RequireLogin: false` + `DisableLoginBeforeJoin: true` + `DefaultGuestGroupName: "guest"` → **guest = 所有玩家默认组**
- guest 独有（default 没有）：`tshock.account.register/login`（无注册制下用于 /register /login）
- default 有的 guest 全部已有（default 组自身也有重复条目，非本次范围，可后续净化）

## 三、guest 组最终权限清单（50 条，按字母序）

```
tshock.account.changepassword  tshock.account.login          tshock.account.logout
tshock.account.register        tshock.buff.self              tshock.canchat
tshock.home                    tshock.ignore.dropbanneditem  tshock.ignore.sendtilesquare
tshock.item.place              tshock.item.use               tshock.npc.*
tshock.npc.butcher             tshock.npc.rename             tshock.npc.spawnboss
tshock.npc.spawnmob            tshock.npc.spawnpets          tshock.npc.startinvasion
tshock.npc.startinvasion2      tshock.npc.summonboss         tshock.paint
tshock.partychat               tshock.projectile.usebanned   tshock.region.create
tshock.region.edit             tshock.region.protect         tshock.reserved.vip
tshock.sendemoji               tshock.serverinfo             tshock.synclocalarea
tshock.thirdperson             tshock.tile.change            tshock.tile.paint
tshock.tp.demonconch           tshock.tp.home                tshock.tp.magicconch
tshock.tp.pylon                tshock.tp.rod                 tshock.tp.self
tshock.tp.tppotion             tshock.tp.warp                tshock.tp.wormhole
tshock.warp                    tshock.whisper                tshock.world.modify
tshock.world.movenpc           tshock.world.paint            tshock.world.settle
tshock.world.time.set          tshock.world.worldupgrades
```

对照"正常游玩"清单核验：**召唤事件 startinvasion ✅ / 召唤 Boss summonboss ✅ / 宠物 spawnpets ✅ / TP 全系 ✅ / warp+home ✅ / 世界升级 worldupgrades ✅ / NPC 全量 npc.* ✅ / 家具建造 tile.*+item.* ✅ / 染色 paint ✅ / 聊天 canchat+whisper+partychat ✅ / 区域 region.* ✅ / buff.self ✅** —— **无缺漏**。

## 四、本次操作（2026-08-12 17:56）

| 步骤 | 结果 |
|---|---|
| DB 备份 | `tshock.sqlite.bak-permsfix-20260812`（90112 字节，root 属主同历史备份惯例）✅ |
| guest 去重净化 | 79 条（重复 3-4 次，历史追加痕迹）→ **50 条唯一**，保持首次出现顺序，语义不变 ✅ |
| 其他组 | default/vip/admin/owner 等 **LENGTH 均未变**，零影响 ✅ |
| 文件属主 | `terraria:terraria` 未变，无 wal/journal 残留 ✅ |
| 服务 | **未重启**（17:48 有玩家 164.52.24.179 连接活动；权限语义不变，无需重启）✅ |

> 内存/DB 一致性说明：服务 15:57:28 启动时已加载 50 权限集合；本次去重只删除重复项、不改变权限集合，内存与 DB **语义完全一致**，下次自然重启后字节级对齐。

## 五、验证记录

| 检查项 | 结果 |
|---|---|
| terraria3.service | active，ActiveEnterTimestamp 15:57:29（3.5h+ 无重启）✅ |
| guest 权限去重后 | 50 条 ✅ |
| 关键权限抽查 | startinvasion / summonboss / tp.home / npc.* 均在 ✅ |
| config 无注册制 | RequireLogin=false + DefaultGuestGroupName=guest ✅ |
| DB 其他组 | 未受影响 ✅ |
| 在线保护 | 17:48 连接未成功进服（无"加入了服务器"记录）；未重启 ✅ |

## 六、说明与建议

1. **用户 8-11 报告的问题已解决**：8-12 15:57 起 guest 组即含全部正常游玩权限（含召唤事件），玩家无需任何操作，直接进服即可召唤血月/日食/哥布林入侵。
2. 若想再彻底确认玩家视角：玩家进服后用 `/group` 查询自己组，或直接用召唤物（Bloody Tear / Solar Tablet / 哥布林战旗）实测。
3. 后续可净化项（本次未动，最小改动原则）：default/vip 组同样存在重复条目（历史追加痕迹），无功能影响，如需要可随时去重。
4. 8-11~8-12 期间多个会话先后修改过 guest 组（备份文件名 perms/perms2/perms3/perms4/fullperms 可见），重复条目即追加式修改的痕迹；建议后续权限修改统一走 TShock `/group` 命令或先备份再 UPDATE，避免重复累积。

## 回滚

```bash
# 恢复去重前的 DB（含重复条目版本，语义相同）
cp /data/terraria/tshock/tshock3/tshock.sqlite.bak-permsfix-20260812 /data/terraria/tshock/tshock3/tshock.sqlite
chown terraria:terraria /data/terraria/tshock/tshock3/tshock.sqlite
systemctl restart terraria3   # 需玩家离线时段
```
