' backup-supervisor-l1.vbs — 隐藏包装（计划任务 Hidden 失效——vbs ws.Run 0 可靠）
Set ws = CreateObject("Wscript.Shell")
ws.Run "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\du_ji\pi_workspace\org\scripts\backup-supervisor-l1.ps1", 0, False
