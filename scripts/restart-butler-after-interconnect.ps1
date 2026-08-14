# restart-butler-after-interconnect.ps1
# 互联模式收尾（interconnect-final）部署：延迟重启管家加载误杀修复
# 背景：但ler.js 的 agent_settled 误杀修复已写入，但运行中的但ler(旧代码)仍需重启生效。
#       本任务(interconnect-final)是但ler子进程；为不中断其收尾，采用延迟重启：
#       先等旧但ler多跑几轮(处理完本任务 .DONE 的通知/日记)，再 kill 旧但ler + bootstrap start。
param(
    [int]$OldButlerPid = 35404,
    [int]$WaitSec = 50
)
$ErrorActionPreference = 'Continue'
$Root = 'C:\Users\du_ji\pi_workspace\org'
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$Log = Join-Path $Root 'logs\butler-restart-interconnect.log'

function Log($m){ "$([DateTime]::Now.ToString('HH:mm:ss')) $m" | Tee-Object -FilePath $Log -Append }

Log "=== interconnect 后但ler延迟重启：等待 ${WaitSec}s（让旧但ler处理完本任务 .DONE 收尾）==="
Start-Sleep -Seconds $WaitSec

# 只杀指定旧但ler（单实例锁防误杀）
Log "kill 旧但ler PID=${OldButlerPid}..."
taskkill /PID $OldButlerPid /T /F 2>&1 | Out-File -Append -FilePath $Log
Start-Sleep -Seconds 2

# bootstrap start 重启（幂等 + 单实例锁 + watchdog 同款）
Log "bootstrap.js start 重启但ler..."
Start-Process -FilePath $NodeExe -ArgumentList (Join-Path $Root 'scripts\bootstrap.js'), 'start' `
    -WorkingDirectory $Root -WindowStyle Hidden -Wait | Out-Null
Start-Sleep -Seconds 3

$newPid = (Get-Content (Join-Path $Root 'butler.pid') -Raw -ErrorAction SilentlyContinue).Trim()
Log "新但ler PID=$newPid"
Log "=== 重启完成，误杀修复已加载 ==="
