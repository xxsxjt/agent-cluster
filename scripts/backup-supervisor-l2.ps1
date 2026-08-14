# backup-supervisor-l2.ps1 — L2 备用监督者（看 L1）包装（schtasks 触发，隐藏窗口）
# 用法：powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File backup-supervisor-l2.ps1
$ErrorActionPreference = 'SilentlyContinue'
$node = 'C:\Program Files\nodejs\node.exe'
$script = 'C:\Users\du_ji\pi_workspace\org\scripts\backup-supervisor.js'
& $node $script --l2 2>&1 | Out-Null
