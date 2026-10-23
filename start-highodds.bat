@echo off
setlocal

rem Start HighOdds locally from the repository root.
cd /d "%~dp0"

where docker >nul 2>&1
if errorlevel 1 (
    echo Docker was not found on PATH. Install/start Docker Desktop and try again.
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo npm was not found on PATH. Install Node.js 22 or newer and try again.
    exit /b 1
)

if not exist ".env" (
    echo Creating .env from .env.example...
    copy /y ".env.example" ".env" >nul
)

if not exist "apps\web\.env" (
    echo Creating apps\web\.env from the root .env...
    copy /y ".env" "apps\web\.env" >nul
)

if not exist "packages\db\.env" (
    echo Creating packages\db\.env for Prisma...
    copy /y ".env" "packages\db\.env" >nul
)

echo Starting local Postgres...
docker compose up -d postgres
if errorlevel 1 (
    echo Could not start Postgres.
    goto :failure
)

echo Generating Prisma client...
call npm run db:generate
if errorlevel 1 goto :failure

echo Applying database migrations...
call npm run db:migrate:deploy --workspace=@highodds/db
if errorlevel 1 goto :failure

echo Starting HighOdds web app in a separate window...
start "HighOdds Web" /D "%~dp0" cmd /k "title HighOdds Web && npm run dev --workspace=@highodds/web"

echo Waiting for HighOdds to become ready...
for /L %%N in (1,1,30) do (
    curl.exe -fsS http://localhost:3000/api/health >nul 2>&1
    if not errorlevel 1 goto :web_ready
    ping.exe -n 2 127.0.0.1 >nul
)
echo HighOdds did not become ready within 30 seconds.
goto :failure

:web_ready
echo Opening http://localhost:3000 in your browser...
start "" "http://localhost:3000"

echo HighOdds is starting. Keep the HighOdds Web window open while using the app.
pause
endlocal
exit /b 0

:failure
echo.
echo HighOdds could not be started. Review the error above.
pause
endlocal
exit /b 1
