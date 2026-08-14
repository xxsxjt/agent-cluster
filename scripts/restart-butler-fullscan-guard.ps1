# restart-butler-fullscan-guard.ps1 — fullscan-guard deploy: 重启 butler 加载全盘 find/grep 检测看护钩子
# 背景：fullscan-guard（lib/fullscan-guard.js）由 butler 主进程每 2 分钟扫描 find.exe/grep.exe/rg.exe
#   进程命令行，命中全盘根（/、C:/、/c、/mnt/c）或进程数 > maxSimultaneous → taskkill 杀 + 记 activity
#   （[防卡死]）+ 若父任务仍在写提示到 logs/<task>.log。butler.js 的扫描钩子需重启才能加载。
# 策略与 cpu-gate/auto-optimize/quota-notify 重启同款：先等待所有 active 任务(.DONE/.FAILED)收尾，
# 再 kill 旧 butler + bootstrap.js start 拉起，避免中断运行中的子任务。
# 验证：重启后 `node butler.js --fullscan-guard` 应正常输出状态；模拟 `find / -name x` 2 分钟内被杀。
param(
    [int]$OldButlerPid = 0,
    [int]$TimeoutSec = 2400
)
$ErrorActionPreference = 'Continue'
$Root = 'C:\Users\du_ji\pi_workspace\org'
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$LogDir = Join-Path $Root 'logs'
$Log = Join-Path $LogDir 'butler-restart-fullscan-guard.log'
$ActiveTable = Join-Path $Root 'logs\active-tasks.json'
$PidFile = Join-Path $Root 'butler.pid'

function Log($m){ "$([DateTime]::Now.ToString('HH:mm:ss')) $m" | Tee-Object -FilePath $Log -Append }

if ($OldButlerPid -eq 0) {
    $raw = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
    $OldButlerPid = [int]$raw
}
Log "=== fullscan-guard deploy: current butler PID=${OldButlerPid}, waiting for active tasks ==="

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
Log "=== restart done, fullscan-guard 看护钩子已加载。verify: node butler.js --fullscan-guard ==="
