' AgnesAutoPublish 早间发布隐藏包装（bilibili，2026-08-13 弹窗巡检修复）
Set ws = CreateObject("WScript.Shell")
ws.Run "cmd /c cd /d C:\Users\du_ji\pi_workspace\org\agents\auto-bots\project && node generate-and-publish.js --auto --platforms=bilibili", 0, False
