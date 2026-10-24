@echo off
rem Double-click to stop the Market Scanner from opening every morning.
schtasks /Delete /F /TN "Market Scanner morning" >nul 2>&1
if errorlevel 1 (
  echo The morning schedule was not turned on, so there was nothing to remove.
) else (
  echo Done. The Market Scanner will no longer open every morning.
)
echo.
pause
