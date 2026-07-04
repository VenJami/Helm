@echo off
rem Helm launcher — opens a real console window running the server so you can
rem watch logs and Ctrl+C it. Double-click this file, or run it from a terminal.
title Helm server
cd /d "%~dp0server"
echo Starting Helm server on http://127.0.0.1:7777  (Ctrl+C to stop)
echo.
call npm start
echo.
echo === Helm server stopped ^(exit code %errorlevel%^). Press any key to close. ===
pause >nul
