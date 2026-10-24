@echo off
rem Double-click to save all changes in this folder to Git, then upload them to GitHub.
rem GitHub repo: https://github.com/jjndad93/market-scanner (private)
cd /d "%~dp0"
echo Saving your market-scanner changes to Git...
echo.
set "msg="
set /p "msg=Describe what changed (or just press Enter): "
if "%msg%"=="" set "msg=Save work"
git add -A
git commit -m "%msg%"
echo.
rem First run only: connect this folder to the GitHub repo.
git remote get-url origin >nul 2>&1
if errorlevel 1 (
  echo Connecting this folder to GitHub: jjndad93/market-scanner
  git remote add origin https://github.com/jjndad93/market-scanner.git
)
echo Uploading to GitHub... (the first time, a browser window may ask you to sign in to GitHub)
git push -u origin HEAD
if errorlevel 1 (
  echo.
  echo The upload did not work. Check your internet, and that you signed in to GitHub as jjndad93.
  echo Your work is still saved on this computer.
) else (
  echo.
  echo Uploaded to GitHub: https://github.com/jjndad93/market-scanner
)
echo.
echo Latest saves:
git log --format="  %%h  %%ad  %%s" --date=short -3
echo.
pause
