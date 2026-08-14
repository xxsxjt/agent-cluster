# APP 通知乱码修复（hk-alert 中文编码链路）

日期：2026-08-12 17:3x ｜ 智能体：night-worker ｜ 任务：notify-encoding-fix

## 问题现场

用户报告管理 APP 通知乱码。数据库确认（HK `/data/xxsx-api/new-api-data/xxsx-new-api.db`）：

| id | 状态 | title | message |
|----|------|-------|---------|
| 306 | ❌ 乱码 | 正常中文 | `? CNB �����������֤ͨ��...`（GBK/UTF-8 错位） |
| 307 | ✅ 正常 | 正常中文 | 正常中文 |

乱码在**源头**（库表 message 字段），非 APP 显示层问题。

## 链路分析与根因

```
butler.js ──spawn(node→node, CreateProcessW 无损)──▶ hk-alert.js
   ──execFile('ssh', [..., cmd])──▶ ssh.exe（Windows OpenSSH）
   ──按本机 ANSI 代码页(GBK) 编码远程命令──▶ HK shell（UTF-8 locale）收到 GBK 字节
   ──curl -d '{...中文...}'──▶ new-api 入库乱码
```

**根因**：Windows OpenSSH `ssh.exe` 在把参数拼装为远程命令字符串时，非 ASCII 字符按本机 ANSI 代码页（GBK）编码；HK 端 shell/curl 按 UTF-8 解析 → 字节错位 → 库表乱码。

## 修复方案（已落地）

**base64 传参**（`scripts/hk-alert.js`，2026-08-12）：

- 本机：`payload`（UTF-8 JSON）→ `Buffer.from(payload,'utf8').toString('base64')`（纯 ASCII）
- SSH 命令只含 ASCII：`echo '<b64>' | base64 -d | curl ... --data-binary @-`
- HK 端：`base64 -d` 还原 UTF-8 字节 → `--data-binary @-` 原样提交 JSON

新增 `buildCurlCmd(url, token, payload)` 统一构造命令，**主任务分支与 --quota 分支均走此函数**。备份：`scripts/hk-alert.js.bak-encoding-fix`。

## 验证（真实通知，非 mock）

触发真实 task_done 通知（中文标题+中文摘要，node 内嵌 spawn 模拟 butler 调用）：

| id | 链路 | title | message |
|----|------|-------|---------|
| 334 | 旧方式（bash 传参，顺带暴露另一坑） | 乱码 | 乱码 |
| 335 | 同上 | 乱码 | 乱码 |
| **336** | **新 base64 链路** | **`notify-encoding-fix-验证3 · night-worker 已完成`** ✅ | **`文件方式传参验证：中文消息应完整无乱码`** ✅ |

336 中文完整无乱码 → 修复生效。334/335 为测试噪音已从库表删除，336 保留作证据。

## 附加发现（重要）

1. **Windows Git Bash → node.exe 传参中文损坏**：bash 命令行含中文参数传给 node 时被替换为 U+FFFD（`efbfbd`）字节，**不可逆**。测试 334/335 乱码即因此（非生产链路）。生产链路 butler.js 用 `spawn(process.execPath, args)`（node→node，CreateProcessW）无损，不受影响。
   - **疑似历史乱码 .DONE 文件（GBK/U+FFFD 污染）根因之一**——凡经 bash/sh 脚本以中文参数调用 node 工具的场景都可能踩此坑，建议排查相关脚本（与 2026-08-12 intel-gatherer 发现的"GBK 损坏 DONE 文件名"同源线索）。
2. HK 真实库为 `/data/xxsx-api/new-api-data/xxsx-new-api.db`（162MB，SQLite，非 `new-api.db` 空文件）。
3. ssh 传复杂引号命令易被本地 bash/MSYS 破坏，稳妥做法：本地写文件 → scp → 远端执行。

## 建议（后续可选）

- hk-alert.js 增加入参 U+FFFD 检测告警（防 bash 调用方再次静默损坏）；
- 排查全 org 用 bash 直接调 hk-alert.js 的入口（如 crontab/脚本），统一改 node spawn 或 base64。
