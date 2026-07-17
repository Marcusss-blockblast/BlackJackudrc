@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo Git was not found on this computer.
  echo Install Git for Windows first, then run this file again.
  pause
  exit /b 1
)

set /p REPO_URL=Paste your GitHub repository URL here: 

for /f "delims=" %%i in ('git config --get user.name 2^>nul') do set "GIT_NAME=%%i"
if not defined GIT_NAME set /p GIT_NAME=Git user name (required): 

for /f "delims=" %%i in ('git config --get user.email 2^>nul') do set "GIT_EMAIL=%%i"
if not defined GIT_EMAIL set /p GIT_EMAIL=Git user email (required): 

if not defined GIT_NAME goto :need_identity
if not defined GIT_EMAIL goto :need_identity

if not exist ".git" (
  git init
  if errorlevel 1 goto :fail
)

if not "!GIT_NAME!"=="" git config user.name "!GIT_NAME!"
if not "!GIT_EMAIL!"=="" git config user.email "!GIT_EMAIL!"

git add .
if errorlevel 1 goto :fail

git commit -m "Initial commit"
if errorlevel 1 (
  git rev-parse --verify HEAD >nul 2>nul
  if errorlevel 1 goto :fail_commit
  echo.
  echo Commit may already exist or there may be nothing new to commit.
)

git branch -M main

git remote get-url origin >nul 2>nul
if errorlevel 1 (
  git remote add origin %REPO_URL%
) else (
  git remote set-url origin %REPO_URL%
)
if errorlevel 1 goto :fail

git push -u origin main
if errorlevel 1 goto :fail

echo.
echo Done. Your project was pushed to GitHub.
pause
exit /b 0

:need_identity
echo.
echo Git user name and email are required.
echo Run this first if you want to set them globally:
echo git config --global user.name "Your Name"
echo git config --global user.email "you@example.com"
pause
exit /b 1

:fail_commit
echo.
echo Git could not create the first commit. Set your Git name and email, then run this file again.
pause
exit /b 1

:fail
echo.
echo Push failed. Read the message above, fix the issue, then run this file again.
pause
exit /b 1
