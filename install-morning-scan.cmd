@echo off
rem Double-click ONCE to open the Market Scanner every morning at a time you choose (Windows Task Scheduler).
rem Turn on "Morning auto-scan" in the dashboard Settings so a live scan runs when it opens.
rem To undo: double-click remove-morning-scan.cmd.
set "T="
set /p "T=What time each morning? (24-hour, like 08:00, or press Enter for 08:00): "
if "%T%"=="" set "T=08:00"
schtasks /Create /F /SC DAILY /ST %T% /TN "Market Scanner morning" /TR "\"%~dp0start-scanner.cmd\"" >nul
if errorlevel 1 (
  echo That did not work. Use a time like 07:30 or 08:00 and try again.
) else (
  echo Done. The Market Scanner will open every day at %T% if you are signed in.
  echo Turn on "Morning auto-scan" in the dashboard Settings so the scan runs by itself.
)
echo.
pause
