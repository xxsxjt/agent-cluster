# MC 域子域盘点与目标对齐报告

> 盘点日期：2026-08-10
> 执行代理：mc-dev（coordinator）
> 工作区：`D:\dx\agents\mc-agent`
> 触发：每日例会 2026-08-10 明日任务派发（nextday-2026-08-10-MC-域子域盘点与目标对齐）

---

## 一、子域进展总览

| 子域 | 智能体 | 当前版本 | 版本库 | 最近改动 | 状态 |
|------|--------|---------|--------|---------|------|
| 虚无圣殿 | mc-dev-temple | 1.0.0-beta.3 | ✅ git（main） | 2026-08-09 beta.3 提交推送 | 健康，可继续推进 |
| 地球：人类 | mc-dev-earth | 0.1.20 | ✅ git（main） | 7/19 后停滞 | 有 1 个 untracked 文件待清理 |
| 地球人体附属 | mc-dev-earth | 0.1.1 | ⚠️ 本轮补建 | 7/19 后停滞 | **本次已补建 .git** |
| 我的地球 | mc-dev-earth | 开发中 | ✅ git（main） | 7/19 | 文档/方案为主 |
| 魔幻地球 | mc-dev-earth | 0.7.0-alpha.* | ✅ git（main） | 7/19 | 已改名 Fantasy Earth |
| 玄幻地球 | mc-dev-earth | 0.7.0-alpha.1 | ✅ git（main） | 7/19 | 已改名 Xuanhuan Earth |
| 植物魔法修复 | mc-dev-plantmagic | 2.0.0 | ❌ 无 git | 6/17 构建 jar | 有结构性问题待处理 |

---

## 二、temple（虚无圣殿）— 下阶段目标

- **首日进展**：beta.3 归零终式改动已提交推送（HEAD c45a38c，main 分支），working tree clean。beta.3 全量功能（63 物品/15 方块/5 生物/97 配方/三武器动作/三级仪式/虚空宝库/传输核心）已在 8-9 复核归档于 `mod-[虚无圣殿]Temple of Nihility/docs/artifacts/mc-mod-status.md`。
- **下阶段目标**：
  1. 在 beta.3 基线上选取 1-2 个高优先级未完成项实际推进（衔接 backlog mc-continue）
  2. 推进过程中保持每次改动即 commit，杜绝再次出现"264 项改动未提交"的风险
  3. 维护 74 个 JUnit 回归 + 481 组中英文键一致性门禁

## 三、earth（地球系列）— 下阶段目标

- **首日进展**：5 个项目已有版本库，均已发布构建 jar。earth_human 0.1.20 已提 CurseForge 预览。
- **本轮动作**：`earth_human_body`（地球人体附属，此前唯一缺版本库）已补建 .git 并提交初始版本（commit 7646e8f，14 个源文件，build/runs 已被 .gitignore 排除）。
- **下阶段目标**：
  1. earth_human 清理 1 个 untracked 文件（`docs/curseforge-changelog-0.1.18.md`）——纳入版本库
  2. 各 earth 子项目如需改动，一律先 commit 基线再改（已全部具备版本库保障）
  3. 待用户明确产品方向后，再决定是否继续推进各地球版本

## 四、plantmagic（植物魔法修复）— 待修复问题清单

- **首日进展**：2.0.0 已有构建 jar（6/17），修复了两个问题：①为所有实体注册 `portlib:player.sneaking_speed` 属性；②mixin 补 `Player.getAttributeValue(Holder<Attribute>)` 修复 portlib 0.1.1 coremod（内嵌 terra_curio）的 NoSuchMethodError。
- **待修复问题清单**（本次盘出，按优先级）：

| # | 优先级 | 问题 | 位置 | 说明 |
|---|--------|------|------|------|
| 1 | 🔴 P0 | **lang 命名空间错位** | `src/main/resources/assets/dmnr/lang/zh_cn.json` | 误放了"神龙魔法与遗物(DM&R)"mod 的 300+ 翻译条目，与本 mod（`plantmagic_fixes`）无关，纯冗余占用 |
| 2 | 🟠 P1 | **缺 en_us.json** | `assets/` 下无本 mod 语言文件 | 无任何本 mod 语言文件，存在时会被语言缺失警告 |
| 3 | 🟠 P1 | **无版本库** | 项目根目录 | 无 .git，改坏难回滚——应参照 earth_human_body 补建 .git |
| 4 | 🟡 P2 | **隐式依赖未声明** | `mods.toml` | 实际运行依赖 portlib/terra_curio，但 mods.toml 仅声明 forge/minecraft，建议加 optional 依赖提示 |
| 5 | 🟡 P2 | **mixins 注册遗漏注释** | `plantmagic_fixes.mixins.json` | 已正确声明 PlayerAttributeFixMixin；如需扩展修复需补充更多 mixin 条目 |

- **下阶段目标**：先处理 P0 lang 命名空间错位（删除 dmnr 冗余 + 建立本 mod 的 en_us/zh_cn），再补建 .git 版本库，最后按需处理依赖声明。

---

## 五、结论

MC 域 3 子域结构完整：temple 健康可续推、earth 全量已具备版本库、plantmagic 暴露 1 个 P0 + 2 个 P1 待修问题。本轮已实际落地 earth_human_body 的 .git 补建（earth 系列唯一缺口），其余为下阶段待办。
