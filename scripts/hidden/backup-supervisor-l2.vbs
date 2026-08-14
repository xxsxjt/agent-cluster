' backup-supervisor-l2.vbs — 隐藏包装
Set ws = CreateObject("Wscript.Shell")
ws.Run "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\du_ji\pi_workspace\org\scripts\backup-supervisor-l2.ps1", 0, False
