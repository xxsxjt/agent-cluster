# HK Hermes 接入 org grp-server 节点 · 完工报告

- 任务：hermes-org-node
- 执行：server-admin / night-worker（接力）
- 完成时间：2026-08-06（接入完成）/ 2026-08-07（报告）
- 工作目录：`C:\Users\du_ji\pi_workspace\org`

---

## 一、Hermes 任务接收机制结论

### 1.1 单次执行模式

**结论：hermes 支持单次执行，命令为：**

```bash
hermes chat --provider org-newapi -q "$PROMPT" -Q --max-turns 24
```

- `-q / --quiet`：安静模式，从参数接收 prompt，不进交互 shell
- `-Q / --quit`：完成后立即退出（单次执行语义）
- `--provider org-newapi`：使用 config.yaml 中追加的 org-newapi provider（org 专用渠道，default 组，夜间健康）
- `--max-turns 24`：限制最大工具调用轮数，防止无限循环

### 1.2 凭据方案

- HK 本地 `/etc/xxsx-hermes/org.env`（root 600）存放 `ORG_OPENAI_API_KEY`
- 执行链：`root SSH 进入` → `source /etc/xxsx-hermes/org.env` → `su -p -s /bin/bash xxsx-hermes` → `hermes chat ...`
- 本地（Windows）侧不落任何凭据；SSH key 复用 `~/.ssh/id_ed25519_xxsx_hk`

### 1.3 butler 投递方式（最终结论）

```
butler.js 派 hermes 任务
  └→ lib/spawn.js spawnAgent({type:'hermes', prompt, donePath, ...})
       └→ node lib/hermes-run.js --done <inbox/xx.DONE> [--log logs/xx.log] [--model M]
            ├─ stdin: 任务 prompt（butler 写入）
            └─ SSH 两段式到 HK 100.97.18.59:43891
                 ├─ 第一段：上传 bash 脚本到 /tmp/org-hermes-run.sh
                 └─ 第二段：执行脚本（stdin=prompt）→ hermes chat -q -Q
                      └─ 结果经 stdout 回传 → 写 .DONE
```

kanban.db / cron 机制不选用：延迟不可控、无法同步回传结果。SSH + hermes chat -q 是最简直连通道。

---

## 二、实现清单

### 2.1 org.json 改动

`grp-server.children` 已加入 `"hermes"`，节点定义：

```json
"hermes": {
  "id": "hermes",
  "type": "agent",
  "label": "HK Hermes（平台网关）",
  "role": "gateway",
  "status": "active",
  "onlinePolicy": "lazy",
  "parent": "grp-server",
  "agentDir": "agents/hermes",
  "spawnType": "hermes",
  "children": [],
  "notes": "HK 常驻 Hermes（Nous hermes-agent 0.19.0，3588 API + 20 平台网关）。org 双内核互补：pi/claude 做任务执行，hermes 做常驻平台网关。任务经 SSH 驱动 hermes chat -q 单次执行（2026-08-06 hermes-org-node 接入）。",
  "lastTaskAt": "2026-08-06T16:50:20.270Z"
}
```

### 2.2 lib/hermes-run.js（新建）

SSH 两段式执行桥：
- 第一段 SSH：将 bash 脚本上传到 HK `/tmp/org-hermes-run.sh`（cat > 重定向）
- 第二段 SSH：执行脚本，stdin 传 prompt，stdout 回传结果
- HK 端脚本：`source /etc/xxsx-hermes/org.env` → `su xxsx-hermes` → `hermes chat --provider org-newapi -q -Q --max-turns 24`
- 凭据保护：`set -u`、`umask 077`、`ORG_OPENAI_API_KEY` 只在 HK 本地，脚本退出前 `rm -f` 临时文件
- 结果解析：优先识别 hermes `-Q` 输出中的推理框线（`┌─ Reasoning`）后内容，兜底取最后非空行
- 输出格式：写 `.DONE`（成功）或 `.FAILED: reason`（失败）

### 2.3 lib/spawn.js 适配（hermes 类型）

```js
} else if (type === 'hermes') {
  const hermesRun = path.join(__dirname, 'hermes-run.js');
  const doneMarker = opts.donePath || path.join(..., 'inbox', `${name}.DONE`);
  args = [hermesRun, '--done', doneMarker];
  if (log) args.push('--log', log);
  if (opts.model) args.push('--model', opts.model);
  child = spawn('node', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  // 1s 后写 stdin（hermes-run.js 收集 stdin 再执行）
  setTimeout(() => {
    try { child.stdin.write(prompt + '\n'); child.stdin.end(); } catch (e) {}
  }, 1000);
}
```

