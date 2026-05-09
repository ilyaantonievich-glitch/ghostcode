import { WebSocketServer, WebSocket } from "ws"
import { randomUUID } from "crypto"
import { readFile, writeFile, mkdir } from "fs/promises"
import path from "path"
import { cmd } from "./cmd"

const command: ReturnType<typeof cmd> = {
  command: "chat-server",
  describe: "Start WebSocket chat server for real-time messaging",
  builder: (yargs) =>
    yargs.option("port", {
      alias: "p",
      type: "number",
      default: 8765,
      describe: "Port for WebSocket server",
    }),
  handler: async (args: any) => {
    const PORT = args.port ?? 8765

    interface ChatMessage {
      id: string
      timestamp: string
      author: string
      text: string
      thread_id?: string
    }

    const clients: Map<string, { ws: WebSocket; username: string }> = new Map()
    const HISTORY_FILE = path.join(process.cwd(), ".vibe", "chat-history.json")

    await mkdir(path.dirname(HISTORY_FILE), { recursive: true })

    async function loadHistory(): Promise<ChatMessage[]> {
      try {
        const content = await readFile(HISTORY_FILE, "utf-8")
        return JSON.parse(content)
      } catch {
        return []
      }
    }

    async function saveMessage(msg: ChatMessage) {
      const history = await loadHistory()
      history.push(msg)
      if (history.length > 1000) history.splice(0, history.length - 1000)
      await writeFile(HISTORY_FILE, JSON.stringify(history))
    }

    function broadcast(message: ChatMessage, excludeId?: string) {
      const data = JSON.stringify(message)
      clients.forEach((client, id) => {
        if (id !== excludeId && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(data)
        }
      })
    }

    const wss = new WebSocketServer({ port: PORT })

    console.log(`💬 Chat WebSocket server running on ws://localhost:${PORT}`)
    console.log(`📁 History file: ${HISTORY_FILE}`)

    const history = await loadHistory()
    console.log(`📜 Loaded ${history.length} messages from history`)

    wss.on("connection", (ws) => {
      const clientId = randomUUID()
      console.log(`🔗 New connection (${clientId})`)

      ws.on("message", async (data) => {
        try {
          const message = JSON.parse(data.toString())

          if (message.type === "register") {
            clients.set(clientId, { ws, username: message.username || "Anonymous" })
            console.log(`👤 Registered: ${message.username || "Anonymous"}`)
            ws.send(JSON.stringify({ type: "welcome", history }))
            return
          }

          if (message.type === "message") {
            const client = clients.get(clientId)
            const fullMessage: ChatMessage = {
              id: randomUUID(),
              timestamp: new Date().toISOString(),
              author: client?.username || message.author || "Anonymous",
              text: message.text,
              thread_id: message.thread_id,
            }

            await saveMessage(fullMessage)
            broadcast(fullMessage, clientId)
            console.log(`💬 ${fullMessage.author}: ${fullMessage.text.slice(0, 30)}...`)
          }
        } catch (e) {
          console.error("Failed to handle message:", e)
        }
      })

      ws.on("close", () => {
        const client = clients.get(clientId)
        if (client) {
          console.log(`👋 Disconnected: ${client.username}`)
          clients.delete(clientId)
        }
      })
    })

    console.log("\nPress Ctrl+C to stop the server")

    await new Promise(() => {})
  },
}

export default command