' org-watchdog.vbs — 隐藏包装
Set ws = CreateObject("Wscript.Shell")
ws.Run "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\du_ji\pi_workspace\org\scripts\watchdog.ps1", 0, False
