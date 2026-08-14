# window-popup-audit.ps1 - 弹窗/退役组件自动化巡检（2026-08-13 server-admin）
# 巡检三类问题：
#   1) 新计划任务缺隐藏窗口（powershell 无 -WindowStyle Hidden / cmd|node|python 直跑）
#   2) 退役组件残留（Disabled 的 org-*/pi-* 任务对应进程还在跑）
#   3) 弹窗检测（node/powershell/cmd/python 进程带可见主窗口 / 孤儿 conhost）
# 异常 -> org\logs\window-popup-alert.jsonl（UTF-8 无 BOM）+ org\inbox\window-popup-alert.md
#        （butler 扫描 inbox 自动派发给 server-admin 处理；无异常时清除告警文件防重复）
# 调度：计划任务 pi-popup-audit 每 30 分钟（wscript 隐藏包装）

$ErrorActionPreference = 'SilentlyContinue'
$ORG = 'C:\Users\du_ji\pi_workspace\org'
$LOG = Join-Path $ORG 'logs\window-popup-alert.jsonl'
$ALERT = Join-Path $ORG 'inbox\window-popup-alert.md'
$STAMP = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$utf8 = New-Object System.Text.UTF8Encoding $false
$alerts = New-Object System.Collections.ArrayList

# ── 检查 1：计划任务 Hidden 校验（org-/pi- 自有任务，排除 Disabled；2026-08-13 收敛范围防第三方根任务误报）──
$tasks = Get-ScheduledTask | Where-Object { $_.TaskName -match '^(org|pi)-' -and $_.State -ne 'Disabled' }
foreach ($t in $tasks) {
    $act = @($t.Actions)[0]
    if (-not $act) { continue }
    $exe = [string]$act.Execute
    $args = [string]$act.Arguments
    $bad = $false; $reason = ''
    if ($exe -match 'powershell\.exe') {
        if ($args -notmatch 'WindowStyle\s+Hidden') { $bad = $true; $reason = 'powershell 动作缺 -WindowStyle Hidden' }
    } elseif ($exe -match 'cmd\.exe') {
        $bad = $true; $reason = 'cmd.exe 直跑（需 wscript/vbs 隐藏包装）'
    } elseif ($exe -match 'node\.exe|python\.exe') {
        $bad = $true; $reason = "$exe 直跑脚本（需 wscript/vbs 隐藏包装）"
    }
    if ($bad) {
        [void]$alerts.Add([pscustomobject]@{ Type = 'new-task-no-hidden'; Task = $t.TaskName; Exe = $exe; Args = $args; Reason = $reason })
    }
}

