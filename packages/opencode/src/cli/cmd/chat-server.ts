/**
 * Chat WebSocket Server
 * 
 * Запускается с переменной окружения CHAT_SERVER_URL для работы в режиме клиента.
 * Для запуска сервера: bun run packages/opencode/src/cli/cmd/chat-server.ts
 * 
 * Переменные окружения:
 *   PORT - порт сервера (по умолчанию 8765)
 *   CHAT_SERVER_URL - URL для подключения к внешнему серверу (клиентский режим)
 */

import { WebSocketServer, WebSocket } from "ws"
import { randomUUID } from "crypto"
import { readFile, writeFile, mkdir } from "fs/promises"
import path from "path"

const PORT = parseInt(process.env.PORT || "8765", 10)

interface ChatMessage {
  id: string
  timestamp: string
  author: string
  text: string
  thread_id?: string
}

interface Client {
  ws: WebSocket
  username: string
  joinedAt: number
}

const clients = new Map<string, Client>()
const HISTORY_FILE = path.join(process.cwd(), ".vibe", "chat-history.json")

/** Создает файл истории сообщений если его нет */
async function ensureHistoryFile() {
  try {
    await mkdir(path.dirname(HISTORY_FILE), { recursive: true })
    try {
      await readFile(HISTORY_FILE)
    } catch {
      await writeFile(HISTORY_FILE, "[]")
    }
  } catch (err) {
    console.error("[Chat] Failed to create history file:", err)
  }
}

async function loadHistory(): Promise<ChatMessage[]> {
  try {
    const content = await readFile(HISTORY_FILE, "utf-8")
    return JSON.parse(content)
  } catch {
    return []
  }
}

async function saveMessage(msg: ChatMessage) {
  try {
    const history = await loadHistory()
    history.push(msg)
    if (history.length > 1000) history.splice(0, history.length - 1000)
    await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2))
  } catch (err) {
    console.error("[Chat] Failed to save message:", err)
  }
}

function broadcast(message: ChatMessage, excludeId?: string) {
  const data = JSON.stringify(message)
  let sent = 0
  clients.forEach((client, id) => {
    if (id !== excludeId && client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(data)
        sent++
      } catch (err) {
        console.error(`[Chat] Failed to send to ${client.username}:`, err)
      }
    }
  })
  console.log(`[Chat] Broadcast to ${sent} clients`)
}

function broadcastToAll(message: object) {
  const data = JSON.stringify(message)
  clients.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(data)
      } catch {}
    }
  })
}

const wss = new WebSocketServer({ port: PORT })

console.log(`
╔═══════════════════════════════════╗
║   💬 Chat Server Started          ║
║   Port: ${PORT}                     ║
║   History: ${HISTORY_FILE}   ║
╚═══════════════════════════════════╝
`)

async function main() {
  await ensureHistoryFile()
  const history = await loadHistory()
  console.log(`[Chat] Loaded ${history.length} messages from history`)

  wss.on("listening", () => {
    console.log(`[Chat] Server listening on ws://localhost:${PORT}`)
  })

  wss.on("connection", (ws, req) => {
    const clientId = randomUUID()
    const ip = req.socket.remoteAddress || "unknown"
    const joinedAt = Date.now()

    console.log(`[Chat] 🔗 New connection from ${ip} (${clientId})`)

    ws.on("message", async (data: any) => {
      try {
        const raw = data instanceof Buffer ? data.toString() : String(data)
        const msg = JSON.parse(raw)

        if (msg.type === "register") {
          const username = msg.username || "Anonymous"
          clients.set(clientId, { ws, username, joinedAt })
          console.log(`[Chat] 👤 Registered: ${username}`)

          const history = await loadHistory()
          ws.send(JSON.stringify({
            type: "welcome",
            username,
            history: history.slice(-100),
            online: clients.size
          }))

          broadcastToAll({ type: "users", count: clients.size })
          return
        }

        if (msg.type === "message") {
          const client = clients.get(clientId)
          if (!client) return

          const fullMsg: ChatMessage = {
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            author: client.username,
            text: msg.text,
            thread_id: msg.thread_id,
          }

          console.log(`[Chat] 💬 ${fullMsg.author}: ${fullMsg.text.slice(0, 50)}...`)
          await saveMessage(fullMsg)
          broadcast(fullMsg, clientId)
          return
        }

        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", time: Date.now() }))
        }

      } catch (err) {
        console.error("[Chat] Failed to handle message:", err)
      }
    })

    ws.on("close", () => {
      const client = clients.get(clientId)
      if (client) {
        console.log(`[Chat] 👋 Disconnected: ${client.username}`)
        clients.delete(clientId)
        broadcastToAll({ type: "users", count: clients.size })
      }
    })

    ws.on("error", (err) => {
      console.error(`[Chat] WebSocket error for ${clientId}:`, err.message)
    })
  })

  wss.on("error", (err) => {
    console.error("[Chat] Server error:", err)
  })

  process.on("SIGINT", () => {
    console.log("\n[Chat] Shutting down...")
    wss.close(() => {
      console.log("[Chat] Server closed")
      process.exit(0)
    })
  })

  process.on("unhandledRejection", (err) => {
    console.error("[Chat] Unhandled rejection:", err)
  })
}

main().catch(console.error)