# cloudflared-local.ps1 — 本机 xxsx-local 隧道运行脚本（容灾穿透）
#
# 功能：从 DPAPI 加密仓库读取 cf_tunnel_local_token（不落盘明文），
#       用 --token 方式运行 cloudflared 隧道（强制 IPv4 + http2，
#       本机 IPv6 不通，见 disaster-recovery 任务踩坑）。
# 隧道：xxsx-local (dabb3758-6d69-4925-8c61-79421530e2cb)
# 暴露：remote.xxssxx.top -> http://127.0.0.1:8787 (本机 org web)
#
# 用法：
#   powershell -File cloudflared-local.ps1 -Daemon  # 后台运行（默认，脱离终端，写 pidfile）
#   powershell -File cloudflared-local.ps1 -Stop    # 停止后台隧道
#   powershell -File cloudflared-local.ps1          # 前台运行（阻塞，调试用）
param(
    [switch]$Daemon,
    [switch]$Stop
)
$ErrorActionPreference = 'Stop'

$CFD     = 'C:\Users\du_ji\pi_workspace\org\agents\night-worker\tools\cloudflared-windows-amd64.exe'
$SETCRED = 'C:\_dx\_serve\set-cred.ps1'
$LOG     = 'C:\Users\du_ji\pi_workspace\org\logs\cloudflared-local.log'
$PIDFILE = 'C:\Users\du_ji\pi_workspace\org\cloudflared-local.pid'

function Get-RunningPid {
    if (-not (Test-Path $PIDFILE)) { return $null }
    $pidStr = (Get-Content $PIDFILE -Raw -ErrorAction SilentlyContinue).Trim()
    if ($pidStr -notmatch '^\d+$') { return $null }
    $alive = tasklist /FI "PID eq $pidStr" /NH 2>$null | Select-String 'cloudflared'
    if ($alive) { return [int]$pidStr }
    return $null
}

# 停止
if ($Stop) {
    $p = Get-RunningPid
    if ($p) {
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
        Write-Output "cloudflared-local stopped (PID $p)"
    } else {
        Write-Output 'cloudflared-local not running'
    }
    if (Test-Path $PIDFILE) { Remove-Item $PIDFILE -Force -ErrorAction SilentlyContinue }
    exit 0
}

# 已运行则退出（幂等）
if (Get-RunningPid) {
    Write-Output "cloudflared-local already running (PID $(Get-RunningPid))"
    exit 0
}

# 读 token（加密仓库）
$token = & $SETCRED -Get -Name cf_tunnel_local_token
if (-not $token) { throw 'cf_tunnel_local_token not found in encrypted store' }

if ($Daemon) {
    # 后台启动 exe；PID 由本脚本写入 pidfile（cloudflared 的 --pidfile 属顶层 flag，run 子命令不支持）
    $p = Start-Process -FilePath $CFD `
        -ArgumentList 'tunnel','--edge-ip-version','4','run','--token', $token, '--protocol','http2' `
        -WindowStyle Hidden `
        -RedirectStandardOutput $LOG -RedirectStandardError "$LOG.err" -PassThru
    Set-Content -Path $PIDFILE -Value $p.Id -Encoding ascii
    Write-Output "cloudflared-local started (PID $($p.Id))"
    exit 0
}

# 前台运行（调试）
& $CFD tunnel --edge-ip-version 4 run --token $token --protocol http2
