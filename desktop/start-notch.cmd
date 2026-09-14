@echo off
setlocal
rem Helm's native notch window - double-click this.
rem It is a frameless, transparent, always-on-top window that shows Helm's own
rem /hud page. Helm itself must already be running (start-helm.cmd); the notch
rem is a companion, not a second copy of the app.
title Helm notch
cd /d "%~dp0"

if not defined PORT set "PORT=7777"
set "EXE=HelmNotch\bin\Release\net8.0-windows\HelmNotch.exe"

rem Find a .NET SDK. dotnet-install.ps1 puts a per-user one here (no admin
rem needed); a machine-wide install is on PATH. Runtime-only installs cannot
rem BUILD, so prefer the per-user SDK when both exist.
set "DOTNET="
if exist "%LOCALAPPDATA%\Microsoft\dotnet\dotnet.exe" set "DOTNET=%LOCALAPPDATA%\Microsoft\dotnet\dotnet.exe"
if not defined DOTNET where dotnet >nul 2>nul && set "DOTNET=dotnet"

if not exist "%EXE%" (
  if not defined DOTNET (
    echo The notch has not been built yet, and no .NET SDK was found.
    echo.
    echo Install one ^(about 200 MB, no admin needed^):
    echo   powershell -c "iwr https://dot.net/v1/dotnet-install.ps1 -OutFile d.ps1; ./d.ps1 -Channel 8.0"
    echo.
    pause
    exit /b 1
  )
  echo First run: building the notch...
  "%DOTNET%" build HelmNotch\HelmNotch.csproj -c Release -v minimal || goto :failed
)

rem Is Helm actually up? The notch retries on its own, but saying so beats a
rem blank window while you wonder which of the two is broken.
powershell -NoProfile -Command "try{ $null = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT%/health' -TimeoutSec 2; exit 0 }catch{ exit 1 }"
if errorlevel 1 echo Helm does not answer on port %PORT% yet - start it with start-helm.cmd. The notch will keep retrying.

start "" "%EXE%" "http://127.0.0.1:%PORT%/hud?notch=1"
exit /b 0

:failed
echo.
echo === Build failed ^(exit code %errorlevel%^). The lines above say why.
pause >nul
exit /b 1
