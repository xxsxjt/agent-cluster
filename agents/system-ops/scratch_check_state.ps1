$ErrorActionPreference = 'Continue'
Write-Host "===== 360 config 文件当前状态 ====="
$dir = "C:\Program Files (x86)\360\360Safe\SoftMgr"
if (Test-Path $dir) {
    Get-ChildItem $dir -Force | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
    foreach ($n in @("softmgrcfg.ini","roconfig.ini","Config.ini","SoftSmartNotify.ini")) {
        $fp = Join-Path $dir $n
        if (Test-Path $fp) {
            Write-Host "----- $n -----"
            Write-Host "size: $((Get-Item $fp).Length)  mtime: $((Get-Item $fp).LastWriteTime)"
            # 只显示 EnableUpdateExam / Enable* / Update 相关行
            Select-String -Path $fp -Pattern "EnableUpdateExam|EnableUpdate|UpdateExam|UpdateCheck|AutoUpdate|Upgrade" -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_.Line }
        } else { Write-Host "$n NOT FOUND" }
    }
} else { Write-Host "$dir NOT FOUND" }

Write-Host ""
Write-Host "===== HKLM Run 360Safetray ====="
$runKey = "HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Run"
try { Get-ItemProperty -Path $runKey -Name 360Safetray -ErrorAction SilentlyContinue | Format-List 360Safetray } catch { Write-Host "no 360Safetray in HKLM Run" }
$runKey2 = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run"
try { Get-ItemProperty -Path $runKey2 -Name 360Safetray -ErrorAction SilentlyContinue | Format-List 360Safetray } catch { Write-Host "no 360Safetray in HKLM Run (non-wow64)" }

Write-Host ""
Write-Host "===== 360 相关计划任务 ====="
Get-ScheduledTask -TaskPath "\" -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match "360|soft|Safe|Tray" } | Select-Object TaskName, State | Format-Table -AutoSize

Write-Host ""
Write-Host "===== 360 相关服务 ====="
Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "360|soft" } | Select-Object Name, Status, StartType | Format-Table -AutoSize
