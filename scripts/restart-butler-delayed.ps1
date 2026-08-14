# restart-butler-delayed.ps1 — notify-tier 部署：延迟重启管家加载新代码
# 背景：notify-tier 任务自身是 butler 的子进程，直接 kill 会中断任务。
# 策略：先 sleep 等待任务完全退出，再 kill 旧 butler(PID 37604) + bootstrap.js start 拉起（watchdog 同款）。
param(
    [int]$WaitSec = 12,
    [int]$OldPid = 37604
)
$Root = 'C:\Users\du_ji\pi_workspace\org'
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$LogDir = Join-Path $Root 'logs'
$Log = Join-Path $LogDir 'butler-restart-notify-tier.log'

"[$((Get-Date -Format 'HH:mm:ss'))] 等待 ${WaitSec}s（让 notify-tier 任务完全退出）..." | Tee-Object -FilePath $Log
Start-Sleep -Seconds $WaitSec

# 只杀指定的旧 butler（单实例锁防误杀，绝不碰其他 node）
taskkill /PID $OldPid /T /F 2>&1 | Out-File -Append -FilePath $Log
Start-Sleep -Seconds 2

# 经 bootstrap start 重启（幂等 + 单实例锁 + watchdog 同款）
"[$((Get-Date -Format 'HH:mm:ss'))] bootstrap.js start 重启管家..." | Tee-Object -Append -FilePath $Log
Start-Process -FilePath $NodeExe -ArgumentList (Join-Path $Root 'scripts\bootstrap.js'), 'start' `
    -WorkingDirectory $Root -WindowStyle Hidden -Wait | Out-Null
Start-Sleep -Seconds 3

# 确认新管家 pid
$newPid = (Get-Content (Join-Path $Root 'butler.pid') -Raw -ErrorAction SilentlyContinue).Trim()
"[$((Get-Date -Format 'HH:mm:ss'))] 新管家 PID=$newPid" | Tee-Object -Append -FilePath $Log
