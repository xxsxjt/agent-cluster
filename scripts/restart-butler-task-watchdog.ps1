# restart-butler-task-watchdog.ps1 - task-watchdog deploy: delayed restart butler to load watchdog code
# Waits until active-tasks.json is empty (all active tasks reached .DONE / finished) then
# kills old butler (tree) and starts fresh via bootstrap. Avoids re-dispatch of running tasks.
param(
    [int]$TimeoutSec = 3600
)
$ErrorActionPreference = 'Continue'
$Root = 'C:\Users\du_ji\pi_workspace\org'
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$LogDir = Join-Path $Root 'logs'
$Log = Join-Path $LogDir 'butler-restart-task-watchdog.log'
$ActiveJson = Join-Path $Root 'logs\active-tasks.json'
$PidFile = Join-Path $Root 'butler.pid'

function Log($m){ "$([DateTime]::Now.ToString('HH:mm:ss')) $m" | Tee-Object -FilePath $Log -Append }
Log "=== task-watchdog deploy: waiting for active tasks to finish ==="

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
Log "=== restart done, task-watchdog (lib/task-watchdog.js) loaded ==="
