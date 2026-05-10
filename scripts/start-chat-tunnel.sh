#!/bin/bash
# Start chat with tunnel
echo "Starting chat server..."
bun run packages/opencode/src/cli/cmd/chat-server.ts &
sleep 2
echo "Starting tunnel..."
lt --port 8765