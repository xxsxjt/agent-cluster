@echo off
rem v5 org overview - launcher (Windows)
rem   NOTE: keep this file pure ASCII. cmd.exe reads it in the OEM codepage
rem   (936/GBK here), so UTF-8 comments would corrupt parsing.
rem
rem   start-web.cmd                 local only, 127.0.0.1:8787
rem   start-web.cmd 9000            custom port
rem   start-web.cmd 8787 lan        bind 0.0.0.0 (reachable from phone/LAN)
rem   start-web.cmd 8787 lan mytok  LAN + token auth
setlocal
cd /d "%~dp0"

set PORT=%1
if "%PORT%"=="" set PORT=8787

set HOSTARG=--host 127.0.0.1
if /i "%2"=="lan" set HOSTARG=--host 0.0.0.0

set TOKENARG=
if not "%3"=="" set TOKENARG=--token %3

where node >nul 2>nul
if errorlevel 1 (
  echo [x] node not found - please install Node.js first
  pause
  exit /b 1
)

echo Starting v5 org overview: http://127.0.0.1:%PORT%/
echo Press Ctrl+C to stop.
node server.js --port %PORT% %HOSTARG% %TOKENARG%
endlocal
