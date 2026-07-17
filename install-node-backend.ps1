Set-Location -Path (Join-Path $PSScriptRoot "node-backend")

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "npm was not found on this computer." -ForegroundColor Red
    Write-Host "Install Node.js first, then run this script again." -ForegroundColor Yellow
    exit 1
}

Write-Host "Installing Node backend dependencies in $PWD" -ForegroundColor Cyan
npm install

if ($LASTEXITCODE -ne 0) {
    Write-Host "npm install failed." -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "Node backend dependencies installed successfully." -ForegroundColor Green