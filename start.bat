@echo off
REM Double-click this on Windows to run the table.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Get it from https://nodejs.org ^(pick the LTS button^), then run this again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo   First run - installing. This takes a minute.
  call npm install --omit=dev
  if errorlevel 1 (
    echo   Install failed.
    pause
    exit /b 1
  )
)

REM Let phones on the same wifi reach this computer, on both the plain and the
REM secure port. Needs one admin prompt, and only the first time. Skipping it
REM just means only this computer can open the app.
netsh advfirewall firewall show rule name="Poker Hub" >nul 2>nul
if errorlevel 1 (
  powershell -Command "Start-Process netsh -ArgumentList 'advfirewall firewall add rule name=\"Poker Hub\" dir=in action=allow protocol=TCP localport=3000,3443' -Verb RunAs" >nul 2>nul
)

if "%PORT%"=="" set PORT=3000
start "" http://localhost:%PORT%
node server.js
pause
