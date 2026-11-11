@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js，无法启动 Tread Horizon。
  echo 请先安装 Node.js 24 LTS：https://nodejs.org/
  echo 安装完成后重新双击本文件。
  echo.
  pause
  exit /b 1
)

node scripts\launch.mjs %*
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo [错误] 启动失败，请查看上面的提示。
  echo.
  pause
)
exit /b %EXITCODE%
