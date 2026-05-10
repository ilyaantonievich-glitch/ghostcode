@echo off
git clone https://github.com/ilyaantonievich-glitch/ghostcode.git
cd ghostcode
bun install
bun run chat-server.js
echo.
echo Chat server started!
echo Type 'bun run start' to run GHOSTCODE
pause