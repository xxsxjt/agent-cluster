' pi-xuwu-butler-once 隐藏包装（2026-08-13 弹窗巡检修复：node 直跑会闪黑窗）
' 用法：wscript.exe butler-once.vbs
Set ws = CreateObject("WScript.Shell")
ws.Run "cmd /c cd /d C:\Users\du_ji\pi_workspace\org && node butler.js", 0, False
