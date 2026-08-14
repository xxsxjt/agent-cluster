# restart-butler-orphan-cleanup.ps1 — orphan-cleanup deploy: 重启 butler 加载统一收尾 + 孤儿清扫
# 背景：orphan-cleanup（2026-08-11）在 butler.js 加了三件事——
#   ① finalizeTask 统一收尾（杀子进程+删 PID 文件+移出 active，全部终态路径）
#   ② 启动时 sweepOrphans 扫 inbox/*.PID（清历史残留孤儿进程 + 漏删 PID）
#   ③ 每 30 分钟定期 sweepOrphans（防运行期积累）
# 需重启 butler 才能加载。策略同 cpu-gate/auto-optimize 重启：先等所有 active 任务收尾，
# 再 kill 旧 butler + bootstrap.js start 拉起，避免中断运行中的子任务。
# ⚠️ 重启后新 butler 的启动清扫会强杀 inbox/*.PID 中「不在 active」的残留孤儿进程
#     （含先前积累的历史孤儿 RPC 进程）→ 这是预期行为，会释放被占内存。
param(
    [int]$OldButlerPid = 0,
    [int]$TimeoutSec = 2400
)
$ErrorActionPreference = 'Continue'
$Root = 'C:\Users\du_ji\pi_workspace\org'
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$LogDir = Join-Path $Root 'logs'
$Log = Join-Path $LogDir 'butler-restart-orphan-cleanup.log'
$ActiveTable = Join-Path $Root 'logs\active-tasks.json'
$PidFile = Join-Path $Root 'butler.pid'

function Log($m){ "$([DateTime]::Now.ToString('HH:mm:ss')) $m" | Tee-Object -FilePath $Log -Append }

if ($OldButlerPid -eq 0) {
    $raw = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
    $OldButlerPid = [int]$raw
}
Log "=== orphan-cleanup deploy: current butler PID=${OldButlerPid}, waiting for active tasks ==="

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

# 重启前记录残留 PID 文件数（供对比验证：重启后被启动清扫清空）
$beforePids = @(Get-ChildItem (Join-Path $Root 'inbox\*.PID') -ErrorAction SilentlyContinue).Count
Log "before restart: inbox/*.PID = $beforePids"

Log "kill old butler PID=${OldButlerPid}..."
taskkill /PID $OldButlerPid /T /F 2>&1 | Out-File -Append -FilePath $Log
Start-Sleep -Seconds 2

Log "bootstrap.js start butler..."
Start-Process -FilePath $NodeExe -ArgumentList (Join-Path $Root 'scripts\bootstrap.js'), 'start' `
    -WorkingDirectory $Root -WindowStyle Hidden -Wait | Out-Null
Start-Sleep -Seconds 5

$newPid = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
Log "new butler PID=$newPid"
Start-Sleep -Seconds 3
$afterPids = @(Get-ChildItem (Join-Path $Root 'inbox\*.PID') -ErrorAction SilentlyContinue).Count
Log "after restart: inbox/*.PID = $afterPids（启动清扫应清空历史残留 → 仅剩当前在跑任务）"
Log "=== restart done, finalizeTask+sweepOrphans loaded ==="
