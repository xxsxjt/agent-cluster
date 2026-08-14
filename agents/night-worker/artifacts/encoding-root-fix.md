# 乱码根治 + 智能体知识同步（encoding-root-fix）

> 执行：night-worker ｜ 日期：2026-08-12 ｜ 任务来源：用户指出"乱码一直没根 + 有些智能体没更新新信息"

## 一、根因分析（实证）

Windows 上 Python 的 locale 默认编码 = **cp936 (GBK)**，实测证据：

| 层 | 现象 | 实测 |
|---|---|---|
| `open()` 默认编码 | python 写文件默认 GBK 落盘 → 中文文件乱码 | `locale.getpreferredencoding(False)` = `cp936`；裸 `open(p,'w')` 写中文 → GBK 字节 |
| `sys.stdout` | print 中文进管道按 GBK 编码 → 下游 UTF-8 解析炸 | `sys.stdout.encoding` = `gbk` |
| 规范文件被写坏 | 2026-08-12 追加到 conventions.md 的第 7-10 条是 GBK 损坏字节（`\xef\xbf\xbd` 替换符 + GBK 残留）→ **执行智能体读到的是乱码规则 → "不知道新信息"的直接原因** | 字节实证：`knowledge/conventions.md` 尾部 2000 字节损坏 |
| 文件名乱码 | inbox 45 个 checkpoint-DONE 文件名含 U+FFFD（GBK 字节被 UTF-8 解码失败产物）→ 巡检/派发工具无法识别 → 重复派发 | 实证：45 个 `checkpoint-...\ufffd...DONE` |
| 工具链传参 | Git Bash → Windows python 的命令行中文参数损坏（MSYS2 转换层 GBK） | 实证：`echo 中文 > file` 落盘即 `efbfbd...` |

**结论**：乱码链路 = Windows GBK locale 环境下，任何"python 裸 open() 写中文 / print 中文 / 命令行传中文参数"都会产生 GBK 字节；被 UTF-8 读取即炸。规范文件本身也被写坏，导致知识传达失效。

## 二、修复措施（已落地）

### 1. Python 全局 UTF-8 强制（三层）
- **用户环境变量**：`PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`（`setx` 已写入注册表，新进程生效）
- **sitecustomize.py**（`C:\Users\du_ji\AppData\Roaming\Python\Python314\site-packages\sitecustomize.py`，启动自动加载，对已运行环境即时生效）：
  - stdout/stderr `reconfigure(encoding='utf-8')`
  - monkeypatch `builtins.open` / `io.open`：文本模式未显式指定 encoding 时默认 UTF-8（读带 errors='replace' 容错）
- **脚本显式修复**：`agents/video-prod/project/generate_videos.py` 文本模式 open 补 `encoding='utf-8'`（其余 8 个扫描到的 py 均为 `rb/wb` 二进制模式，无需改）

### 2. PowerShell 写文件补 `-Encoding utf8`
- `scripts/org-watchdog.ps1`（watchdog 日志）
- `scripts/security-phish-monitor.ps1`（3 处 Add-Content）
- `agents/system-ops/scripts/360-remediate-safe-mode.ps1`（Log 函数 + runBak）

### 3. 官方 DONE 写入工具（杜绝子代理自由发挥）
- **新增 `org/scripts/write-done.js`**：node 原生 UTF-8 写 `inbox/<name>.DONE|.FAILED`，写后字节校验（含 U+FFFD 即拒写删除），防路径穿越
- 用法：`node org/scripts/write-done.js <任务名> "<一行摘要>"`

### 4. 规范文件修复（知识传达失效的根源）
- **`knowledge/conventions.md` 尾部乱码修复**：保留完好前缀（19115 字节），损坏的第 7-10 条按 GBK 单字节对还原 + 2026-08-12 会话语境推断恢复（分身思维默认/协作规范再强调/验收闭环增强/识图功能），并新增 **《编码规范》章节**（写文件一律 UTF-8、DONE 用官方工具、禁 U+FFFD、禁裸 open 写中文）
- 修复后 `file` 确认 UTF-8、无 FFFD

