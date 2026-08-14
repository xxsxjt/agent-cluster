$ErrorActionPreference = 'Continue'
# 是否管理员
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$p = New-Object Security.Principal.WindowsPrincipal($id)
$isAdmin = $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host "user: $($id.Name)  isAdmin: $isAdmin"
Write-Host "whoami: $(whoami)"

$dir = "C:\Program Files (x86)\360\360Safe\SoftMgr"
# 只读探测：尝试写一个临时探测（不真的改配置，只测文件 ACL 权限）
Write-Host ""
Write-Host "=== 测试写入能力 (test.tmp) ==="
$testFile = Join-Path $dir "pi_write_test.tmp"
try {
    [IO.File]::WriteAllText($testFile, "test", [Text.Encoding]::ASCII)
    Write-Host "WRITE OK: created $testFile"
    Remove-Item $testFile -Force -ErrorAction SilentlyContinue
    Write-Host "cleaned up"
} catch {
    Write-Host "WRITE BLOCKED: $($_.Exception.Message)"
}

# 查看 ACL
Write-Host ""
Write-Host "=== softmgrcfg.ini ACL ==="
try { (Get-Acl "$dir\softmgrcfg.ini").Access | ForEach-Object { Write-Host "$($_.IdentityReference) : $($_.FileSystemRights) [$($_.AccessControlType)]" } } catch { Write-Host "acl err: $($_.Exception.Message)" }

# SoftMgr / SoftupNotify 进程
Write-Host ""
Write-Host "=== 相关进程 ==="
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "SoftMgr|SoftupNotify|360Tray|SoftManager" } | Select-Object Name, Id, StartTime | Format-Table -AutoSize
