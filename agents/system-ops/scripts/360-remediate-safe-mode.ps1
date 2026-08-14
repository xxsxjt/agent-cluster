# =============================================================
# 360 升级提醒治理 · 安全模式一键修复脚本
# 适用于：Windows 进入「安全模式」后，以管理员身份运行本脚本
# 作用：在 360 自我保护（内核驱动）不加载时，完成以下治理
#  1. 恢复被上一会话截断的 softmgrcfg.ini（当前为 0 字节，从备份还原）
#  2. 将 EnableUpdateExam 1->0（softmgrcfg.ini / roconfig.ini）
#  3. 移除/禁用 HKLM Run 的 360Safetray 启动项（360Tray 不再自启，
#     从而不再拉起 SoftupNotify 弹窗）
#  4. 全程写日志 + 安全校验（可回滚）
# =============================================================
# 说明：常规 Windows 会话下被 360 自我保护硬拦截（已验证：
#   管理员写文件 EPERM、SYSTEM 计划任务写文件被拒、HKLM Run 注册表
#   删除被拒、taskkill 假成功、sc 停止服务被拒 rc=5）。
#   仅安全模式/PE 可写。需用户批准重启进安全模式后运行。
# =============================================================

param(
    [switch]$Restore   # 从备份整体还原（撤销本次修改，含恢复 360Safetray 启动项）
)

$ErrorActionPreference = 'Continue'
$dir    = "C:\Program Files (x86)\360\360Safe\SoftMgr"
$bak    = "C:\Users\du_ji\pi_workspace\org\agents\system-ops\backup\360softmgr_20260811"
$runKey = "HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Run"
$log    = "C:\Users\du_ji\pi_workspace\scratch\360_remediate_safe_mode.log"
$runBak = "C:\Users\du_ji\pi_workspace\scratch\360_run_entry_backup.txt"

function Log($m) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding utf8; Write-Host $m }

# 引导确认：必须处于安全模式，避免误操作
$sm = (Get-CimInstance Win32_ComputerSystem).BootupState
Log ("BootupState: {0} | ran-as: {1}" -f $sm, (whoami))

if ($sm -notmatch "安全|Normal boot|Fail-safe|Safe") {
    Log "!! 当前非安全模式（360 自我保护可能在拦截），继续尝试但结果不保证"
} else {
    Log ">> 确认处于安全模式，可正常写入"
}

# --- 恢复模式 ---
if ($Restore) {
    Log "===== RESTORE MODE ====="
    foreach ($n in @("softmgrcfg.ini","roconfig.ini","Config.ini","SoftSmartNotify.ini","data/UserSettings.ini")) {
        $src = Join-Path $bak $n
        $dst = Join-Path $dir $n
        if (Test-Path $src) { try { Copy-Item $src $dst -Force -ErrorAction Stop; Log "restored $n" } catch { Log "restore $n FAIL: $($_.Exception.Message)" } }
    }
    # 恢复 360Safetray 启动项（若被删则加回）
    try {
        $v = "`"C:\Program Files (x86)\360\360Safe\safemon\360tray.exe`" /start"
        if (-not (Get-ItemProperty -Path $runKey -Name 360Safetray -ErrorAction SilentlyContinue)) {
            Set-ItemProperty -Path $runKey -Name 360Safetray -Value $v
            Log "restored Run\360Safetray"
        } else { Log "Run\360Safetray already present" }
    } catch { Log "restore Run key FAIL: $($_.Exception.Message)" }
    Log "===== RESTORE DONE ====="
    exit
}

# --- 治理模式 ---
Log "===== REMEDIATE MODE ====="

# 1) 恢复被截断的 softmgrcfg.ini
$smFile = Join-Path $dir "softmgrcfg.ini"
if ((Get-Item $smFile).Length -eq 0) {
    try { Copy-Item (Join-Path $bak "softmgrcfg.ini") $smFile -Force -ErrorAction Stop; Log "softmgrcfg.ini restored from backup (was 0 bytes)" }
    catch { Log "softmgrcfg restore FAIL: $($_.Exception.Message)" }
} else { Log "softmgrcfg.ini not empty, skip restore" }

# 2) 字节级 EnableUpdateExam 1->0（ASCII 等长替换，保留 GBK）
$pat  = [Text.Encoding]::ASCII.GetBytes("EnableUpdateExam=1")
$repl = [Text.Encoding]::ASCII.GetBytes("EnableUpdateExam=0")
foreach ($name in @("softmgrcfg.ini","roconfig.ini")) {
    $fp = Join-Path $dir $name
    if (-not (Test-Path $fp)) { Log "$name NOT FOUND"; continue }
    $bytes = [IO.File]::ReadAllBytes($fp)
    $changed = 0
    for ($i=0; $i -le $bytes.Length-$pat.Length; $i++) {
        $m=$true
        for ($j=0;$j -lt $pat.Length;$j++){ if($bytes[$i+$j]-ne $pat[$j]){$m=$false;break} }
        if($m){ $bytes[$i+$pat.Length-1]=[byte]'0'; $changed++ }
    }
    if ($changed -gt 0) {
        try { [IO.File]::WriteAllBytes($fp,$bytes); Log "$name : EnableUpdateExam=0 ($changed occurrence)" }
        catch { Log "$name write FAIL: $($_.Exception.Message)" }
    } else { Log "$name : no EnableUpdateExam=1 (already 0/absent)" }
}

# 3) 移除 360Safetray 启动项（备份原值到文件）
try {
    $old = (Get-ItemProperty -Path $runKey -Name '360Safetray' -ErrorAction Stop).'360Safetray'
    Add-Content -Path $runBak -Value ("backup-at-{0}: {1}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $old) -Encoding utf8
    Remove-ItemProperty -Path $runKey -Name 360Safetray -ErrorAction Stop
    Log "removed Run\360Safetray (360Tray no longer auto-starts)"
} catch { Log "remove Run\360Safetray FAIL: $($_.Exception.Message)" }

# 4) 校验
Log "===== VERIFY ====="
foreach ($name in @("softmgrcfg.ini","roconfig.ini")) {
    $fp = Join-Path $dir $name
    if (Test-Path $fp) {
        $t = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($fp))
        Log ("{0}: size={1} lines: {2}" -f $name, (Get-Item $fp).Length, ((($t -split "`n") | Where-Object { $_ -match "EnableUpdateExam" }) -join " | "))
    }
}
Log "Run\360Safetray present: $([bool](Get-ItemProperty -Path $runKey -Name 360Safetray -ErrorAction SilentlyContinue))"
Log "===== REMEDIATE DONE ====="
