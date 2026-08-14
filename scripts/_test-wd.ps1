# 临时测试文件 - 验证 Test-PidIsNode
function Test-PidIsNode([string]$pidFile) {
    if (-not (Test-Path $pidFile)) { return $false }
    try {
        $pidStr = (Get-Content $pidFile -Raw -ErrorAction Stop).Trim()
        if (-not $pidStr -or $pidStr -notmatch '^\d+$') { return $false }
        $out = tasklist /FI "PID eq $pidStr" /FO CSV /NH 2>$null
        $needle = 'node.exe' + '","' + $pidStr + '"'
        return [bool]($out -match [regex]::Escape($needle))
    } catch { return $false }
}
Write-Output ("butler pid alive: " + (Test-PidIsNode 'C:\Users\du_ji\pi_workspace\org\butler.pid'))
Write-Output ("web pid alive:   " + (Test-PidIsNode 'C:\Users\du_ji\pi_workspace\org\logs\web.pid'))
