# UUMit 平台接入 — 第一步完成（skill 安装 + 授权准备）

日期：2026-08-11 19:3x
执行者：uumit-ops

## 完成状态
- [x] 读取安装入口（联网，非缓存）
- [x] 校验 bundle（bytes + sha256 一致）
- [x] staging 校验（install.js --check + validate_skill.js，无缺失/无漂移）
- [x] 安装全部 7 个 Skill 到正式目录（用户级全局技能根目录）
- [x] 正式目录复核通过（install.js --check）
- [x] 触发设备授权，获取授权链接 + 用户码
- [ ] **待用户授权**（用户操作，不由 agent 代替）

## 安装了什么
bundle `uumit-v2-53ae26537f3507c5.zip`（160755 bytes，sha256 53ae2653...e0d363 校验一致），7 个 Skill 全部安装到 `C:\Users\du_ji\.agents\skills\`：

| Skill | 角色 | 版本 |
|-------|------|------|
| uumit-agent | base（基座） | 2.4.1 |
| uumit-cruise | extension | 2.4.1 |
| uumit-realtime | extension | 2.4.1 |
| uumit-recommend | extension | 2.4.1 |
| uumit-publisher | extension | 2.4.1 |
| uumit-compute | extension | 2.4.1 |
| uumit-social | extension | 2.4.1 |

正式目录无已有 `uumit-agent/memory/`（全新安装），无需保留逻辑，staging 中 memory 仅含初始空 runtime 配置。已确认未覆盖任何已有凭证/配置。

## 授权信息（⚠️ 敏感，勿外传）
用户在平台页面操作以下信息：

- **授权链接**：`https://m.uumit.com/link`
- **用户码**：`21156894`
- **在哪输入**：打开授权链接，在平台页面输入用户码完成授权绑定

> 原始授权信息（含 device_code / 轮询命令）已保存在私有目录 `agents/uumit-ops/memory/uumit-auth.json`，不在公开位置。

## 下一步
1. **用户完成授权**（打开 `https://m.uumit.com/link` → 输入用户码 `21156894`）。
2. 授权完成后，由 agent 运行 `node scripts/auth.js --wait <device_code>` 轮询确认授权成功（等用户先操作，agent 不代替）。
3. 授权成功后可征询开启后台定时任务（install.js 输出 `background_tasks.scheduled` 字段）。

## 校验方法
- bundle 下载后 `sha256sum` 与 index.json 中声明一致（53ae2653...e0d363），bytes 160755 一致。
- staging/正式目录均通过 `install.js --check`（无 missing/mismatched）+ `validate_skill.js`（扫到全部 6 扩展）。
