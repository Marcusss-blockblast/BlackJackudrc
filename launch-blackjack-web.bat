@echo off
setlocal

set "ROOT=%~dp0"
set "BACKEND=%ROOT%node-backend"
set "URL=http://localhost:3000/app"
set "NODE_LTS_ID=OpenJS.NodeJS.LTS"

if not exist "%BACKEND%\package.json" (
  echo Could not find node-backend\package.json
  echo Expected: %BACKEND%\package.json
  pause
  exit /b 1
)

call :ensureNodeAndNpm
if errorlevel 1 (
  pause
  exit /b 1
)

if not exist "%BACKEND%\node_modules" (
  echo Installing dependencies first time...
  pushd "%BACKEND%"
  call npm install
  if errorlevel 1 (
    popd
    echo npm install failed.
    pause
    exit /b 1
  )
  popd
)

echo Stopping any existing server on port 3000...
powershell -NoProfile -Command "$matches = netstat -ano | Select-String ':3000\s.*LISTENING'; foreach ($m in $matches) { $pid = ($m.Line.Trim() -split '\s+')[-1]; if ($pid -match '^\d+$') { try { (Get-WmiObject Win32_Process -Filter \"ProcessId=$pid\").Terminate() | Out-Null; Write-Host \"  Killed PID $pid\" } catch {} } }; Start-Sleep -Milliseconds 800"

echo Starting Blackjack server in a new terminal window...
start "Blackjack Server" cmd /k "cd /d "%BACKEND%" && npm start"

echo Waiting for backend to become ready...
set "READY=0"
for /L %%i in (1,1,30) do (
  powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:3000/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
  if not errorlevel 1 (
    set "READY=1"
    goto :openBrowser
  )
  timeout /t 1 >nul
)

:openBrowser
if "%READY%"=="1" (
  echo Opening %URL%
  start "" "%URL%"
  exit /b 0
)

echo Server did not respond at /health in time.
echo You can still open %URL% manually once server is ready.
pause
exit /b 1

:ensureNodeAndNpm
call :refreshNodePath
where node >nul 2>nul
if not errorlevel 1 goto :checkNpm

echo Node.js was not found in PATH.
echo Trying automatic install using winget...

where winget >nul 2>nul
if errorlevel 1 goto :manualNodeInstall

winget install --id %NODE_LTS_ID% -e --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo Automatic Node.js install failed.
  goto :manualNodeInstall
)

call :refreshNodePath
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js install appears complete but this terminal cannot see it yet.
  echo Close this window and run the launcher again.
  exit /b 1
)

:checkNpm
where npm >nul 2>nul
if errorlevel 1 (
  echo npm is missing even though Node.js was found.
  echo Please reinstall Node.js LTS from https://nodejs.org/
  start "" "https://nodejs.org/"
  exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do echo Using Node %%v
for /f "tokens=*" %%v in ('npm --version') do echo Using npm %%v
exit /b 0

:refreshNodePath
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%LocalAppData%\Programs\nodejs;%PATH%"
exit /b 0

:manualNodeInstall
echo Could not install Node.js automatically.
echo Please install Node.js LTS from https://nodejs.org/ and rerun this launcher.
start "" "https://nodejs.org/"
exit /b 1