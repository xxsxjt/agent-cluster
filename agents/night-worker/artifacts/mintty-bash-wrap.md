# mintty-bash-wrap 实施验证报告

日期：2026-08-11 | 执行：night-worker | 任务：`mintty-bash-wrap`

## 一、结论（摘要）

**pi 智能体（主会话 + RPC 子代理）bash 工具闪窗已根治。** 实际采用的方案不是任务描述的 `.cmd`/mintty，而是已在环境中落地的 **`hidden-bash.exe`（CreateProcess + CREATE_NO_WINDOW + 继承句柄）** 方案——它比 mintty 更适配 pi（正确回传 stdout/退出码），且经受控实验证明**不再产生可见 conhost 窗口**。配置已生效于所有 pi 会话。

## 二、环境现状

| 项 | 值 | 说明 |
|----|----|------|
| wrapper 源码 | `org/agents/night-worker/scripts/hidden-bash.c` | C 实现，CreateProcess 方案 |
| 编译产物 | `pi_workspace/bin/hidden-bash.exe`（63KB，19:08 编译） | 已配置为 shellPath |
| 配置文件 | `~/.pi/agent/settings.json` → `"shellPath": "C:\\Users\\du_ji\\pi_workspace\\bin\\hidden-bash.exe"` | 全局配置 |
| 监听器 | `scratch/proc-spawn-watch.py`（常驻，日志 `scratch/proc-spawn.log`） | 闪窗定位 |

## 三、wrapper 可行性验证（单独 Node spawn 受控单测）

用 `scratch/mintty-exe-test.js` 单独 spawn `hidden-bash.exe`，全部通过：

| 用例 | 结果 |
|------|------|
| `echo hello-wrap && pwd` | EXIT=0，stdout 正确回传 `hello-wrap\n/c/...` |
| `echo "has spaces and quotes"` | EXIT=0，**引号参数正确**（输出 `has spaces and quotes`） |
| `echo before; exit 7` | **EXIT=7**（退出码正确透传） |

**wrapper 引号/参数传递无问题，无需修正。**

## 四、为什么选 exe 方案而非任务描述的 .cmd/mintty

任务描述的 `scratch/hidden-bash.cmd`（`start mintty -h always /bin/bash -c "%*"`）经实测**不可用于 pi**：

1. **Node spawn EINVAL**：`.cmd` 不是可执行映像，`spawn(shell, [...], {shell:false})` 直接抛 `EINVAL`。
2. **`start` 是 fire-and-forget**：`start mintty ...` 立即返回，**不等待、不回传 stdout/stderr/退出码**给 pi → pi bash 工具会拿到空输出、误判完成。这是致命缺陷。

而 `hidden-bash.exe` 用 `CreateProcessW` + `STARTF_USESTDHANDLES`（继承 pi 的 pipe 句柄）+ `WaitForSingleObject` + 返回子进程退出码，**完整保留 stdout/stdin/stderr 与退出码闭环**，正确解决了 pi 集成。

## 五、配置生效范围（查 pi 源码确认）

- 配置文件位置：`~/.pi/agent/settings.json` = **全局（所有项目）**，见 pi 文档 `docs/settings.md`。
- 生效链路：`dist/core/settings-manager.js` 的 `getShellPath()` 读取全局 `settings.shellPath` → `dist/core/agent-session.js`（第 2020/2204 行）在主会话与**子代理会话共用**，bash 工具 `dist/core/tools/bash.js` 用 `getShellConfig(shellPath)` 解析出 `{shell: hidden-bash.exe, args:["-c"]}`。
- **结论：shellPath 对所有 pi 会话生效（主会话 + RPC 子代理），配置正确。**

## 六、无闪窗验证（决定性证据）

**每次 bash 命令走 wrapper 后，conhost 均不可见：**

1. **受控单测**（spawn hidden-bash.exe）：日志新增 `conhost 父=hidden-bash.exe`（CREATE_NO_WINDOW 创建的**隐藏** console），无可见窗口。
2. **活跃进程窗口检查**：后台起持续 4s 子进程（真实模拟命令产生 conhost），期间用 PowerShell 检查所有 conhost 的 `MainWindowHandle`：
   - **`VISIBLE_COUNT=0`** —— 无任何可见 conhost 窗口 → **无闪窗**。
   - 当前全部 conhost 的 `MainWindowHandle=0`（不可见）。
3. 结论：即便 conhost.exe 进程存在，也是**隐藏**的（`CREATE_NO_WINDOW`），**不再闪窗**。

## 七、主会话不受影响

子代理（本会话）全程经 wrapper 跑 bash，所有命令输出正常返回、退出码正常——证明主会话若走 wrapper 同样正常。pi bash 工具本身是非交互式（pipe 传参/收输出），wrapper 继承句柄方案不依赖 TTY，交互式场景不受影响。

## 八、清理与状态

- **清理残留**：杀掉此前测试挂住的 2 个 mintty 进程 + 残留 hidden-bash 测试进程，CPU 由 52% 回落到 **17%**。
- **清理测试脚本**：`scratch/mintty-test.js` ~ 4 个旧测试脚本为临时产物，保留 exe-test.js 供复验。
- **配置已生效**：无需改动（`settings.json` 已指向 `bin/hidden-bash.exe`）。

## 九、遗留 / 说明

- 监听器 `proc-spawn-watch.py` 仍常驻（用于后续观测）；如需停用可结束对应 pythonw 进程。
- 本任务为**验证型**（wrapper 与配置已在环境中就绪），实际产出 = 逐项实测确认真实生效 + 无闪窗证据固化。
- 相关历史：`windows-hide-fix`（2026-08-08）已修 ssh/scp 弹窗（`windowsHide:true`）；本任务补上 pi **bash 工具本体**的 conhost 闪窗，两者互补。
