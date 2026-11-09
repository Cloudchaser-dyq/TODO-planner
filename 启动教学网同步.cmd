@echo off
chcp 65001 >nul
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22 或更新版本，然后重新打开本文件。
  pause
  exit /b 1
)
node "%~dp0pku-server.cjs"
if errorlevel 1 pause
