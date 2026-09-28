@echo off
rem ============================================================
rem  hazard-review : start the review server for the office LAN
rem  Double-click this file. Keep the window open while people
rem  are reviewing; closing it stops the service.
rem
rem  Colleagues on the same WiFi open the URL printed below.
rem  If it does not open, the Windows firewall is blocking
rem  node.exe - see the notes in the project memory file.
rem ============================================================
cd /d "%~dp0"
set PORT=3206
where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
) else (
  echo.
  echo [ERROR] node.exe not found in PATH.
  echo         Install Node.js from https://nodejs.org (LTS is fine),
  echo         then run this file again.
  echo.
  echo         (No hard-coded fallback path here on purpose - it would
  echo          only work on the machine this project was written on.)
  echo.
)
echo.
echo (server stopped - press any key to close)
pause >nul
