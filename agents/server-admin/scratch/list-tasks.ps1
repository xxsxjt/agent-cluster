# 列出根目录自定义计划任务 + Action 详情（UTF-8 输出）
$ErrorActionPreference = 'SilentlyContinue'
$tasks = Get-ScheduledTask | Where-Object { $_.TaskPath -eq '\' }
$rows = foreach ($t in $tasks) {
    $act = @($t.Actions)[0]
    $created = ''
    if ($t.Date) { try { $created = $t.Date.ToString('yyyy-MM-dd HH:mm') } catch {} }
    [PSCustomObject]@{
        Name    = $t.TaskName
        State   = $t.State.ToString()
        Cmd     = if ($act) { $act.Execute } else { '' }
        Args    = if ($act) { $act.Arguments } else { '' }
        Created = $created
    }
}
$rows | ConvertTo-Json | Out-File -FilePath 'C:\Users\du_ji\pi_workspace\org\agents\server-admin\scratch\tasks.json' -Encoding utf8
Write-Output ("count=" + $rows.Count)
