import { createSignal, For, onMount, createEffect, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { useTerminalDimensions } from "@opentui/solid"
import {
  addChatMessage,
  readChatMessages,
  readChatThreads,
  createChatThread,
  autoConnectChatServer,
  type ChatMessage,
  type ChatThread,
} from "./prompt/chat"
import path from "path"
import { useKV } from "../context/kv"

function getMemoryRoot(project: ReturnType<typeof useProject>) {
  const root = project.instance.path().worktree || project.instance.path().directory
  return root ? path.join(root, ".vibe") : undefined
}

function getAuthor(sync: ReturnType<typeof useSync>) {
  return sync.data.console_state.activeOrgName || process.env.USERNAME || process.env.USER || "user"
}

function formatTime(timestamp: string): string {
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

export function ChatSidebar(props: { onClose: () => void }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const project = useProject()
  const sync = useSync()

  const [threads, setThreads] = createSignal<ChatThread[]>([])
  const [activeThread, setActiveThread] = createSignal<string | null>(null)
  const [messages, setMessages] = createSignal<ChatMessage[]>([])
  const [inputValue, setInputValue] = createSignal("")
  const [recipient, setRecipient] = createSignal<string | null>(null)
  const [showThreadInput, setShowThreadInput] = createSignal(false)
  const [newThreadName, setNewThreadName] = createSignal("")

  let inputRef: any = undefined

  const root = getMemoryRoot(project)
  const kv = useKV()
  const currentAuthor = () => (kv.get("chat_nickname") as string) || getAuthor(sync)

  const wide = () => dimensions().width > 120

  const loadThreads = async () => {
    if (!root) return
    const t = await readChatThreads(root)
    setThreads(t)
    if (t.length > 0 && !activeThread()) {
      setActiveThread(t[0].id)
    }
  }

  const loadMessages = async () => {
    if (!root) return
    const threadId = activeThread()
    const allMessages = await readChatMessages(root)
    if (threadId) {
      setMessages(allMessages.filter((m) => m.thread_id === threadId))
    } else {
      setMessages(allMessages.filter((m) => !m.thread_id).slice(-50))
    }
  }

  onMount(() => {
    loadThreads()
    loadMessages()
    autoConnectChatServer(currentAuthor())
    setTimeout(() => {
      if (inputRef) {
        try {
          inputRef.focus()
        } catch {}
      }
    }, 300)
  })

  createEffect(() => {
    activeThread()
    messages()
    requestAnimationFrame(() => {
      if (inputRef) {
        try {
          inputRef.focus()
        } catch {}
      }
    })
  })

  const handleCreateThread = async () => {
    const name = newThreadName().trim() || `Chat ${threads().length + 1}`
    if (!root) return
    const thread = await createChatThread(root, name)
    setThreads([...threads(), thread])
    setActiveThread(thread.id)
    setNewThreadName("")
    setShowThreadInput(false)
  }

  const handleSend = async () => {
    const text = inputValue().trim()
    if (!text || !root) return

    const to = recipient()
    const threadId = activeThread()
    await addChatMessage(root, text, currentAuthor(), threadId ? `thread:${threadId}` : (to ? `to:${to}` : undefined))
    setInputValue("")
    if (inputRef) {
      try {
        inputRef.clear()
      } catch {}
    }
    setRecipient(null)
    await loadMessages()
  }

  const handleSwitchThread = (threadId: string) => {
    setActiveThread(threadId)
    loadMessages()
  }

  return (
    <box
      position={wide() ? "relative" : "absolute"}
      right={0}
      top={0}
      width={42}
      height="100%"
      backgroundColor={theme.backgroundPanel}
      border-left={`1px ${theme.border}`}
    >
      <box height={3} paddingX={2} border-bottom={`1px ${theme.border}`} flexDirection="row" alignItems="center">
        <text fg={theme.primary}>💬 Chats</text>
        <box flexGrow={1} />
        <text fg={theme.accent}>+</text>
      </box>

      <Show when={showThreadInput()}>
        <box paddingX={2} paddingY={1} border-bottom={`1px ${theme.border}`}>
          <input
            value={newThreadName()}
            onInput={(val: string) => setNewThreadName(val)}
            placeholder="New chat name..."
          />
          <box flexDirection="row" gap={1} marginTop={1}>
            <text fg={theme.accent}>[Create]</text>
            <text fg={theme.textMuted}>[Cancel]</text>
          </box>
        </box>
      </Show>

      <Show when={threads().length > 0}>
        <box height={Math.min(threads().length + 1, 4)} overflow="scroll">
          <For each={threads()}>
            {(thread) => (
              <box
                paddingX={2}
                paddingY={1}
                backgroundColor={activeThread() === thread.id ? theme.backgroundElement : undefined}
              >
                <text fg={activeThread() === thread.id ? theme.accent : theme.text}>
                  {activeThread() === thread.id ? "▸" : " "} {thread.name}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>

      <Show when={threads().length === 0}>
        <box paddingX={2} paddingY={1}>
          <text fg={theme.textMuted}>No chats yet. Click + to create one.</text>
        </box>
      </Show>

      <box height={1} border-bottom={`1px ${theme.border}`} />

      {recipient() && (
        <box height={2} paddingX={2} border-bottom={`1px ${theme.border}`}>
          <text fg={theme.accent}>→ @{recipient()}</text>
        </box>
      )}

      <box height="100%" overflow="scroll" paddingX={2}>
        <For each={messages().slice(-50)}>
          {(msg) => (
            <box paddingY={1} flexDirection="column">
              <box flexDirection="row" gap={1}>
                <text fg={theme.primary}><b>{msg.author}</b></text>
                <text fg={theme.textMuted}>{formatTime(msg.timestamp)}</text>
              </box>
              <text fg={theme.text} marginLeft={0}>{msg.text}</text>
            </box>
          )}
        </For>
        {messages().length === 0 && (
          <box paddingY={2}>
            <text fg={theme.textMuted}>No messages in this chat.</text>
          </box>
        )}
      </box>

      <box
        height={10}
        paddingX={2}
        paddingY={2}
        border-top={`1px ${theme.border}`}
        justifyContent="center"
      >
        <box
          flexGrow={1}
          border={["left"]}
          borderColor={theme.accent}
          backgroundColor={theme.backgroundElement}
          paddingX={2}
          paddingY={1}
        >
          <textarea
            ref={(el: any) => {
              inputRef = el
            }}
            placeholder="Type a message..."
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            minHeight={1}
            maxHeight={5}
            onContentChange={() => {
              const value = inputRef?.plainText ?? ""
              setInputValue(value)
            }}
            onKeyDown={(e: any) => {
              if (e.key === "Enter") {
                handleSend()
              } else if (e.key === "Escape") {
                props.onClose()
              }
            }}
          />
        </box>
      </box>
      <box paddingX={2} paddingY={2}>
        <text fg={theme.textMuted}>Enter=send | Esc=close</text>
      </box>
    </box>
  )
}