# ── 检查 2：退役组件残留（Disabled 的 org-*/pi-* 任务 vs 进程）──
$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node\.exe|python|powershell|cmd\.exe|wscript|wsl' }
$disabled = Get-ScheduledTask | Where-Object { $_.TaskPath -eq '\' -and $_.State -eq 'Disabled' -and $_.TaskName -match '^(org|pi)-' }
foreach ($d in $disabled) {
    $act = @($d.Actions)[0]
    $argStr = if ($act) { [string]$act.Arguments } else { '' }
    # 特征：Arguments 中的文件路径（X:\...\x.js|.py|.ps1）或任务名关键词
    $feat = ''
    if ($argStr -match '[A-Za-z]:\\[^"]+?\.(js|py|ps1|vbs)') { $feat = $Matches[0] }
    if (-not $feat -and $d.TaskName -match 'cnb-keepalive') { $feat = 'cnb-keepalive' }
    if (-not $feat -and $d.TaskName -match 'hub') { $feat = 'pi_workspace\hub' }
    if (-not $feat -and $d.TaskName -match 'omniroute') { $feat = 'omniroute' }
    if ($feat) {
        $hit = $procs | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($feat, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
        if ($hit) {
            foreach ($h in $hit) {
                [void]$alerts.Add([pscustomobject]@{ Type = 'retired-component-running'; Task = $d.TaskName; Pid = $h.ProcessId; Cmd = [string]$h.CommandLine })
            }
        }
    }
}

# ── 检查 3：可见窗口控制台进程 + 孤儿 conhost ──
$withWin = Get-Process | Where-Object { $_.MainWindowTitle }
$visPids = @($withWin | ForEach-Object { $_.Id })
$allPids = @(Get-Process | ForEach-Object { $_.Id })
$consoles = Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='powershell.exe' or Name='cmd.exe' or Name='python.exe' or Name='pythonw.exe'"
foreach ($c in $consoles) {
    if ($visPids -contains [int]$c.ProcessId) {
        $cl = [string]$c.CommandLine
        # 2026-08-13 白名单：只报含自动化脚本特征的可见窗口（用户自己开的终端/IDE 不算弹窗）
        if ($cl -match 'pi_workspace|org[\\/]scripts|org[\\/]butler|hub[\\/]|keepalive|watchdog|\.vbs') {
            [void]$alerts.Add([pscustomobject]@{ Type = 'visible-console-window'; Pid = $c.ProcessId; Name = $c.Name; Cmd = $cl })
        }
    }
}
# 孤儿 conhost：父进程已不存在
$conhosts = Get-CimInstance Win32_Process -Filter "Name='conhost.exe'"
foreach ($ch in $conhosts) {
    if ($allPids -notcontains [int]$ch.ParentProcessId) {
        [void]$alerts.Add([pscustomobject]@{ Type = 'orphan-conhost'; Pid = $ch.ProcessId; Parent = $ch.ParentProcessId })
    }
}

# ── 去重（2026-08-13 增强）：同类型+主体 4h 冷却，防持续异常每 30 分钟派活刷屏 ──
# 2026-08-13 修复：orphan-conhost 每次 PID 都不同（瞬时孤儿自然消失），按 PID 去重永不命中→每 30 分钟刷屏派活。
# 改为 orphan-conhost 用全局 key（每 4h 最多一次），其余类型保留 PID 精度（退役组件/可见窗口按具体进程去重）。
$STATE = Join-Path $ORG 'agents\server-admin\state\popup-audit-state.json'
$st = @{}
if (Test-Path $STATE) { try { $st = Get-Content $STATE -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable } catch { $st = @{} } }
$nowT = Get-Date
$fresh = New-Object System.Collections.ArrayList
foreach ($a in $alerts) {
    $key = $a.Type + '|' + ($a.Task -as [string]) + '|' + ($a.Name -as [string])
    if ($a.Type -ne 'orphan-conhost') { $key += '|' + ($a.Pid -as [string]) }
    $last = $null
    if ($st.ContainsKey($key)) { $last = $st[$key] }
    if (-not $last -or ((Get-Date) - (Get-Date $last)).TotalHours -ge 4) {
        [void]$fresh.Add($a)
        $st[$key] = (Get-Date).ToString('o')
    }
}
$stJson = $st | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText($STATE, $stJson, (New-Object System.Text.UTF8Encoding $false))
$alerts = $fresh

# ── 输出：异常写告警任务（butler 自动派发），无异常清标记 ──
if ($alerts.Count -eq 0) {
    if (Test-Path $ALERT) { Remove-Item $ALERT -Force }
} else {
    $json = $alerts | ConvertTo-Json -Depth 3
    $line = '{"ts":"' + $STAMP + '","count":' + $alerts.Count + ',"alerts":' + $json + '}'
    [System.IO.File]::AppendAllText($LOG, $line + [Environment]::NewLine, $utf8)
    $body = @"
agent: server-admin
provider: opencode-go
model: deepseek-v4-flash
side: local
priority: medium

# 弹窗/退役巡检告警（$STAMP）

$json
"@
    [System.IO.File]::WriteAllText($ALERT, $body, $utf8)
}
Write-Output ("popup-audit done: " + $alerts.Count + " alert(s)")
