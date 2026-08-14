# backup-supervisor-l1.ps1 — L1 备用监督者包装（schtasks 触发，隐藏窗口）
# 用法：powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File backup-supervisor-l1.ps1
$ErrorActionPreference = 'SilentlyContinue'
$node = 'C:\Program Files\nodejs\node.exe'
$script = 'C:\Users\du_ji\pi_workspace\org\scripts\backup-supervisor.js'
& $node $script 2>&1 | Out-Null
