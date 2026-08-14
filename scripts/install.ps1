# XuWu (虚无) Framework Installer for Windows
# 用法:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall
#
# 依赖: Node.js >= 18 (检查自动跳过)
param(
    [switch]$Uninstall,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Bootstrap = Join-Path $RepoRoot "scripts\bootstrap.js"

function Write-Step([string]$msg) {
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Test-NodeInstalled {
    try {
        $v = (node --version 2>$null)
        if (-not $v) { return $false }
        $ver = [version]$v.TrimStart('v')
        return $ver -ge [version]"18.0.0"
    } catch { return $false }
}

function Get-BootstrapResult([string]$cmd) {
    $out = & node $Bootstrap $cmd 2>&1
    return ($out -join "`n")
}

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor DarkGray
Write-Host "  ║    XuWu (虚无) — 智能体组织树框架        ║" -ForegroundColor Cyan
Write-Host "  ║    AGPL-3.0 · 一次安装，开机即用          ║" -ForegroundColor DarkGray
Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor DarkGray
Write-Host ""

if ($Uninstall) {
    Write-Step "卸载中..."
    Get-BootstrapResult "uninstall" | ForEach-Object { Write-Host "  $_" }
    Write-Host ""
    Write-Host "✅ 卸载完成" -ForegroundColor Green
    exit 0
}

# 1. 环境检查
Write-Step "检查环境..."
if (-not (Test-NodeInstalled)) {
    Write-Host "  ❌ 需要 Node.js >= 18，请先安装: https://nodejs.org" -ForegroundColor Red
    exit 1
}
$nodeVer = node --version
Write-Host "  ✅ Node.js $nodeVer"

# 2. 目录检查
Write-Step "检查目录..."
if (-not (Test-Path $Bootstrap)) {
    Write-Host "  ❌ 找不到 scripts/bootstrap.js" -ForegroundColor Red
    exit 1
}
Write-Host "  ✅ 仓库结构完整"

# 3. 注册自启
Write-Step "注册开机自启..."
Get-BootstrapResult "install" | ForEach-Object { Write-Host "  $_" }

# 4. 启动管家
Write-Step "启动管家..."
$status = Get-BootstrapResult "start"
$status | ForEach-Object { Write-Host "  $_" }

Write-Host ""
Write-Host "  ────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  ✅ 虚无框架已就绪" -ForegroundColor Green
Write-Host "     · 管家: node scripts/bootstrap.js status"
Write-Host "     · 投递任务: 放文件进 inbox/ 目录"
Write-Host "     · 卸载: scripts\install.ps1 -Uninstall"
Write-Host ""
exit 0