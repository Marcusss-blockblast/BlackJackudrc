@echo off
setlocal

cd /d "%~dp0node-backend"

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found on this computer.
  echo Install Node.js first, then run this file again.
  pause
  exit /b 1
)

echo Installing Node backend dependencies in:
echo %CD%
echo.

npm install
if errorlevel 1 (
  echo.
  echo npm install failed.
  pause
  exit /b 1
)

echo.
echo Node backend dependencies installed successfully.
pause