FROM oven/bun:1

WORKDIR /app

COPY chat-server.js ./

CMD ["bun", "run", "chat-server.js"]