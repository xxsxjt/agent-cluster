# restart-butler-concurrency-routing.ps1 — concurrency-routing deploy: 重启 butler 加载并发限制 + 类型路由
# 背景：2026-08-11 concurrency-routing（任务并发限制 maxConcurrent + 类型路由 remote 降级链）
#   - config/butler.json maxConcurrent（默认 3）：本机同时最多 N 个任务，其余排队（waiting 表）
#   - route-auto.js + butler.js routeTask：remote 任务 CNB 优先 → HK → 本机兜底
#   - scanInbox 内嵌并发块（满额排队 + 紧急优先排序）——需重启 butler 才能加载
# 策略与 cpu-gate/auto-optimize 重启同款：先等待 active 任务收尾，再 kill 旧 butler + bootstrap start 拉起。
param(
    [int]$OldButlerPid = 0,
    [int]$TimeoutSec = 2400
)
$ErrorActionPreference = 'Continue'
$Root = 'C:\Users\du_ji\pi_workspace\org'
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$LogDir = Join-Path $Root 'logs'
$Log = Join-Path $LogDir 'butler-restart-concurrency-routing.log'
$ActiveTable = Join-Path $Root 'logs\active-tasks.json'
$PidFile = Join-Path $Root 'butler.pid'

function Log($m){ "$([DateTime]::Now.ToString('HH:mm:ss')) $m" | Tee-Object -FilePath $Log -Append }

if ($OldButlerPid -eq 0) {
    $raw = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
    $OldButlerPid = [int]$raw
}
Log "=== concurrency-routing deploy: current butler PID=${OldButlerPid}, waiting for active tasks ==="

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
Log "=== restart done. verify: node test/concurrency-routing.spec.js（15 用例）+ 投 5 任务观察并发排队 ==="