### 2.4 agents/hermes/ 目录

- `agents/hermes/identity.json`：人格描述（平台网关/常驻助理，capabilities，connection 说明）
- 无任何 HK 凭据（SSH key 路径指向 `~/.ssh/id_ed25519_xxsx_hk`，实际 key 不落本地）

---

## 三、验证结果

### 3.1 烟雾测试（2026-08-06 16:00–16:05，已完成）

多轮 smoke 测试（prompt="用一句话自我介绍"，model=deepseek-v4-flash）：

| 时间 | 结果 | 耗时 |
|------|------|------|
| 15:59:57 | ✅ DONE: 已按要求完成一句话自我介绍。 | ~11s |
| 16:00:50 | ✅ DONE: 已按要求完成一句话自我介绍。 | ~17s |
| 16:04:40 | ✅ DONE: 已用一句话完成自我介绍。 | ~10s |
| 16:05:38 | ✅ DONE（hermes 推理+回答） | ~9s |

中间几次失败因 SSH post-quantum key 警告（code 126/1/255），hermes-run.js 两段式脚本最终修复（BatchMode=yes + accept-new）。

### 3.2 闭环测试任务（2026-08-06 16:50:21 → 16:54:57，已完成）

butler 正式派发测试任务（`inbox/hermes-org-node-test.md`，agent=hermes，model=deepseek-v4-flash）：

| 事件 | 时间 |
|------|------|
| hermes-run 启动 | 16:50:21 |
| SSH 脚本上传成功 | 16:50:22 |
| SSH 执行开始 | 16:50:22 |
| SSH 退出 code=0 ✅ | 16:54:57 |
| .DONE 写入完成 | 16:54:57 |

**总耗时：约 4.5 分钟**（首次含 hermes 实例热启动 + org-newapi 路由）

`.DONE` 内容：hermes 收到任务后，尝试推理"如何创建 Windows 路径的文件"（因任务 prompt 中包含了 butler 层指令 `创建标记文件：C:\Users\...`，hermes 把它当作实际任务目标）。

**结论：机制全通**——SSH 连接、脚本执行、hermes chat、结果回传、.DONE 写入均正常。但暴露一个**任务内容设计问题**：

> ⚠️ butler 向 hermes 投递任务时，应剥离框架层的 `执行要求`（.DONE 文件路径等基础设施指令），只传递**纯业务 prompt**。建议 butler 在 `spawnType=hermes` 时去除或替换任务文件的 `执行要求` 段，让 hermes-run.js 负责回写结果（已实现），不让 hermes 自己感知文件路径。

### 3.3 控制台显示

org.json 更新后，控制台 grp-server 下显示三个节点：
```
服务器域 (grp-server)
  ├── xxsx-gateway   xxsx网关智能体       [sleeping]
  ├── server-admin   服务器运维智能体     [active]
  └── hermes         HK Hermes（平台网关）[active]
```

---

## 四、回滚方案

若需撤销 hermes 接入：

1. `org.json`：从 `grp-server.children` 移除 `"hermes"`，删除 `nodes.hermes` 条目
2. `lib/spawn.js`：删除 `else if (type === 'hermes')` 分支（~15 行）
3. `lib/hermes-run.js`：删除文件
4. `agents/hermes/`：删除目录

HK 侧无改动（hermes 现有 config/SOUL/gateway 保持原样，`org-newapi` provider 为追加配置不影响其他渠道）。

---

## 五、补充说明

- **HK 不动**：hermes 现有 SOUL.md / memories / gateway / kanban 配置完全不变，只加了一个 org-newapi provider（追加段）和 `/etc/xxsx-hermes/org.env`（root 600）
- **双内核定位**：pi/claude 做任务执行（可执行代码/bash/文件系统），hermes 做常驻平台网关（20+ 聊天平台值守/消息收发/工具调用），互补不竞争
- **模型默认**：`deepseek-v4-flash`，可通过任务文件头 `model: xxx` 覆盖，hermes-run.js 接受 `--model` 参数

---

*报告人：server-admin*
