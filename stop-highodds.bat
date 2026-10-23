@echo off
setlocal

rem Stop HighOdds processes started by start-highodds.bat.
cd /d "%~dp0"

echo Stopping the HighOdds Web window...
taskkill /FI "WINDOWTITLE eq HighOdds Web" /T /F >nul 2>&1

rem Also stop a HighOdds process when this script was launched from a terminal
rem and the console window title is not available to taskkill.
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do taskkill /PID %%P /T /F >nul 2>&1

where docker >nul 2>&1
if errorlevel 1 (
    echo Docker was not found on PATH; the web window was stopped, but Postgres may still be running.
    exit /b 0
)

echo Stopping local Postgres (database volume is preserved)...
docker compose down

echo HighOdds has been stopped.
endlocal
