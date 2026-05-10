#!/bin/bash
# GHOSTCODE Chat Auto-Start

echo "========================================"
echo "  GHOSTCODE Chat Auto-Start"
echo "========================================"

# Install bun if needed
if ! command -v bun &> /dev/null; then
    echo "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
fi

# Start chat server in background
echo "Starting chat server..."
bun run chat-server.js &
sleep 2

# Install cloudflared if needed
if ! command -v cloudflared &> /dev/null; then
    echo "Installing Cloudflare Tunnel..."
    curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
    chmod +x /usr/local/bin/cloudflared
fi

# Create tunnel if not exists
if ! cloudflared tunnel list | grep -q ghostcode-chat; then
    echo "Creating Cloudflare Tunnel..."
    cloudflared tunnel create ghostcode-chat
fi

echo "Starting Cloudflare Tunnel..."
cloudflared tunnel run ghostcode-chat --url localhost:8765