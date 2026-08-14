# org-watchdog.ps1 - 智能体集群（Agent Cluster）管家守护 v2
# 职责：每 10 分钟检查 org/butler.js 管家（及 web/server.js 控制台）是否正常运行，
#       挂了自动重启 + 写日志。
#
# v2 关键修复（2026-08-08 02:37）：
#   - 弃用 CIM 命令行匹配作为主判定 —— 实测在 schtasks 计划任务 S4U 环境下
#     Get-CimInstance 返回空，导致管家一直健康却每 10 分钟误判"未运行"空转重启。
#     （hub 旧 watchdog.ps1 v3 注释早已警告此坑，v1 重蹈覆辙。）
#   - 改用 pidfile + tasklist 双确认（与 bootstrap.js isAlive 完全一致）：
#       1) 读 butler.pid，tasklist /FI "PID eq <pid>" 确认该 PID 是存活 node.exe
#       2) PID 存活则判定管家运行正常，绝不重启（防误杀）
#       3) pidfile 缺失/PID 不在 → 判定未运行 → 调用 bootstrap 重启
#   - pidfile 异常丢失但进程仍在跑时，用 CIM 尽力兜底一次（交互会话下 CIM 可用），
#     避免"pidfile 丢失 + 进程存活"时误重启；CIM 失败/为空 → 保守视为未运行（宁重启不挂管家）。
#
# 防误杀：仅通过 bootstrap.js 重启（其自带 pidfile 幂等 + butler.js 单实例锁），
#         绝不直接 taskkill 任何进程，绝不匹配 pi 主进程。
#
# 幂等：管家/web 正常运行则静默；挂了才调 bootstrap（bootstrap 自身幂等，防重复拉起）。
# schtasks 触发：pi-org-watchdog（每 10 分钟）。

param(
    [string]$Root = 'C:\Users\du_ji\pi_workspace\org'
)

$NodeExe  = 'C:\Program Files\nodejs\node.exe'
$LogDir   = Join-Path $Root 'logs'
$WatchdogLog = Join-Path $LogDir 'watchdog.log'

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-Wd($msg) {
    $line = "[watchdog $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Add-Content -Path $WatchdogLog -Value $line -Encoding utf8 -ErrorAction SilentlyContinue
}

# 判定指定 PID 是否为存活的 node.exe 进程（tasklist 精确匹配 PID，bootstrap isAlive 同款）
function Test-PidIsNode([string]$pidFile) {
    if (-not (Test-Path $pidFile)) { return $false }
    try {
        $pidStr = (Get-Content $pidFile -Raw -ErrorAction Stop).Trim()
        if (-not $pidStr -or $pidStr -notmatch '^\d+$') { return $false }
        $out = tasklist /FI "PID eq $pidStr" /FO CSV /NH 2>$null
        # tasklist 输出形如 "node.exe","21976","Console","1","153,208 K"
        # 避免引号拼接：分别检查是否含 node.exe 字样且包含该 PID
        $hasNode = ($out -match 'node\.exe')
        $hasPid  = ($out -match $pidStr)
        return [bool]($hasNode -and $hasPid)
    } catch { return $false }
}

# CIM 兜底：尽力检测是否有进程命令行匹配脚本（仅在 pidfile 缺失时调用；S4U 下可能返回空）
function Test-CimScriptRunning([string]$matchStr) {
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
        return [bool]($procs | Where-Object { $_.CommandLine -match $matchStr })
    } catch { return $false }
}

# 判定指定服务是否运行：主判据 = pidfile + tasklist；pidfile 缺失时 CIM 兜底
function Test-ServiceRunning([string]$pidFile, [string]$matchStr) {
    if (Test-PidIsNode $pidFile) { return $true }        # pidfile 精确命中 → 运行中
    # pidfile 缺失或 PID 不存活：用 CIM 兜底，防 pidfile 异常丢失但进程仍在时误重启
    return (Test-CimScriptRunning $matchStr)
}

# web 判定：端口监听探测（比 pidfile 更可靠，避免 pidfile 失联时反复 spawn 造成端口堆积）
function Test-WebRunning([int]$port = 8787) {
    $listen = netstat -ano 2>$null | Select-String ":$port\s" | Select-String "LISTENING"
    return [bool]$listen
}

# 通用重启：调用 bootstrap.js 子命令（单点管理 + 幂等防重复）
function Restart-Service([string]$subCmd, [string]$label) {
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $restartLog = Join-Path $LogDir "watchdog-restart-$ts.log"
    $errLog     = $restartLog -replace '\.log$', '-err.log'
    try {
        Start-Process -FilePath $NodeExe `
            -ArgumentList (Join-Path $Root "scripts\bootstrap.js"), $subCmd `
            -WorkingDirectory $Root -WindowStyle Hidden -Wait `
            -RedirectStandardOutput $restartLog -RedirectStandardError $errLog `
            -ErrorAction SilentlyContinue
        Write-Wd "$label 检测失败，已通过 bootstrap.js $subCmd 尝试重启 (详见 $restartLog)"
    } catch {
        Write-Wd "$label 重启失败: $($_.Exception.Message)"
    }
}

# ── 管家 butler.js 保活（主目标）──
if (-not (Test-ServiceRunning (Join-Path $Root 'butler.pid') 'butler\.js')) {
    Write-Wd 'butler.js 未在运行，执行自动重启'
    Restart-Service 'start' 'butler.js'
}
# 正常运行：静默（不写日志，避免噪音）

# ── web 控制台 server.js 保活（增强项，端口监听探测：8787 有 LISTENING 即视为运行中）──
if (-not (Test-WebRunning 8787)) {
    Write-Wd 'web/server.js 未在监听 8787，执行自动重启'
    Restart-Service 'web start' 'web/server.js'
}
# 正常运行：静默

# ── cloudflared 本机隧道保活（容灾穿透，remote.xxssxx.top -> 127.0.0.1:8787）──
# 判定：cloudflared-local.pid 对应进程存活（进程名 cloudflared-windows-amd64）；挂了调脚本重启。
# 注意：本机 IPv6 不通，隧道必须强制 --edge-ip-version 4 --protocol http2（见 disaster-recovery 任务）。
$CFDPidFile = Join-Path $Root 'cloudflared-local.pid'
$cfdRunning = $false
if (Test-Path $CFDPidFile) {
    $cfdPid = (Get-Content $CFDPidFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($cfdPid -match '^\d+$') {
        $cfdRunning = [bool](tasklist /FI "PID eq $cfdPid" /NH 2>$null | Select-String 'cloudflared')
    }
}
if (-not $cfdRunning) {
    Write-Wd 'cloudflared 本机隧道未在运行，执行自动重启'
    try {
        Start-Process -FilePath 'powershell' `
            -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $Root 'scripts\cloudflared-local.ps1'),'-Daemon' `
            -WindowStyle Hidden -ErrorAction Stop | Out-Null
        Write-Wd 'cloudflared-local 已触发重启'
    } catch {
        Write-Wd "cloudflared 重启失败: $($_.Exception.Message)"
    }
}
# 正常运行：静默
