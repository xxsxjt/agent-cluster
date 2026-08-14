# restart-butler-daily-meeting.ps1 - daily-meeting deploy: delayed restart butler to load new code
# Wait for active tasks (.DONE) then kill old butler and start fresh via bootstrap.
param(
    [int]$OldButlerPid = 35404,
    [int]$TimeoutSec = 1200
)
$ErrorActionPreference = 'Continue'
$Root = 'C:\Users\du_ji\pi_workspace\org'
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$LogDir = Join-Path $Root 'logs'
$Log = Join-Path $LogDir 'butler-restart-daily-meeting.log'
$WaitTasks = @(
    (Join-Path $Root 'inbox\daily-meeting.DONE'),
    (Join-Path $Root 'inbox\cnb-ctl-autostart.DONE'),
    (Join-Path $Root 'inbox\nextday-2026-08-09-sim-每日例会调度落地-184948.DONE')
)

function Log($m){ "$([DateTime]::Now.ToString('HH:mm:ss')) $m" | Tee-Object -FilePath $Log -Append }
Log "=== daily-meeting deploy: waiting for active tasks to finish ==="

$deadline = [DateTime]::Now.AddSeconds($TimeoutSec)
$allDone = $false
while ([DateTime]::Now -lt $deadline) {
    $allDone = $true
    foreach ($f in $WaitTasks) {
        if (-not (Test-Path $f)) { $allDone = $false; break }
    }
    if ($allDone) { Log "all active tasks .DONE, restarting butler" ; break }
    Start-Sleep -Seconds 15
}
if (-not $allDone) { Log "timeout ${TimeoutSec}s: active tasks not all done, restarting anyway (risk: may interrupt running tasks)" }

Log "kill old butler PID=${OldButlerPid}..."
taskkill /PID $OldButlerPid /T /F 2>&1 | Out-File -Append -FilePath $Log
Start-Sleep -Seconds 2

Log "bootstrap.js start butler..."
Start-Process -FilePath $NodeExe -ArgumentList (Join-Path $Root 'scripts\bootstrap.js'), 'start' `
    -WorkingDirectory $Root -WindowStyle Hidden -Wait | Out-Null
Start-Sleep -Seconds 3

$newPid = (Get-Content (Join-Path $Root 'butler.pid') -Raw -ErrorAction SilentlyContinue).Trim()
Log "new butler PID=$newPid"
Log "=== restart done, daily-meeting scheduler + interconnect/CNB fixes loaded ==="
