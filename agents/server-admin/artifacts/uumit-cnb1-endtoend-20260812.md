# UUMit skill 从 CNB 空间1 端到端验证（2026-08-12 16:0x）

**执行者**：server-admin（任务 nextday-2026-08-11-UUMit-授权落地-152618）
**结论**：✅ **UUMit skill 已在 CNB 空间1 端到端可用**

## 背景与关键发现

任务要求验证 UUMit skill 从 CNB 空间1 端到端可用。调查发现：

- UUMit skill 于 2026-08-11 在 CNB **旧实例**上完成安装 + 授权激活（uumit-activate.DONE 已存在，凭证有效）。
- 但当前 CNB 空间1 实例 `cnb-6mg-1jvqf99j6`（今天 15:52 新建）是**全新实例**，`/data/cnb-org/` 下**无 skills 目录、无任何 uumit skill**——旧实例已被回收。
- 这正是记忆中的既有教训：**CNB 空间约 10min 闲置即回收重建，环境全丢**；cnb-task 自愈只补 java/gradle/pi 构建环境，**不恢复 UUMit skill**。

因此在验证前，先把已激活的 skill（含凭证）从本机恢复到空间1。

## 恢复部署步骤

1. **空间1 回收检测**：cnb-6mg-1jvqf99j6 转 closed → 用 `cnb-ctl.js start 1` + `wait 1` 启动新实例 `cnb-n1o-1jvqfv540`。
2. **打包**：本机 `.agents/skills/uumit-{agent,compute,cruise,publisher,realtime,recommend,social}` 7 个 skill 打成 `uumit-skills.tar.gz`（132KB）。
3. **scp 上传**到空间1 `/tmp/`（注意：scp 用 IPv4 `-4`，git bash grep 管道会让退出码误报，实际传输成功）。
4. **解压部署**到 `/data/cnb-org/skills/`（ownership 警告无害，root 下可执行）。

## 端到端验证结果（全部通过）

| 验证项 | 命令 | 结果 |
|---|---|---|
| 环境 | node -v | v22.23.1 ✅ |
| 凭证有效 | `scripts/auth.js --check` | `{authorized: true}` ✅ |
| 能力发现（API 连通） | `scripts/capability_discover.js --query "AI 智能体接单与技能上架"` | 返回 5 条真实能力（AI 智能体接单 free / ASCII 视频创作 10UT / AA1 语音 100UT 等）✅ |
| 激活连接状态 | `rest_request.js GET /api/v1/external-agents` | `code:0 success`，多个 agent 连接均 `active` ✅ |
| Agent Card | `rest_request.js GET /.well-known/agent.json` | 正常返回（a2a/1.0）✅ |
| 完整性校验 | `scripts/validate_skill.js` | 6 扩展全部识别，版本 2.4.1，shared_memory 指向正确 ✅ |
| 6 扩展就位 | ls 校验 | uumit-compute/cruise/publisher/realtime/recommend/social 的 SKILL.md 全部 OK ✅ |

## 部署清单（空间1）

```
/data/cnb-org/skills/
  uumit-agent/   320K  (含 memory/uumit-auth.json 凭证)
  uumit-compute   8K
  uumit-cruise   80K
  uumit-publisher 24K
  uumit-realtime  20K
  uumit-recommend 12K
  uumit-social    12K
```

## 后续建议

- **CNB 空间回收即丢 UUMit skill** 是反复踩坑点。建议后续把 UUMit skill 纳入「空间环境自愈」——在 `cnb-init-env.sh` 或 cnb-task 自愈脚本中，检测 skills/uumit-agent 缺失时自动从本机恢复（与本任务相同方式），避免每次手动重装。
- 本实例为新建空间，闲置约 10min 仍会被回收，长时间不用属正常现象。
