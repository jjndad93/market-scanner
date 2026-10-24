@echo off
rem Double-click ONCE to make the Market Scanner start automatically when you sign in to Windows.
rem It adds a small launcher to your Startup folder. To undo: double-click remove-autostart.cmd.
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LAUNCHER=%STARTUP%\Market Scanner.cmd"
(
  echo @echo off
  echo rem Starts the Market Scanner at sign-in. Added by install-autostart.cmd in "%~dp0".
  echo start "Market Scanner" /min "%~dp0start-scanner.cmd"
) > "%LAUNCHER%"
if exist "%LAUNCHER%" (
  echo Done. The Market Scanner will start automatically the next time you sign in to Windows.
  echo Launcher: "%LAUNCHER%"
) else (
  echo Something went wrong: the launcher could not be created in your Startup folder.
)
echo.
pause
