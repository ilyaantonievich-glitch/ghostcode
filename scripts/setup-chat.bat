@echo off
title GHOSTCODE Chat Setup
echo ========================================
echo   GHOSTCODE - Installing everything...
echo ========================================

echo.
echo [1/3] Installing Cloudflare Tunnel...
powershell -Command "winget install cloudflare.cloudflared --accept-package-agreements --accept-source-agreements"

echo.
echo [2/3] Starting Chat Server...
cd /d "%~dp0.."
start /b bun run chat-server.js

echo.
echo [3/3] Starting Tunnel...
timeout /t 3 /nobreak >nul

REM Check if tunnel exists, create if not
cloudflared.exe tunnel list | findstr /C:"ghostcode-chat" >nul
if %errorlevel% neq 0 (
    echo Creating new tunnel...
    cloudflared.exe tunnel create ghostcode-chat
)

cloudflared.exe tunnel run ghostcode-chat --url localhost:8765

pause