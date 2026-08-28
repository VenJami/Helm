@echo off
setlocal
rem Helm launcher - double-click this file (no terminal commands needed).
rem It installs/builds anything missing on a first run, starts the server in a
rem real console window (so you can watch the logs and Ctrl+C it), and opens
rem Helm in its own app window - no tabs, no address bar - once it is listening.
title Helm server
cd /d "%~dp0"

if not defined PORT set "PORT=7777"
set "HELM_URL=http://127.0.0.1:%PORT%"

rem Re-invoked by ourselves (see below) to wait for the server and open the app.
if /i "%~1"=="--open" goto :openapp

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed, or it is not on your PATH.
  echo Install Node 22 or newer from https://nodejs.org, then run this file again.
  echo.
  pause
  exit /b 1
)

rem Already running? Just open the window - a second server cannot bind the port.
powershell -NoProfile -Command "try{ $null = Invoke-WebRequest -UseBasicParsing -Uri '%HELM_URL%/health' -TimeoutSec 2; exit 0 }catch{ exit 1 }"
if not errorlevel 1 (
  echo Helm is already running - opening %HELM_URL%
  call :openapp
  exit /b 0
)

if not exist "server\node_modules" (
  echo First run: installing server dependencies. This can take a few minutes...
  call npm --prefix server install || goto :failed
)
if not exist "web\node_modules" (
  echo First run: installing web dependencies...
  call npm --prefix web install || goto :failed
)
if not exist "web\dist\index.html" (
  echo First run: building the web app...
  call npm --prefix web run build || goto :failed
)

rem Background copy of ourselves: waits for /health, then opens the app window.
start "" /b cmd /c ""%~f0" --open"

echo Starting Helm on %HELM_URL%  ^(Ctrl+C to stop^)
echo.
cd server
call npm start
echo.
echo === Helm server stopped ^(exit code %errorlevel%^). Press any key to close. ===
pause >nul
exit /b

rem Waits up to 60s for the server, then opens Helm in a Chromium app window
rem (Edge, then Chrome, then Brave) - a plain window with no browser chrome.
rem No Chromium browser found: fall back to a normal tab in the default browser.
:openapp
powershell -NoProfile -Command "for($i=0;$i -lt 120;$i++){ try{ $null = Invoke-WebRequest -UseBasicParsing -Uri '%HELM_URL%/health' -TimeoutSec 2; break }catch{ Start-Sleep -Milliseconds 500 } }"
set "BROWSER="
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" set "BROWSER=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
if defined BROWSER start "" "%BROWSER%" --app=%HELM_URL% "--window-size=1500,950"
if not defined BROWSER start "" "%HELM_URL%"
goto :eof

:failed
echo.
echo === Setup failed ^(exit code %errorlevel%^). The lines above say why.
echo === node-pty needs the Windows build tools if the server install broke:
echo ===   Visual Studio Build Tools + Python. Press any key to close.
pause >nul
exit /b 1
