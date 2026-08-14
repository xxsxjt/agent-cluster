# plantmagic_fixes_mod — 待修复问题清单（验证证据落地方案）

> 来源：daily-meeting-2026-08-11-mc-dev-plantmagic-improve 补验
> 核验时间：2026-08-11 22:2x
> 项目路径：`D:/dx/agents/mc-agent/plantmagic_fixes_mod`
> 构建目标：Forge 1.20.1-47.4.0 / Java toolchain 17 / 当前版本 2.0.0（6/17 构建）

## 已核验事实（补验证据）
- 源码仅 2 个 Java 文件，全部存在且内容与汇报描述一致：
  1. `src/main/java/com/plantmagic/fix/PlantMagicFixes.java`（34 行）——注册 `portlib:player.sneaking_speed` 属性到实体。
  2. `src/main/java/com/plantmagic/fix/mixin/PlayerAttributeFixMixin.java`（约 30 行）——为 `Player` 添加 `getAttributeValue(Holder)` 方法，规避 portlib 0.1.1 coremod 注入字节码导致的 `NoSuchMethodError`。
- 构建产物 `build/libs/` 存在两个 jar：`plantmagic_fixes_mod-1.0.0.jar`（6/14）、`plantmagic_fixes_mod-2.0.0.jar`（6/17）。
- build.gradle：Forge 1.20.1-47.4.0，MixinConfigs `plantmagic_fixes.mixins.json`，toolchain Java 17，group `com.plantmagic.fix`。

## 待修复问题清单（按优先级）

### P0 — 环境/构建链
1. **本机 Java 24 与 toolchain 17 不匹配**：`java -version` 返回 24.0.2，而 build.gradle 要求 toolchain Java 17；若本机未装 JDK17，gradle 首次构建会尝试自动下载或失败。需确认/安装 JDK17 或调整 toolchain。
2. **Forge 1.20.1-47.4.0 依赖缓存缺失**：`~/.gradle/caches` 无 Forge 1.20.1 依赖，首次构建需联网下载（体积大、耗时长），需在稳定网络环境执行。

### P1 — 代码健壮性
3. **portlib 属性静默降级**：`PlantMagicFixes.java` 中 `ForgeRegistries.ATTRIBUTES.getValue("portlib:player.sneaking_speed")` 为 null 时直接静默跳过（`sneakingSpeed != null` 判断 + `try/catch ignored`），无任何日志。若 portlib 未安装，玩家实际拿不到修复，故障难排查。建议：null 时打印 WARN 日志。
4. **异常全被吞掉**：`event.add` 的异常全部 `catch (Exception ignored)` 丢弃。建议：区分"已存在"（可忽略）与"真实异常"（应记录）。

### P2 — 待验证/潜在
5. **@Unique 方法实际是否生效**：`PlayerAttributeFixMixin` 用 `@Unique` 添加同名方法而非 `@Shadow`/`@Inject`，需在真实客户端（装了 portlib/terra_curio）验证是否能真正拦截 coremod 的调用，避免运行期仍 NoSuchMethodError。
6. **依赖版本陈旧**：版本停在 2.0.0（6/17）且无近期改动，需父 mc-dev 确认是否有上游 plantmagic/portlib 更新需要跟进。

## 建议下一步
- 父 mc-dev 确认修复优先级后，先解决 P0（JDK17 + 依赖下载），跑通一次真实 gradle 构建；
- 修复 P1 代码健壮性（加日志）；
- 真机/客户端验证 P2 的 mixin 生效性。
