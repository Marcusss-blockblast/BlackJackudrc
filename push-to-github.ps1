Set-Location -Path $PSScriptRoot

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Git was not found on this computer." -ForegroundColor Red
    Write-Host "Install Git for Windows first, then run this script again." -ForegroundColor Yellow
    exit 1
}

$repoUrl = Read-Host "Paste your GitHub repository URL here"

$gitName = (git config --get user.name 2>$null | Select-Object -First 1)
if (-not $gitName) {
    $gitName = Read-Host "Git user name (required)"
}

$gitEmail = (git config --get user.email 2>$null | Select-Object -First 1)
if (-not $gitEmail) {
    $gitEmail = Read-Host "Git user email (required)"
}

if (-not $gitName -or -not $gitEmail) {
    Write-Host "Git user name and email are required." -ForegroundColor Red
    Write-Host 'Run these first if you want to set them globally:' -ForegroundColor Yellow
    Write-Host 'git config --global user.name "Your Name"' -ForegroundColor Yellow
    Write-Host 'git config --global user.email "you@example.com"' -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path ".git")) {
    git init
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($gitName) {
    git config user.name $gitName
}

if ($gitEmail) {
    git config user.email $gitEmail
}

git add .
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

git commit -m "Initial commit"
if ($LASTEXITCODE -ne 0) {
    $headExists = git rev-parse --verify HEAD 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $headExists) {
        Write-Host "Git could not create the first commit. Set your Git name and email, then run this script again." -ForegroundColor Red
        exit 1
    }

    Write-Host "Commit may already exist or there may be nothing new to commit." -ForegroundColor Yellow
}

git branch -M main

$origin = git remote get-url origin 2>$null
if ($LASTEXITCODE -ne 0 -or -not $origin) {
    git remote add origin $repoUrl
} else {
    git remote set-url origin $repoUrl
}

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

git push -u origin main
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Done. Your project was pushed to GitHub." -ForegroundColor Green
