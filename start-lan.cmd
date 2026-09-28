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
  "C:\Users\10275\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe" server.js
)
echo.
echo (server stopped - press any key to close)
pause >nul
