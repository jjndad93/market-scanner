@echo off
rem Double-click to start the Market Scanner dashboard and open it in your browser.
rem Keep this window open while you use the scanner; close it (or press Ctrl+C) to stop.
title Market Scanner
cd /d "%~dp0"
echo Starting Market Scanner... the dashboard will open in your browser in a few seconds.
echo Keep this window open while you use it. Close it to stop the scanner.
echo.
start "" /min cmd /c "timeout /t 4 /nobreak >/dev/null & start http://127.0.0.1:4173"
call npm.cmd run web
echo.
echo The scanner stopped. If it said the port is already in use, it is already running:
echo just use the browser tab that opened.
pause
