# restart-butler-auto-optimize.ps1 — auto-optimize deploy: delayed restart butler to load the failure-optimization hook
# 背景：auto-optimize（lib/auto-optimize.js）是 butler 失败处理增强——需重启 butler 才能加载
#   autoRerunTask 内嵌的优化钩子 + 主循环的 auto-optimize 定时器。
# 策略与 auto-schedule/daily-meeting 重启同款：先等待所有 active 任务(.DONE/.FAILED)收尾，
# 再 kill 旧 butler + bootstrap.js start 拉起，避免中断运行中的子任务。
param(
    [int]$OldButlerPid = 27316,
    [int]$TimeoutSec = 2400
)
$ErrorActionPreference = 'Continue'
$Root = 'C:\Users\du_ji\pi_workspace\org'
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$LogDir = Join-Path $Root 'logs'
$Log = Join-Path $LogDir 'butler-restart-auto-optimize.log'
$ActiveTable = Join-Path $Root 'logs\active-tasks.json'

function Log($m){ "$([DateTime]::Now.ToString('HH:mm:ss')) $m" | Tee-Object -FilePath $Log -Append }
Log "=== auto-optimize deploy: waiting for active tasks to finish ==="

$snapshot = @()
try { $snapshot = (Get-Content $ActiveTable -Raw -ErrorAction Stop | ConvertFrom-Json).PSObject.Properties.Name } catch { $snapshot = @() }
Log "snapshot active tasks: $($snapshot -join ', ')"

$deadline = [DateTime]::Now.AddSeconds($TimeoutSec)
$allDone = $false
while ([DateTime]::Now -lt $deadline) {
    $allDone = $true
    foreach ($name in $snapshot) {
        $done = Join-Path $Root ("inbox\" + $name + ".DONE")
        if (-not (Test-Path $done)) { $allDone = $false; break }
    }
    if ($allDone) { Log "all active tasks .DONE, restarting butler"; break }
    Start-Sleep -Seconds 20
}
if (-not $allDone) { Log "timeout ${TimeoutSec}s: not all active tasks done, restarting anyway (risk: may interrupt running tasks)" }

Log "kill old butler PID=${OldButlerPid}..."
taskkill /PID $OldButlerPid /T /F 2>&1 | Out-File -Append -FilePath $Log
Start-Sleep -Seconds 2

Log "bootstrap.js start butler..."
Start-Process -FilePath $NodeExe -ArgumentList (Join-Path $Root 'scripts\bootstrap.js'), 'start' `
    -WorkingDirectory $Root -WindowStyle Hidden -Wait | Out-Null
Start-Sleep -Seconds 3

$newPid = (Get-Content (Join-Path $Root 'butler.pid') -Raw -ErrorAction SilentlyContinue).Trim()
Log "new butler PID=$newPid"
Log "=== restart done, auto-optimize failure-optimization hook loaded ==="
