import { appendFile, readFile } from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"

export const CHAT_FILENAME = "chat.jsonl"

export interface ChatThread {
  id: string
  name: string
  created_at: string
}

export interface ChatMessage {
  id: string
  timestamp: string
  author: string
  text: string
  thread_id?: string
  metadata?: Record<string, unknown>
}

export type ChatTransport = {
  send?(message: ChatMessage): Promise<void>
  subscribe?(callback: (message: ChatMessage) => void): () => void
}

let activeTransport: ChatTransport = {}

export function setChatTransport(transport: ChatTransport) {
  activeTransport = transport
}

export function getChatTransport(): ChatTransport {
  return activeTransport
}

let wsClient: any = null
let wsSubscribers: ((message: ChatMessage) => void)[] = []
let reconnectAttempts = 0
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
let currentUsername = ""

export function getChatServerURL(): string | undefined {
  return process.env.CHAT_SERVER_URL || process.env.OPENCODE_CHAT_SERVER
}

function scheduleReconnect() {
  if (reconnectTimeout) return
  
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
  reconnectAttempts++
  
  console.log(`[Chat] Reconnecting in ${delay/1000}s (attempt ${reconnectAttempts})...`)
  
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null
    if (getChatServerURL()) {
      connectToChatServer(getChatServerURL()!, currentUsername)
    }
  }, delay)
}

export async function autoConnectChatServer(username: string): Promise<void> {
  const url = getChatServerURL()
  if (!url) {
    console.log("[Chat] Using local mode (no server URL)")
    return
  }
  currentUsername = username
  await connectToChatServer(url, username)
}

export async function connectToChatServer(url: string, username: string): Promise<void> {
  if (wsClient) {
    try { wsClient.close() } catch {}
  }
  
  reconnectAttempts = 0
  currentUsername = username
  
  try {
    const WebSocketModule = await import("ws")
    const WS = WebSocketModule.default || WebSocketModule.WebSocket
    wsClient = new WS(url)

    wsClient.on("open", () => {
      console.log("[Chat] ✓ Connected to server")
      reconnectAttempts = 0
      wsClient.send(JSON.stringify({ type: "register", username }))
    })

    wsClient.on("message", (data: any) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === "welcome") {
          console.log(`[Chat] ✓ Welcome! ${msg.history?.length || 0} messages loaded`)
        } else if (msg.id) {
          wsSubscribers.forEach((cb) => cb(msg))
        } else if (msg.type === "users") {
          console.log(`[Chat] ${msg.count} users online`)
        }
      } catch {}
    })

    wsClient.on("close", () => {
      console.log("[Chat] ✗ Disconnected from server")
      scheduleReconnect()
    })

    wsClient.on("error", (err: any) => {
      console.error("[Chat] ✗ Connection error:", err.message)
      scheduleReconnect()
    })
  } catch (e) {
    console.error("[Chat] ✗ Failed to connect:", e)
    scheduleReconnect()
  }
}

export function sendToChatServer(message: ChatMessage): void {
  if (wsClient && wsClient.readyState === 1) {
    wsClient.send(JSON.stringify({ type: "message", ...message }))
  }
}

export function subscribeToChat(callback: (message: ChatMessage) => void): () => void {
  wsSubscribers.push(callback)
  return () => {
    wsSubscribers = wsSubscribers.filter((cb) => cb !== callback)
  }
}

let defaultRootValue: string | undefined

export function setDefaultChatRoot(root: string) {
  defaultRootValue = root
}

function getDefaultRoot(): string | undefined {
  return defaultRootValue
}

export function chatFilePath(root: string) {
  return path.join(root, CHAT_FILENAME)
}

export async function readChatMessages(root: string): Promise<ChatMessage[]> {
  const filepath = chatFilePath(root)
  try {
    const content = await readFile(filepath, "utf-8")
    if (!content.trim()) return []
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as ChatMessage
        } catch {
          return null
        }
      })
      .filter((msg): msg is ChatMessage => msg !== null)
      .toSorted((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  } catch {
    return []
  }
}

export async function addChatMessage(
  root: string,
  text: string,
  author?: string,
  threadId?: string,
): Promise<ChatMessage> {
  const message: ChatMessage = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    author: author ?? process.env.USERNAME ?? process.env.USER ?? "user",
    text,
    thread_id: threadId,
  }

  const filepath = chatFilePath(root)
  await appendFile(filepath, JSON.stringify(message) + "\n")

  if (activeTransport.send) {
    await activeTransport.send(message)
  }

  return message
}

export async function getThreadMessages(root: string, threadId: string): Promise<ChatMessage[]> {
  const messages = await readChatMessages(root)
  return messages.filter((m) => m.thread_id === threadId)
}

const THREADS_FILENAME = "chat-threads.json"

function threadsFilePath(root: string) {
  return path.join(root, THREADS_FILENAME)
}

export async function readChatThreads(root: string): Promise<ChatThread[]> {
  const filepath = threadsFilePath(root)
  try {
    const content = await readFile(filepath, "utf-8")
    return JSON.parse(content) as ChatThread[]
  } catch {
    return []
  }
}

export async function createChatThread(root: string, name: string): Promise<ChatThread> {
  const threads = await readChatThreads(root)
  const thread: ChatThread = {
    id: randomUUID(),
    name,
    created_at: new Date().toISOString(),
  }
  threads.push(thread)
  const filepath = threadsFilePath(root)
  const { writeFile } = await import("fs/promises")
  await writeFile(filepath, JSON.stringify(threads, null, 2))
  return thread
}

export async function deleteChatMessage(root: string, messageId: string): Promise<boolean> {
  const messages = await readChatMessages(root)
  const filtered = messages.filter((m) => m.id !== messageId)
  if (filtered.length === messages.length) return false

  const lines = filtered.map((m) => JSON.stringify(m)).join("\n") + "\n"
  const { writeFile } = await import("fs/promises")
  await writeFile(chatFilePath(root), lines)
  return true
}

export function formatMessagePreview(message: ChatMessage, maxLength = 60): string {
  const firstLine = message.text.split("\n")[0]
  return firstLine.length > maxLength ? firstLine.slice(0, maxLength) + "..." : firstLine
}

export function formatMessageTime(timestamp: string): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 1) return "now"
  if (diffMins < 60) return `${diffMins}m`
  if (diffHours < 24) return `${diffHours}h`
  if (diffDays < 7) return `${diffDays}d`
  return date.toLocaleDateString()
}