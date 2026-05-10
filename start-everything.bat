@echo off
echo ========================================
echo   GHOSTCODE - Installing & Starting
echo ========================================

REM Install cloudflared
echo [1/4] Installing Cloudflare Tunnel...
powershell -Command "irm https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi -OutFile cloudflared.msi"
msiexec /i cloudflared.msi /quiet

REM Create tunnel
echo [2/4] Creating tunnel...
cloudflared tunnel create ghostcode-chat 2>nul

REM Run server and tunnel
echo [3/4] Starting chat server...
start /b bun run chat-server.js
timeout /t 2 /nobreak >nul

echo [4/4] Starting tunnel...
cloudflared tunnel run ghostcode-chat --url localhost:8765 --log-level info

pause