### 5. 智能体知识同步机制（"执行智能体不知道新规范"的根治）
- **新增 `knowledge/task-inject.md`**：任务级规范速查单一来源（编码铁律/知识库路径/任务规范/纪律速查），由 learning-officer 或进化机制维护
- **新增 `lib/knowledge-inject.js`**：butler 每次派发任务时**实时读取** task-inject.md（无缓存），构建注入块；文件缺失/损坏时回退内置核心规则
- **`butler.js dispatch()` 挂载**：任务 prompt 注入 `【任务必读 · 全局规范自动注入】` 块 → **每次任务执行自动携带最新规范，智能体无需主动查找**
- 重启预约：`restart-butler-on-idle.js` 已预约（活动任务收尾后自动重启 butler 加载，max-wait 240min）

### 6. 乱码存量清理
- inbox 45 个乱码 DONE（文件名含 U+FFFD）→ 移入 `org/archived/mojibake-done-20260812/`（不删除，防丢信息；巡检工具不再被干扰）

## 三、验证结果

| 验证项 | 结果 |
|---|---|
| python 裸 open() 写中文 → 字节为 UTF-8、读回正确、stdout=utf-8 | ✅ PASS |
| sitecustomize 对已运行环境即时生效（无需等新进程） | ✅ PASS |
| write-done.js 真实场景（node 子进程传中文参数）→ 写 UTF-8 字节、校验通过 | ✅ PASS |
| write-done.js 拒绝损坏输入（bash 传参损坏场景）→ 拒写删除 | ✅ PASS（负向） |
| knowledge-inject 注入块：含编码铁律/write-done/conventions/无 FFFD/执行者标识 | ✅ 7/7 PASS |
| butler.js 语法检查（node --check） | ✅ PASS |
| conventions.md 修复后：valid UTF-8、无 FFFD | ✅ PASS |
| inbox 乱码文件清零 | ✅ PASS（45 → 0） |
| 造乱码场景（python 写文件）→ 修复后 UTF-8 正常 | ✅ PASS |

## 四、遗留建议（非本任务范围）

1. **历史 diary 乱码**：agents/*/memory/diary.md 中约 20+ 个文件含历史 FFFD 残留（8-12 之前 GBK 写入产物）——新机制生效后不再新增；存量可让 learning-officer 决定是否清理
2. **bash 工具传参链路**：Git Bash → Windows python 的命令行中文传参损坏是工具层问题（MSYS2 转换），本机 pi 工具调用侧建议传参避免中文（或经文件传递）；butler spawn 的 node 子进程（UTF-16 原生）不受影响
3. **CNB/HK 远端**：Linux 默认 UTF-8，无此问题；但远端 python 写文件建议同样显式 encoding（防脚本被拷贝回 Windows 使用）
4. 规范更新入口固化：以后新增全局规则 → 写 conventions.md（详细）+ task-inject.md（速查），派发自动携带

## 五、产出物清单

- `org/scripts/write-done.js`（官方 DONE 工具，新增）
- `org/lib/knowledge-inject.js`（知识注入模块，新增）
- `org/knowledge/task-inject.md`（任务注入规范速查，新增）
- `org/knowledge/conventions.md`（尾部乱码修复 + 编码规范章节）
- `org/scripts/org-watchdog.ps1` / `security-phish-monitor.ps1` / `agents/system-ops/scripts/360-remediate-safe-mode.ps1`（-Encoding utf8）
- `agents/video-prod/project/generate_videos.py`（显式 encoding）
- `C:\Users\du_ji\AppData\Roaming\Python\Python314\site-packages\sitecustomize.py`（全局 UTF-8 强制）
- 用户环境变量：PYTHONUTF8=1 / PYTHONIOENCODING=utf-8
- `org/archived/mojibake-done-20260812/`（45 个乱码 DONE 归档）
- `butler.js`（dispatch 知识注入挂载，待重启生效）
