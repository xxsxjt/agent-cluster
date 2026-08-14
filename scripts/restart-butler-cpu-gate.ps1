# restart-butler-cpu-gate.ps1 — cpu-gate deploy: 重启 butler 加载 CPU 负载门禁钩子
# 背景：cpu-gate（lib/cpu-gate.js）是 butler 派发前的负载门禁——需重启 butler 才能加载
#   scanInbox 内嵌的门禁块（构建任务高负载暂缓 / 暂缓超限转 CNB）+ --cpu-gate CLI。
# 策略与 auto-optimize/auto-schedule 重启同款：先等待所有 active 任务(.DONE/.FAILED)收尾，
# 再 kill 旧 butler + bootstrap.js start 拉起，避免中断运行中的子任务。
param(
    [int]$OldButlerPid = 0,
    [int]$TimeoutSec = 2400
)
$ErrorActionPreference = 'Continue'
$Root = 'C:\Users\du_ji\pi_workspace\org'
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$LogDir = Join-Path $Root 'logs'
$Log = Join-Path $LogDir 'butler-restart-cpu-gate.log'
$ActiveTable = Join-Path $Root 'logs\active-tasks.json'
$PidFile = Join-Path $Root 'butler.pid'

function Log($m){ "$([DateTime]::Now.ToString('HH:mm:ss')) $m" | Tee-Object -FilePath $Log -Append }

if ($OldButlerPid -eq 0) {
    $raw = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
    $OldButlerPid = [int]$raw
}
Log "=== cpu-gate deploy: current butler PID=${OldButlerPid}, waiting for active tasks ==="

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

$newPid = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
Log "new butler PID=$newPid"
Log "=== restart done, cpu-gate load gate hook loaded. verify: node butler.js --cpu-gate ==="
