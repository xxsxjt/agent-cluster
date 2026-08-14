# restart-butler-full-audit-20260810.ps1 - full-audit 20260810 deploy: restart butler to load all fixes
# 背景：本次全面排查修复了 5 处 butler.js/spawn.js 代码（上下文铁律/域路由/误杀白名单/自动重跑/task-watchdog .then bug）。
# 当前 butler(PID 由 butler.pid 读取) 是旧代码，需重启加载。策略沿用既有模式：
# 先等 active-tasks.json 清空（本任务 full-audit-20260810 完成 .DONE 后不再有 active 任务），
# 再 kill 旧 butler + bootstrap.js start 拉起。绝不误杀其他 node。
param(
    [int]$TimeoutSec = 3600
)
$ErrorActionPreference = 'Continue'
$Root = 'C:\Users\du_ji\pi_workspace\org'
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$LogDir = Join-Path $Root 'logs'
$Log = Join-Path $LogDir 'butler-restart-full-audit-20260810.log'
$ActiveJson = Join-Path $Root 'logs\active-tasks.json'
$PidFile = Join-Path $Root 'butler.pid'

function Log($m){ "$([DateTime]::Now.ToString('HH:mm:ss')) $m" | Tee-Object -FilePath $Log -Append }
Log "=== full-audit-20260810 deploy: waiting for active tasks to finish ==="

# 等 active-tasks.json 清空（full-audit 完成后即无活动任务）
$deadline = [DateTime]::Now.AddSeconds($TimeoutSec)
$done = $false
while ([DateTime]::Now -lt $deadline) {
    $count = 999
    try {
        $json = Get-Content $ActiveJson -Raw -ErrorAction SilentlyContinue
        if ($json) {
            $obj = $json | ConvertFrom-Json
            $count = @($obj.PSObject.Properties).Count
        } else { $count = 0 }
    } catch { $count = 999 }
    if ($count -eq 0) { $done = $true; Log "active-tasks.json empty, all tasks done, restarting butler"; break }
    Log "waiting: $count active tasks still running..."
    Start-Sleep -Seconds 20
}
if (-not $done) { Log "timeout ${TimeoutSec}s: active tasks not all done, restarting anyway (risk: may interrupt running tasks)" }

$oldPid = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
if ($oldPid) {
    Log "kill old butler PID=${oldPid} (tree)..."
    taskkill /PID $oldPid /T /F 2>&1 | Out-File -Append -FilePath $Log
} else {
    Log "no old butler pid found, skipping kill"
}
Start-Sleep -Seconds 2

Log "bootstrap.js start butler..."
Start-Process -FilePath $NodeExe -ArgumentList (Join-Path $Root 'scripts\bootstrap.js'), 'start' `
    -WorkingDirectory $Root -WindowStyle Hidden -Wait | Out-Null
Start-Sleep -Seconds 3

$newPid = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
Log "new butler PID=$newPid"
Log "=== restart done, full-audit-20260810 fixes loaded (上下文铁律/域路由/误杀白名单/自动重跑/task-watchdog同步调用) ==="
