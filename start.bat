@echo off
title ReSplat Local

echo.
echo   ReSplat Local Backend
echo   =====================
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo   [ERROR] Node.js is not installed.
    echo   Please install Node.js ^>= 20.19.0 from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: Check Node.js version
for /f "tokens=1,2,3 delims=." %%a in ('node -v 2^>nul') do (
    set NODE_MAJOR=%%a
    set NODE_MINOR=%%b
)
set NODE_MAJOR=%NODE_MAJOR:v=%
if %NODE_MAJOR% lss 20 (
    echo   [WARN] Node.js version %NODE_MAJOR%.%NODE_MINOR% detected. Recommended: ^>= 20.19.0
    echo.
)

:: Install dependencies if needed
if not exist "node_modules" (
    echo   Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo   [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

:: Build frontend if dist/ doesn't exist
if not exist "dist\index.html" (
    echo   Building frontend...
    call npm run build
    if %errorlevel% neq 0 (
        echo   [ERROR] Build failed.
        pause
        exit /b 1
    )
)

:: Start server
echo   Starting ReSplat backend...
echo.
call npm run local
pause
