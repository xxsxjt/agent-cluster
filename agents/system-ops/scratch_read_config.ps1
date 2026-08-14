$ErrorActionPreference = 'Continue'
$dir = "C:\Program Files (x86)\360\360Safe\SoftMgr"
Write-Host "===== softmgrcfg.ini (full, $((Get-Item "$dir\softmgrcfg.ini").Length)B) ====="
Get-Content "$dir\softmgrcfg.ini" -Encoding Byte | ForEach-Object { -join [char[]]($_ ) } -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "===== roconfig.ini (full) ====="
Get-Content "$dir\roconfig.ini" -Raw
Write-Host ""
Write-Host "===== Config.ini ====="
Get-Content "$dir\Config.ini" -Raw
Write-Host ""
Write-Host "===== SoftExamConfig.xml ====="
Get-Content "$dir\SoftExamConfig.xml" -Raw
Write-Host ""
Write-Host "===== SoftExamConfig_New.xml ====="
Get-Content "$dir\SoftExamConfig_New.xml" -Raw
Write-Host ""
Write-Host "===== SoftExamConfig_UpdateSoft.xml ====="
Get-Content "$dir\SoftExamConfig_UpdateSoft.xml" -Raw
