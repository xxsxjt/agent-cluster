# 2026-08-13 弹窗巡检修复：三个违规计划任务改为 wscript 隐藏包装
$ErrorActionPreference = 'Stop'
$hidden = 'C:\Users\du_ji\pi_workspace\org\scripts\hidden'

# 1) pi-xuwu-butler-once：node 直跑 -> vbs 隐藏
$t1 = Get-ScheduledTask -TaskName 'pi-xuwu-butler-once'
$act1 = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "$hidden\butler-once.vbs" -WorkingDirectory 'C:\Users\du_ji\pi_workspace\org'
Set-ScheduledTask -TaskName 'pi-xuwu-butler-once' -Action $act1 | Out-Null
Write-Output 'FIXED pi-xuwu-butler-once'

# 2) AgnesAutoPublish 早间（bilibili）
$t2 = Get-ScheduledTask -TaskName '*Agnes*' | Where-Object { $_.Actions.Arguments -match 'bilibili' }
if ($t2) {
    $act2 = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "$hidden\agnes-publish-morning.vbs" -WorkingDirectory 'C:\Users\du_ji\pi_workspace\org\agents\auto-bots\project'
    Set-ScheduledTask -TaskName $t2.TaskName -Action $act2 | Out-Null
    Write-Output "FIXED $($t2.TaskName)"
}

# 3) AgnesAutoPublish 午间（douyin,xiaohongshu）
$t3 = Get-ScheduledTask -TaskName '*Agnes*' | Where-Object { $_.Actions.Arguments -match 'douyin' }
if ($t3) {
    $act3 = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "$hidden\agnes-publish-noon.vbs" -WorkingDirectory 'C:\Users\du_ji\pi_workspace\org\agents\auto-bots\project'
    Set-ScheduledTask -TaskName $t3.TaskName -Action $act3 | Out-Null
    Write-Output "FIXED $($t3.TaskName)"
}

# 验证
Get-ScheduledTask -TaskName 'pi-xuwu-butler-once' | Select-Object -ExpandProperty Actions | Format-List
Get-ScheduledTask -TaskName '*Agnes*' | ForEach-Object { Write-Output ("=== " + $_.TaskName); $_.Actions | Format-List }
