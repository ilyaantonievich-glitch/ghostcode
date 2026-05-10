#!/usr/bin/env bun
/**
 * Standalone Chat WebSocket Server
 * Deploy anywhere - no external dependencies needed
 * 
 * Environment variables:
 *   PORT - порт (по умолчанию 8765)
 *   CHAT_PASSWORD - пароль для доступа (по умолчанию "ghostcode")
 */

const PORT = parseInt(process.env.PORT || "8765")
const PASSWORD = process.env.CHAT_PASSWORD || "ghostcode"

interface ChatMessage {
  id: string
  timestamp: string
  author: string
  text: string
  thread_id?: string
}

interface Client {
  ws: any
  username: string
  joinedAt: number
  authorized: boolean
}

const clients = new Map<string, Client>()

const HISTORY_FILE = "/tmp/chat-history.json"

async function loadHistory(): Promise<ChatMessage[]> {
  try {
    const { readFile } = await import("fs/promises")
    const content = await readFile(HISTORY_FILE, "utf-8")
    return JSON.parse(content)
  } catch { return [] }
}

async function saveMessage(msg: ChatMessage) {
  try {
    const { readFile, writeFile } = await import("fs/promises")
    const history = await loadHistory()
    history.push(msg)
    if (history.length > 1000) history.splice(0, history.length - 1000)
    await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2))
  } catch {}
}

function broadcast(message: ChatMessage, excludeId?: string) {
  const data = JSON.stringify(message)
  clients.forEach((client, id) => {
    if (id !== excludeId && client.ws.readyState === 1) {
      try { client.ws.send(data) } catch {}
    }
  })
}

function broadcastToAll(obj: object) {
  const data = JSON.stringify(obj)
  clients.forEach((client) => {
    if (client.ws.readyState === 1) {
      try { client.ws.send(data) } catch {}
    }
  })
}

// Simple WebSocket server using Node's built-in module
const { createServer } = await import("http")
const server = createServer()

const wss = new (await import("ws")).WebSocketServer({ server })

wss.on("connection", (ws, req) => {
  const clientId = crypto.randomUUID()
  const ip = req.socket.remoteAddress || "unknown"
  
  console.log(`[Chat] 🔗 ${ip} connected (${clientId})`)

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString())

      // Handle password verification first
      if (msg.type === "auth") {
        if (msg.password !== PASSWORD) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid password" }))
          ws.close()
          return
        }
        // Auth successful - mark client as authorized
        const client = clients.get(clientId)
        if (client) {
          client.authorized = true
          console.log(`[Chat] 🔐 ${client.username} authenticated`)
        }
        return
      }

      // Check if authorized for other actions
      const client = clients.get(clientId)
      if (!client?.authorized) {
        ws.send(JSON.stringify({ type: "error", message: "Not authenticated. Send {type:'auth', password:'xxx'}" }))
        return
      }

      if (msg.type === "register") {
        const username = msg.username || "Anonymous"
        clients.set(clientId, { ws, username, joinedAt: Date.now() })
        console.log(`[Chat] 👤 ${username} joined`)
        
        const history = await loadHistory()
        ws.send(JSON.stringify({ type: "welcome", username, history: history.slice(-100), online: clients.size }))
        broadcastToAll({ type: "users", count: clients.size })
        return
      }

      if (msg.type === "message") {
        const client = clients.get(clientId)
        if (!client) return

        const fullMsg: ChatMessage = {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          author: client.username,
          text: msg.text,
          thread_id: msg.thread_id,
        }

        console.log(`[Chat] 💬 ${fullMsg.author}: ${fullMsg.text.slice(0, 30)}...`)
        await saveMessage(fullMsg)
        broadcast(fullMsg, clientId)
      }
    } catch (e) {
      console.error("[Chat] Error:", e)
    }
  })

  ws.on("close", () => {
    const client = clients.get(clientId)
    if (client) {
      console.log(`[Chat] 👋 ${client.username} left`)
      clients.delete(clientId)
      broadcastToAll({ type: "users", count: clients.size })
    }
  })
})

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   💬 Chat Server                      ║
║   Port: ${PORT}                         ║
╚════════════════════════════════════════╝
  `)
})