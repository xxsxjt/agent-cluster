# browser-ext.mjs 升级到 codex 完整协议能力

**日期**：2026-08-06
**任务**：browser-ext-upgrade
**状态**：✅ 完成（浏览器实测闭环通过）

## 背景

用户反馈 ChatGPT 扩展（浏览器控制）"用的还是不太行"——空白页残留、attach 空白、关不掉用户 tab、体验差。根因：`browser-ext.mjs` 只实现了扩展协议的 5 个命令（attach/createTab/executeCdp/getTabs/getUserTabs），扩展协议本身支持完整能力（claimTab/finalize/mark_tab/navigate/可见DOM等）未实现。

## 一、协议命令清单（从 codex browser-client.mjs 逆向，wire 层）

**帧格式**：4 字节小端长度前缀 + JSON `{id, jsonrpc:"2.0", method, params}`；session 方法需带 `{session_id, turn_id, session_context}`。

**wire 层 transport 方法（camelCase，扩展原生）**：

| 方法 | 参数 | 用途 |
|---|---|---|
| `attach` | `{tabId}` | 附加调试器（⚠️ 有竞态：返回 OK 不保证 attached:true） |
| `attachTarget` | `{tabId, targetId}` | 按 targetId 补附加（孤儿/竞态 tab 必需） |
| `detach` | `{tabId}` | 分离调试器（验证失败时重置状态的关键） |
| `executeCdp` | `{target:{tabId}, method, commandParams}` | 任意 CDP 命令 |
| `getTabs` / `getUserTabs` | `{}` | 会话标签页 / 真实用户标签页 |
| `claimUserTab` | `{tabId}` | **claim 用户标签页（tabId 必须整数）** |
| `finalizeTabs` | `{keep:[{tabId,status}]}` | **结束会话清理（status ∈ deliverable\|handoff）** |
| `markTab` | `{tabId, status}` | **标记保留状态** |
| `createTab` | `{}` | 新建标签页（继承登录态） |
| `getInfo` | `{}` | 扩展信息/能力 |
| `focusTab` / `nameSession` | — | 聚焦 / 命名会话 |

**snake_case 工具命令**（close_tab/create_tab/navigate_tab_url/playwright_dom_snapshot/dom_cua_get_visible_dom 等 50+）是 codex **客户端本地 handler**（内部用 CDP 实现），wire 层等价操作：
- close → `Target.getTargets` + `Target.closeTarget(targetId)`（用户 tab 必须走这个，Page.close 对非会话 tab 无效）
- navigate/reload → `Page.navigate` / `Page.reload`
- back/forward → `Page.getNavigationHistory` + `Page.navigateToHistoryEntry`
- DOM 快照 → `Runtime.evaluate` 可见 DOM 提取

## 二、新增能力（browser-ext.mjs v2）

1. **claimTab(tabId)**：`claimUserTab` 接管用户真实标签页（整数 id）
2. **finalizeTabs(keep)**：结束会话清理，对齐 codex tab-cleanup 规范（agent tab 默认关，deliverable/handoff 保留，claimed 用户 tab 释放不关）
3. **markTab(tabId, status)**：deliverable/handoff 标记
4. **navigate/reload/back/forward**：完整导航命令
5. **可见 DOM 快照**（替代 body.innerText）：过滤隐藏元素 + 语义标签（[H1]/[链接]/[按钮]/[INPUT]）
6. **attachFull**：attach → 验证 Target.getTargets attached → attachTarget 补附加 → Runtime.evaluate 验证 → 失败 detach 重置重试
7. **closeTab 修复**：Target.closeTarget 关闭（用户 tab 也有效）

## 三、实测结果（真实 Edge + ChatGPT 扩展）

| 测试项 | 结果 |
|---|---|
| get 打开+读取 | ✅ 标题/URL/可见 DOM 正常 |
| open 复用用户 tab | ✅ 8/8 连续复用成功（claim+attach） |
| about:blank 残留 | ✅ 0（多开多次验证） |
| claim 用户空白 tab 并关闭 | ✅ 成功（attachTarget + Target.closeTarget） |
| text/dom/click/type/shot | ✅ 全部正常（click 真实跳转 IANA、type 输入 DuckDuckGo 搜索框） |
| nav url/back/forward/reload | ✅ 全部正常（3-4 秒/次） |
| mark/finalize | ✅ 标记保留→finalize 后保留；无 keep→关闭 agent tab |
| 与 codex 扩展共存 | ✅ 同一管道，getInfo 正常，未破坏 codex 兼容 |
| 性能 | ✅ 命令 0.6-7 秒（修复前 30 秒挂起） |

## 四、踩坑记录（重要）

1. **TargetInfo 字段是 `id` 不是 `targetId`**：取错报 "Either tab id or extension id must be specified"
2. **页面导航/重载分离调试器**：导航后必须重新 attachFull
3. **attach 返回 OK 不保证 attached**：必须 attachTarget 补附加 + evaluate 验证
4. **detach 重置是修复关键**：attach 验证失败时先 detach 再重试（未附加时 detach 报错可忽略）；但别对同一 tab 高频反复 detach（可能损坏扩展侧状态）
5. **claimUserTab/markTab 的 tabId 必须是整数**（wire 层 tabs.get(integer)）
6. **定时器泄漏**：send() 30s 超时和 connectPipe 5s 定时器必须 clearTimeout，否则进程挂起 30 秒

## 五、文件变更

- `C:\Users\du_ji\.agents\skills\browser-control\scripts\browser-ext.mjs`（升级 v2，15.5KB→22KB）
- `C:\Users\du_ji\.agents\skills\browser-control\SKILL.md`（命令清单 + v2 能力 + 踩坑更新）
- 参考：`codex-browser/scripts/browser-client.mjs`（只读逆向，未改动）
- 测试残留清理完毕（测试 tab 全部关闭，用户真实页面未动）
