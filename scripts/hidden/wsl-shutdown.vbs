' WSL Shutdown Cleanup 隐藏包装（2026-08-13 弹窗巡检修复）
Set ws = CreateObject("WScript.Shell")
ws.Run "cmd /c wsl --shutdown", 0, False
