@echo off
chcp 65001 >nul
title ReSplat Development Server

echo ==============================================
echo          ReSplat 开发服务器启动脚本
echo ==============================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo 错误: 未找到 Node.js，请先安装 Node.js >= 20.19.0
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

node --version | findstr /r "v20\." >nul
if %errorlevel% neq 0 (
    echo 警告: 检测到的 Node.js 版本可能低于要求的 20.19.0
    echo 请确保安装的 Node.js 版本 >= 20.19.0
    echo.
)

if not exist "node_modules" (
    echo 正在安装依赖...
    echo.
    npm install
    if %errorlevel% neq 0 (
        echo 错误: 依赖安装失败
        pause
        exit /b 1
    )
    echo.
    echo 依赖安装完成
    echo.
)

echo 启动开发服务器...
echo 访问地址: http://localhost:3000
echo.
echo 按 Ctrl+C 停止服务器
echo ==============================================
echo.

npm run develop

pause