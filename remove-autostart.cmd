@echo off
rem Double-click to stop the Market Scanner from starting automatically at sign-in.
set "LAUNCHER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Market Scanner.cmd"
if exist "%LAUNCHER%" (
  del "%LAUNCHER%"
  echo Done. The Market Scanner will no longer start automatically.
) else (
  echo Automatic start was not turned on, so there was nothing to remove.
)
echo.
pause
