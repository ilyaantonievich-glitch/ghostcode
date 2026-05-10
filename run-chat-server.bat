@echo off
cd /d %~dp0
bun run packages\opencode\src\cli\cmd\chat-server.ts
pause