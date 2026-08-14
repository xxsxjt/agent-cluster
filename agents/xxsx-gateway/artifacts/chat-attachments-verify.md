# chat-attachments 完善补验报告（2026-08-08 · 任务 chat-attachments-improve）

> 源任务 `chat-attachments` 因「日志 20 分钟未更新疑似卡死」被判失败（2026-08-08 21:35:46 强制结束）。
> 分身/管家讨论决定重派完善任务，要求：查明失败原因 → 按原目标补验 → 补足验证证据再收尾。

## 一、失败原因查明

- **根因**：源任务执行智能体在定位 Android APP 项目路径时，用 `find C:/Users/du_ji -maxdepth 4 -type d -iname "*assistant*"` 搜错范围（只命中 `.workbuddy/skills`、`chrome-cdp/SSLErrorAssistant` 等无关目录），搜索陷入无效循环，日志 20 分钟未更新，被 butler 看门狗判「疑似卡死」强制结束。
- **误判点**：功能实现其实已完成大半，只是**验证证据缺失**导致验收不通过。真正的 APP 项目在 `C:/Users/du_ji/WorkBuddy/xxsx-proxy-gateway/apps/xxsx-admin-android`（不在 `pi_workspace` 下，故 find 没找到）。
- **注意**：源任务曾被自动重跑（第 1/2 次，PID 34040），与本次 improve 任务（PID 35164）并行执行，存在同批文件并发写风险；本次只做**只读验证**，不改动实现代码。

## 二、补验证据（全部实测通过）

### 1. 后端 org `/api/cluster/chat` 返回结构含 attachments
- 命令：`curl -H "x-pi-token: <clusterToken>" -d '{"message":"...最近集群文档..."}' http://127.0.0.1:8787/api/cluster/chat`
- 结果：`ok=true, backend=twin`，返回体带 `attachments` 数组（每项含 name/path/size/sizeText/kind/url）。
- 例：`{"name":"2026-08-08-chat-attachments.md","path":"knowledge/meetings/...","size":1205,"sizeText":"1.2 KB","kind":"md","url":"/api/cluster/docs/content?path=..."}`

### 2. OpenAI 兼容端点 `/v1/chat/completions` 同样带附件（HK 渠道用）
- 命令：`curl -H "Authorization: Bearer <clusterToken>" -d '{"model":"twin","messages":[{"role":"user","content":"..."}]}' http://127.0.0.1:8787/v1/chat/completions`
- 结果：`choices[0].message.attachments` 正常注入。

### 3. 附件下载接口可用
- `curl -H "x-pi-token: ..." "http://127.0.0.1:8787/api/cluster/docs/content?path=knowledge%2Fmeetings%2F2026-08-08-chat-attachments.md"` → HTTP 200，size=1205，内容为讨论纪要正文。

### 4. 集群文档列表源正常
- `/api/cluster/docs` → count=69（artifacts/knowledge 下非敏感文档）。

### 5. APP 前端构建验证
- 强制重编译：`./gradlew :app:compileDebugKotlin --rerun-tasks` → **BUILD SUCCESSFUL**（唯一 warning 为无关的 AlertsFragment）。
- 完整打包：`./gradlew :app:assembleDebug` → **BUILD SUCCESSFUL**，产物 `app-debug.apk` 7.6MB（2026-08-08 21:40 生成）。

### 6. APP 附件 UI 代码完整性
- `AssistantFragment.kt` 附件相关调用共 9 处（renderAttachments / buildAttachmentCard / downloadAttachment / openAttachmentFile 全部就位）。
- 文件卡片：文件名 + 大小 + 类型图标（md/pdf/docx/apk/html/csv/json），点击 → DownloadManager → 系统查看器。
- `FileProvider`（`${applicationId}.fileprovider`）已配置，`file_paths.xml` 存在，支持打开附件。
- 服务器页 `fragment_servers.xml` / `ServersFragment.kt` **已无「集群文档」按钮残留**（仅保留 clusterHealth/clusterDetails 监控），符合「移除按钮、文档走对话内附件」的要求。

## 三、结论

源任务功能实现完整（后端 attachments 注入 + HK mobile 路由 + APP 文件卡片渲染 + 服务器页按钮移除），本次补验**全部通过**。失败仅为定位 APP 路径时的搜索卡死，非功能缺陷。chat-attachments 目标达成。
