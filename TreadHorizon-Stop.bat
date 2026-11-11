@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js，无法停止 Tread Horizon。
  echo 请先安装 Node.js 24 LTS：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node scripts\stop.mjs %*
set "EXITCODE=%ERRORLEVEL%"
echo.
if not "%EXITCODE%"=="0" (
  echo [提示] 停止失败，请查看上面的提示。
  echo.
)
pause
exit /b %EXITCODE%
