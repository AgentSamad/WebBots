@echo off
echo =============================================
echo  Boom Arena Bot - Setup
echo =============================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed.
    echo Download it from https://nodejs.org
    pause
    exit /b 1
)

echo [1/3] Installing dependencies...
npm install
if %errorlevel% neq 0 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
)

echo.
echo [2/3] Installing Playwright browsers...
npx playwright install chromium
if %errorlevel% neq 0 (
    echo ERROR: Playwright browser install failed.
    pause
    exit /b 1
)

echo.
echo [3/3] Creating reports and screenshots directories...
if not exist "reports"      mkdir reports
if not exist "screenshots"  mkdir screenshots

echo.
echo =============================================
echo  Setup complete!
echo.
echo  Commands:
echo    npm run bot       - Run the bot once NOW
echo    npm test          - Run the test suite
echo    npm start         - Start the daily scheduler
echo    npm run dashboard - Start the web dashboard
echo.
echo  Then open http://localhost:3737 for the dashboard.
echo =============================================
pause
