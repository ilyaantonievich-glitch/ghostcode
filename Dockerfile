FROM oven/bun:1

WORKDIR /app

# Copy only opencode package files
COPY packages/opencode/package.json packages/opencode/bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source
COPY packages/opencode/src ./src

CMD ["bun", "run", "src/cli/cmd/chat-server.ts"]