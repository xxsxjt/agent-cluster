# cnb-keepalive-local.ps1 — CNB 空间保活守护（开机自启，脱离终端）
# 由计划任务 org-cnb-keepalive 触发；幂等：已运行则退出。
$ErrorActionPreference = 'Stop'
$ORG = 'C:\Users\du_ji\pi_workspace\org'
$PIDFILE = "$ORG\cnb-keepalive-local.pid"

function Get-RunningPid {
    if (-not (Test-Path $PIDFILE)) { return $null }
    $pidStr = (Get-Content $PIDFILE -Raw -ErrorAction SilentlyContinue).Trim()
    if ($pidStr -notmatch '^\d+$') { return $null }
    $alive = Get-CimInstance Win32_Process -Filter "ProcessId=$pidStr" -ErrorAction SilentlyContinue
    if ($alive -and $alive.CommandLine -like '*cnb-keepalive.js*') { return [int]$pidStr }
    return $null
}

if (Get-RunningPid) {
    Write-Output "cnb-keepalive already running (PID $(Get-RunningPid))"
    exit 0
}

$node = (Get-Command node).Source
$p = Start-Process -FilePath $node -ArgumentList "$ORG\scripts\cnb-keepalive.js", '--loop' `
    -WorkingDirectory $ORG -WindowStyle Hidden -PassThru
Set-Content -Path $PIDFILE -Value $p.Id -Encoding ascii
Write-Output "cnb-keepalive started (PID $($p.Id))"
