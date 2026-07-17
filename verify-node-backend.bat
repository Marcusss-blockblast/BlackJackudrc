@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-node-backend.ps1" %*
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  echo Backend verification failed with code %EXITCODE%.
  pause
  exit /b %EXITCODE%
)

echo.
echo Backend verification completed successfully.
pause
exit /b 0
