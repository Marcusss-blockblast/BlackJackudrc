param(
    [switch]$SkipTests,
    [switch]$SkipSmoke
)

$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$backendDir = Join-Path $projectRoot "node-backend"
$packageJson = Join-Path $backendDir "package.json"

if (-not (Test-Path $packageJson)) {
    Write-Host "Could not find node-backend\\package.json." -ForegroundColor Red
    Write-Host "Expected location: $packageJson" -ForegroundColor Yellow
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js was not found on this computer." -ForegroundColor Red
    Write-Host "Install Node.js, then run this script again." -ForegroundColor Yellow
    exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "npm was not found on this computer." -ForegroundColor Red
    Write-Host "Install Node.js (includes npm), then run this script again." -ForegroundColor Yellow
    exit 1
}

Write-Host "Project root: $projectRoot" -ForegroundColor Cyan
Write-Host "Backend dir:  $backendDir" -ForegroundColor Cyan
Write-Host "Node version:" -ForegroundColor Gray
& node --version
Write-Host "npm version:" -ForegroundColor Gray
& npm --version

Push-Location $backendDir
try {
    Write-Host "\n[1/3] Installing dependencies (npm install)..." -ForegroundColor Cyan
    & npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm install failed with code $LASTEXITCODE." -ForegroundColor Red
        exit $LASTEXITCODE
    }

    if ($SkipSmoke) {
        Write-Host "\n[2/3] Skipping smoke test (--SkipSmoke)." -ForegroundColor Yellow
    } else {
        Write-Host "\n[2/3] Running smoke test (npm run smoke)..." -ForegroundColor Cyan
        & npm run smoke
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Smoke test failed with code $LASTEXITCODE." -ForegroundColor Red
            exit $LASTEXITCODE
        }
    }

    if ($SkipTests) {
        Write-Host "\n[3/3] Skipping test suite (--SkipTests)." -ForegroundColor Yellow
    } else {
        Write-Host "\n[3/3] Running tests (npm test)..." -ForegroundColor Cyan
        & npm test
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Test suite failed with code $LASTEXITCODE." -ForegroundColor Red
            exit $LASTEXITCODE
        }
    }

    Write-Host "\nBackend verification completed successfully." -ForegroundColor Green
    exit 0
}
finally {
    Pop-Location
}
