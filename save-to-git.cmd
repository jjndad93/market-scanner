@echo off
rem Double-click to save all changes in this folder to Git (local only; nothing is uploaded).
cd /d "%~dp0"
echo Saving your market-scanner changes to Git...
echo.
set "msg="
set /p "msg=Describe what changed (or just press Enter): "
if "%msg%"=="" set "msg=Save work"
git add -A
git commit -m "%msg%"
echo.
echo Latest saves:
git log --format="  %%h  %%ad  %%s" --date=short -3
echo.
pause
