@echo off
title GHOSTCODE Chat Setup
echo ========================================
echo   GHOSTCODE - Installing everything...
echo ========================================

echo.
echo [1/2] Installing Cloudflare Tunnel...
powershell -Command "winget install cloudflare.cloudflared --accept-package-agreements --accept-source-agreements"

echo.
echo [2/2] Starting Chat Server & Tunnel...
echo.
echo Starting server and tunnel - wait 10 seconds...
start /b bun run chat-server.js
timeout /t 3 /nobreak >nul
cloudflared tunnel create ghostcode-chat 2>nul
cloudflared tunnel run ghostcode-chat --url localhost:8765

pause