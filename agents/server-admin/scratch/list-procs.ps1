# 扫描当前 node/powershell/cmd/python/conhost 进程（含命令行与主窗口标题）
$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='powershell.exe' or Name='cmd.exe' or Name='python.exe' or Name='pythonw.exe' or Name='wscript.exe' or Name='cscript.exe' or Name='conhost.exe'"
$rows = foreach ($p in $procs) {
    $w = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    [PSCustomObject]@{
        Pid   = $p.ProcessId
        PPid  = $p.ParentProcessId
        Name  = $p.Name
        Win   = if ($w -and $w.MainWindowTitle) { $w.MainWindowTitle } else { '' }
        Cmd   = $p.CommandLine
    }
}
$rows | ConvertTo-Json -Depth 2 | Out-File -FilePath 'C:\Users\du_ji\pi_workspace\org\agents\server-admin\scratch\procs.json' -Encoding utf8
Write-Output ("count=" + $rows.Count)
