@echo off
echo ========================================
echo   GHOSTCODE Chat Auto-Start
echo ========================================
echo.

REM Проверка установки bun
where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo Installing Bun...
    powershell -Command "irm bun.sh/install | iex"
)

REM Запуск чат-сервера в фоне
echo Starting chat server...
start /b bun run chat-server.js

REM Ожидание сервера
timeout /t 2 /nobreak >nul

REM Проверка и запуск cloudflare tunnel
where cloudflared >nul 2>&1
if %errorlevel% neq 0 (
    echo Installing Cloudflare Tunnel...
    winget install cloudflare/cloudflared --accept-package-agreements --accept-source-agreements
)

REM Проверка туннеля
cloudflared tunnel list | findstr ghostcode-chat >nul
if %errorlevel% neq 0 (
    echo Creating Cloudflare Tunnel...
    cloudflared tunnel create ghostcode-chat
)

echo Starting Cloudflare Tunnel...
cloudflared tunnel run ghostcode-chat --url localhost:8765 --log-level debug

pause