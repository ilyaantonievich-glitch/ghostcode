import {
  BoxRenderable,
  RGBA,
  TextareaRenderable,
  MouseEvent,
  PasteEvent,
  decodePasteBytes,
  type KeyEvent,
  type Renderable,
} from "@opentui/core"
import type { CommandContext } from "@opentui/keymap"
import { createEffect, createMemo, onMount, createSignal, onCleanup, on, Show, Switch, Match } from "solid-js"
import "opentui-spinner/solid"
import path from "path"
import { fileURLToPath } from "url"
import { Filesystem } from "@/util/filesystem"
import { useLocal } from "@tui/context/local"
import { tint, useTheme } from "@tui/context/theme"
import { EmptyBorder, SplitBorder } from "@tui/component/border"
import { Spinner } from "@tui/component/spinner"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { useEvent } from "@tui/context/event"
import { editorSelectionKey, useEditorContext, type EditorSelection } from "@tui/context/editor"
import { MessageID, PartID } from "@/session/schema"
import { createStore, produce, unwrap } from "solid-js/store"
import { usePromptHistory, type PromptInfo } from "./history"
import { computePromptTraits } from "./traits"
import { assign } from "./part"
import { usePromptStash } from "./stash"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import * as Editor from "@tui/util/editor"
import { useExit } from "../../context/exit"
import * as Clipboard from "../../util/clipboard"
import type { AssistantMessage, FilePart, UserMessage } from "@opencode-ai/sdk/v2"
import { TuiEvent } from "../../event"
import { iife } from "@/util/iife"
import { Locale } from "@/util/locale"
import { formatDuration } from "@/util/format"
import { createColors, createFrames } from "../../ui/spinner.ts"
import { useDialog } from "@tui/ui/dialog"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogProvider as DialogProviderConnect } from "../dialog-provider"
import { DialogAlert } from "../../ui/dialog-alert"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv"
import { createFadeIn } from "../../util/signal"
import { DialogSkill } from "../dialog-skill"
import {
  confirmWorkspaceFileChanges,
  openWorkspaceSelect,
  warpWorkspaceSession,
  type WorkspaceSelection,
} from "../dialog-workspace-create"
import { DialogWorkspaceUnavailable } from "../dialog-workspace-unavailable"
import { useArgs } from "@tui/context/args"
import { Flag } from "@opencode-ai/core/flag/flag"
import { type WorkspaceStatus } from "../workspace-label"
import { useCommandPalette } from "../../context/command-palette"
import { useBindings, useCommandShortcut, useLeaderActive, useOpencodeKeymap } from "../../keymap"
import { useTuiConfig } from "../../context/tui-config"
import { appendFile, mkdir, readFile, readdir, writeFile } from "fs/promises"
import { buildAskPrompt, collectAskContext } from "./ask"
import {
  buildAgentPresetPrompt,
  createDefaultAgentPreset,
  deleteAgentPreset,
  ensureDefaultAgentPresets,
  formatAgentModelRef,
  normalizeAgentModelRef,
  readAgentPresets,
  upsertAgentPreset,
  VIBE_AGENTS,
  type AgentPreset,
} from "./agents"
import { buildDebatePrompt, loadDebateAgents } from "./agents-debate"
import {
  collectContextItems,
  contextConfigPath,
  excludePath,
  explainContextSources,
  includePath,
  pinPath,
  readContextConfig,
  unpinPath,
  type ContextItem,
} from "./context-inspector"

const VIBE_DIRNAME = ".vibe"
const VIBE_MEMORY = "memory.md"
const VIBE_RULES = "rules.md"
const VIBE_DECISIONS = "decisions.md"
const VIBE_CONTEXT = "context.md"
const VIBE_REPO_MAP = "repo-map.md"

const VIBE_DEFAULTS = {
  [VIBE_MEMORY]: "# Memory\n",
  [VIBE_RULES]: "# Rules\n",
  [VIBE_DECISIONS]: "# Decisions\n",
  [VIBE_CONTEXT]: "# Context\n",
} as const

const MEMORY_SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)\b\s*[:=]/i,
  /\b(?:ghp|gho|ghu|github_pat|sk-[A-Za-z0-9]|xox[baprs]-|AIzaSy)[A-Za-z0-9_\-]{10,}/,
  /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*\b\s*[:=]/,
] as const

const REPO_MAP_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "dist",
  "build",
  ".next",
  "target",
  "vendor",
  "coverage",
  ".cache",
  ".turbo",
  ".pnpm-store",
  ".yarn",
])

const REPO_MAP_STRUCTURE_LIMIT = 200

const REPO_MAP_DEPENDENCY_FILES = [
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "build.gradle",
  "build.gradle.kts",
  "pom.xml",
  "composer.json",
]

function detectMemorySecrets(text: string) {
  return MEMORY_SECRET_PATTERNS.some((pattern) => pattern.test(text))
}

function repoMapPackageManager(files: Set<string>) {
  if (files.has("bun.lock") || files.has("bun.lockb")) return "bun"
  if (files.has("pnpm-lock.yaml")) return "pnpm"
  if (files.has("yarn.lock")) return "yarn"
  if (files.has("package-lock.json")) return "npm"
}

function repoMapEcosystems(files: Set<string>) {
  return [
    ...(files.has("package.json") ? ["Node.js"] : []),
    ...(files.has("pyproject.toml") || files.has("requirements.txt") ? ["Python"] : []),
    ...(files.has("go.mod") ? ["Go"] : []),
    ...(files.has("Cargo.toml") ? ["Rust"] : []),
    ...(files.has("Gemfile") ? ["Ruby"] : []),
    ...(files.has("build.gradle") || files.has("build.gradle.kts") || files.has("pom.xml") ? ["Java/Kotlin"] : []),
    ...(files.has("composer.json") ? ["PHP"] : []),
  ]
}

function repoMapCommonEntrypoints(files: Set<string>) {
  return [
    "index.ts",
    "index.tsx",
    "index.js",
    "index.mjs",
    "main.ts",
    "main.js",
    "src/index.ts",
    "src/index.tsx",
    "src/index.js",
    "src/main.ts",
    "src/main.js",
  ].filter((file) => files.has(file))
}

function filterRepoMap(content: string, topic: string) {
  const needle = topic.trim().toLowerCase()
  if (!needle) return content
  const lines = content.split(/\r?\n/)
  const matches = lines.filter((line) => line.toLowerCase().includes(needle))
  if (matches.length === 0) return `No repo map entries found for \"${topic}\".`
  return [`Repo map matches for: ${topic}`, "", ...matches.slice(0, 60)].join("\n")
}

function formatDecisionLine(text: string, author?: string) {
  const authorLabel = author?.trim() ? ` [${author.trim()}]` : ""
  return `- [${new Date().toISOString()}]${authorLabel} ${text.trim()}\n`
}

function currentDecisionAuthor(sync: ReturnType<typeof useSync>) {
  return sync.data.console_state.activeOrgName || process.env.USERNAME || process.env.USER || undefined
}

function getMemoryRoot(project: ReturnType<typeof useProject>) {
  const root = project.instance.path().worktree || project.instance.path().directory
  return root ? path.join(root, VIBE_DIRNAME) : undefined
}

async function ensureMemoryFiles(root: string) {
  await mkdir(root, { recursive: true })
  await Promise.all(
    Object.entries(VIBE_DEFAULTS).map(async ([name, content]) => {
      const filepath = path.join(root, name)
      if (await Filesystem.exists(filepath)) return
      await writeFile(filepath, content)
    }),
  )
}

async function readMemoryFiles(root: string) {
  await ensureMemoryFiles(root)
  const entries = await Promise.all(
    Object.keys(VIBE_DEFAULTS).map(async (name) => [name, await readFile(path.join(root, name), "utf-8")] as const),
  )
  return Object.fromEntries(entries) as Record<keyof typeof VIBE_DEFAULTS, string>
}

async function buildRepoMap(projectRoot: string, depth = 3) {
  const normalizedDepth = depth < 1 || depth > 6 ? 3 : depth
  const entries = await readdir(projectRoot, { withFileTypes: true }).catch(() => [])
  const topLevel = new Set(entries.map((entry) => entry.name))
  const dependencyFiles = REPO_MAP_DEPENDENCY_FILES.filter((file) => topLevel.has(file))
  const packageJson = topLevel.has("package.json")
    ? await readFile(path.join(projectRoot, "package.json"), "utf-8")
        .then((content) => JSON.parse(content) as Record<string, unknown>)
        .catch(() => ({} as Record<string, unknown>))
    : {}

  const entrypoints = [
    ...(typeof packageJson.main === "string" ? [`main: ${packageJson.main}`] : []),
    ...(typeof packageJson.module === "string" ? [`module: ${packageJson.module}`] : []),
    ...(typeof packageJson.types === "string" ? [`types: ${packageJson.types}`] : []),
    ...(typeof packageJson.bin === "string" ? [`bin: ${packageJson.bin}`] : []),
    ...(packageJson.bin && typeof packageJson.bin === "object" && !Array.isArray(packageJson.bin)
      ? Object.keys(packageJson.bin as Record<string, unknown>).map((name) => `bin: ${name}`)
      : []),
    ...(packageJson.exports && typeof packageJson.exports === "object" && !Array.isArray(packageJson.exports)
      ? Object.keys(packageJson.exports as Record<string, unknown>)
          .slice(0, 10)
          .map((name) => `exports: ${name}`)
      : []),
  ]

  const lines: string[] = []
  let truncated = false

  async function visit(dir: string, level: number): Promise<void> {
    if (level >= normalizedDepth || lines.length >= REPO_MAP_STRUCTURE_LIMIT) {
      truncated = truncated || lines.length >= REPO_MAP_STRUCTURE_LIMIT
      return
    }

    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const resolved = await Promise.all(
      entries.map(async (entry) => {
        if (REPO_MAP_IGNORED_DIRS.has(entry.name)) return undefined
        if (entry.name.endsWith(".lock") || entry.name.endsWith(".cache")) return undefined
        const full = path.join(dir, entry.name)
        return { name: entry.name, full, directory: entry.isDirectory() }
      }),
    )

    const sorted = resolved
      .filter((item): item is { name: string; full: string; directory: boolean } => Boolean(item))
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))

    for (const entry of sorted) {
      if (lines.length >= REPO_MAP_STRUCTURE_LIMIT) {
        truncated = true
        return
      }
      lines.push(`${"  ".repeat(level)}${entry.name}${entry.directory ? "/" : ""}`)
      if (entry.directory) await visit(entry.full, level + 1)
    }
  }

  await visit(projectRoot, 0)

  const commonEntrypoints = repoMapCommonEntrypoints(
    new Set([
      ...topLevel,
      ...(topLevel.has("src") ? ["src/index.ts", "src/index.tsx", "src/index.js", "src/main.ts", "src/main.js"] : []),
    ]),
  )

  return [
    "# Repo Map",
    "",
    `Path: ${projectRoot}`,
    `Generated: ${new Date().toISOString()}`,
    `Depth: ${normalizedDepth}`,
    ...(repoMapEcosystems(topLevel).length ? [`Ecosystems: ${repoMapEcosystems(topLevel).join(", ")}`] : []),
    ...(repoMapPackageManager(topLevel) ? [`Package manager: ${repoMapPackageManager(topLevel)}`] : []),
    ...(dependencyFiles.length ? [`Dependency files: ${dependencyFiles.join(", ")}`] : []),
    ...([...entrypoints, ...commonEntrypoints.map((file) => `file: ${file}`)].length
      ? ["Likely entrypoints:", ...[...entrypoints, ...commonEntrypoints.map((file) => `file: ${file}`)].map((entry) => `- ${entry}`)]
      : []),
    "Top-level structure:",
    ...lines,
    ...(truncated ? ["(Structure truncated)"] : []),
  ].join("\n")
}

async function readRepoMap(root: string) {
  return readFile(path.join(root, VIBE_REPO_MAP), "utf-8")
}

function formatMemorySnapshot(root: string, files: Record<keyof typeof VIBE_DEFAULTS, string>) {
  return [
    `Project memory directory: ${root}`,
    "",
    `## ${VIBE_RULES}`,
    files[VIBE_RULES].trim() || "# Rules",
    "",
    `## ${VIBE_CONTEXT}`,
    files[VIBE_CONTEXT].trim() || "# Context",
    "",
    `## ${VIBE_MEMORY}`,
    files[VIBE_MEMORY].trim() || "# Memory",
    "",
    `## ${VIBE_DECISIONS}`,
    files[VIBE_DECISIONS].trim() || "# Decisions",
  ].join("\n")
}

function searchMemory(files: Record<keyof typeof VIBE_DEFAULTS, string>, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return [] as string[]
  return Object.entries(files).flatMap(([name, content]) =>
    content
      .split(/\r?\n/)
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.toLowerCase().includes(needle))
      .map((entry) => `${name}:${entry.index + 1}: ${entry.line}`),
  )
}

function parseRules(content: string) {
  const recognized: Array<{
    kind: "do_not_edit" | "ask_before_edit" | "prefer" | "avoid"
    value: string
    line: number
    raw: string
  }> = []
  const invalid: Array<{ line: number; raw: string }> = []

  for (const [index, original] of content.split(/\r?\n/).entries()) {
    const line = original.trim()
    if (!line || line.startsWith("#")) continue

    let match = line.match(/^DO NOT EDIT\s+(.+)$/i)
    if (match) {
      recognized.push({ kind: "do_not_edit", value: match[1].trim(), line: index + 1, raw: original })
      continue
    }
    match = line.match(/^ASK BEFORE EDIT\s+(.+)$/i)
    if (match) {
      recognized.push({ kind: "ask_before_edit", value: match[1].trim(), line: index + 1, raw: original })
      continue
    }
    match = line.match(/^PREFER\s+(.+)$/i)
    if (match) {
      recognized.push({ kind: "prefer", value: match[1].trim(), line: index + 1, raw: original })
      continue
    }
    match = line.match(/^AVOID\s+(.+)$/i)
    if (match) {
      recognized.push({ kind: "avoid", value: match[1].trim(), line: index + 1, raw: original })
      continue
    }

    invalid.push({ line: index + 1, raw: original })
  }

  return { recognized, invalid }
}

function formatRulesSnapshot(root: string, rules: string) {
  return [`Project rules file: ${path.join(root, VIBE_RULES)}`, "", rules.trim() || "# Rules"].join("\n")
}

function formatRulesCheck(content: string) {
  const parsed = parseRules(content)
  const pathRules = parsed.recognized.filter((item) => item.kind === "do_not_edit" || item.kind === "ask_before_edit")
  const techRules = parsed.recognized.filter((item) => item.kind === "prefer" || item.kind === "avoid")
  const lines = [
    `Recognized rules: ${parsed.recognized.length}`,
    `Path rules: ${pathRules.length}`,
    `Technology rules: ${techRules.length}`,
    `Invalid lines: ${parsed.invalid.length}`,
  ]
  if (parsed.invalid.length) {
    lines.push("")
    lines.push(...parsed.invalid.slice(0, 8).map((item) => `line ${item.line}: ${item.raw.trim() || "<empty>"}`))
  }
  return { parsed, text: lines.join("\n") }
}

function formatAgentPresetList(presets: AgentPreset[]) {
  if (presets.length === 0) return `No agent presets found in ${path.join(VIBE_DIRNAME, VIBE_AGENTS)}`
  return presets
    .map((preset) => {
      const model = formatAgentModelRef(preset) ?? "default model"
      return `- ${preset.name}: ${preset.description || "No description"} (${model})`
    })
    .join("\n")
}

async function resolveAgentPreset(root: string, name: string) {
  const presets = await readAgentPresets(root)
  return presets.find((item) => item.name === name)
}

async function forgetMemory(root: string, files: Record<keyof typeof VIBE_DEFAULTS, string>, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return 0
  let removed = 0
  for (const name of [VIBE_MEMORY, VIBE_CONTEXT, VIBE_DECISIONS] as const) {
    const lines = files[name].split(/\r?\n/)
    const kept = lines.filter((line) => {
      const match = line.replace(/^[-*]\s+/, "").trim().toLowerCase().includes(needle)
      if (match) removed += 1
      return !match
    })
    await writeFile(path.join(root, name), `${kept.join("\n").replace(/\n{3,}/g, "\n\n")}\n`)
  }
  return removed
}

export type PromptProps = {
  sessionID?: string
  workspaceID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  bottom?: JSX.Element
  showPlaceholder?: boolean
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const DRAFT_RETENTION_MIN_CHARS = 20

function randomIndex(count: number) {
  if (count <= 0) return 0
  return Math.floor(Math.random() * count)
}

function fadeColor(color: RGBA, alpha: number) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * alpha)
}

function hasEditorRangeSelection(selection: EditorSelection["ranges"][number]) {
  return (
    selection.selection.start.line !== selection.selection.end.line ||
    selection.selection.start.character !== selection.selection.end.character
  )
}

function getEditorRangeLabel(selection: EditorSelection["ranges"][number]) {
  if (!hasEditorRangeSelection(selection)) return
  if (selection.selection.start.line === selection.selection.end.line) return `#${selection.selection.start.line}`
  return `#${selection.selection.start.line}-${selection.selection.end.line}`
}

function formatEditorContext(selection: EditorSelection) {
  const selected = selection.ranges.filter(hasEditorRangeSelection)
  if (selected.length === 0)
    return `<system-reminder>Note: The user opened the file "${selection.filePath}". This may or may not be relevant to the current task.</system-reminder>\n`

  const ranges = selected.map((range, index) => {
    const prefix = selected.length > 1 ? `Selection ${index + 1}: ` : ""
    return `Note: The user selected ${prefix}${getEditorRangeLabel(range)} from "${selection.filePath}". \`\`\`${range.text}\`\`\`\n\n`
  })

  return `<system-reminder>${ranges.join("\n")} This may or may not be relevant to the current task.</system-reminder>\n`
}

function parseSlashInput(input: string) {
  const firstLine = input.split("\n")[0] ?? ""
  const [token, ...firstLineArgs] = firstLine.split(" ")
  const name = token.startsWith("/") ? token.slice(1) : ""
  const restOfInput = input.includes("\n") ? input.slice(input.indexOf("\n") + 1) : ""
  const argumentsText = firstLineArgs.join(" ") + (restOfInput ? "\n" + restOfInput : "")
  return {
    firstLine,
    name,
    argumentsText,
  }
}

function normalizeSlashAlias(value: string) {
  return value.startsWith("/") ? value.slice(1) : value
}

function isExactSlashCommand(input: string) {
  return /^\/[A-Za-z0-9._-]+$/.test(input.trim())
}

let stashed: { prompt: PromptInfo; cursor: number } | undefined

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  const [inputTarget, setInputTarget] = createSignal<TextareaRenderable | undefined>()

  const leader = useLeaderActive()
  const local = useLocal()
  const args = useArgs()
  const sdk = useSDK()
  const editor = useEditorContext()
  const route = useRoute()
  const project = useProject()
  const sync = useSync()
  const tuiConfig = useTuiConfig()
  const keymapConfig = tuiConfig.keymap
  const dialog = useDialog()
  const toast = useToast()
  const status = createMemo(() => sync.data.session_status?.[props.sessionID ?? ""] ?? { type: "idle" })
  const history = usePromptHistory()
  const stash = usePromptStash()
  const command = useCommandPalette()
  const keymap = useOpencodeKeymap()
  const agentShortcut = useCommandShortcut("agent.cycle")
  const paletteShortcut = useCommandShortcut("command.palette.show")
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const { theme, syntax } = useTheme()
  const kv = useKV()
  const animationsEnabled = createMemo(() => kv.get("animations_enabled", true))
  const list = createMemo(() => props.placeholders?.normal ?? [])
  const shell = createMemo(() => props.placeholders?.shell ?? [])
  const fileContextEnabled = createMemo(() => kv.get("file_context_enabled", true))
  const [dismissedEditorSelectionKey, setDismissedEditorSelectionKey] = createSignal<string>()
  const editorContext = createMemo(() => {
    const selection = fileContextEnabled() ? editor.selection() : undefined
    if (!selection) return
    return editorSelectionKey(selection) === dismissedEditorSelectionKey() ? undefined : selection
  })
  const editorPath = createMemo(() => editorContext()?.filePath)
  const editorSelectionLabel = createMemo(() => {
    const ranges = editorContext()?.ranges
    if (!ranges) return
    const first = ranges.find(hasEditorRangeSelection) ?? ranges[0]
    if (!first) return
    return [getEditorRangeLabel(first), ranges.length > 1 ? `+${ranges.length - 1}` : undefined]
      .filter(Boolean)
      .join(" ")
  })
  const editorFileLabel = createMemo(() => {
    const value = editorPath()
    if (!value) return
    const filename = path.basename(value)
    const file = /^index\.[^./]+$/.test(filename)
      ? [path.basename(path.dirname(value)), filename].filter(Boolean).join("/")
      : filename
    return `${file.split(path.sep).join("/")}${editorSelectionLabel() ?? ""}`
  })
  const editorFileLabelDisplay = createMemo(() => {
    const file = editorFileLabel()
    if (!file) return
    return Locale.truncateMiddle(file, Math.max(12, Math.min(48, Math.floor(dimensions().width / 3))))
  })
  const editorContextLabelState = createMemo(() => editor.labelState())
  const [auto, setAuto] = createSignal<AutocompleteRef>()
  const [workspaceSelection, setWorkspaceSelection] = createSignal<WorkspaceSelection>()
  const [workspaceCreating, setWorkspaceCreating] = createSignal(false)
  const [workspaceCreatingDots, setWorkspaceCreatingDots] = createSignal(3)
  const [warpNotice, setWarpNotice] = createSignal<string>()
  const [cursorVersion, setCursorVersion] = createSignal(0)
  const currentProviderLabel = createMemo(() => local.model.parsed().provider)
  const hasRightContent = createMemo(() => Boolean(props.right))
  const defaultWorkspaceID = createMemo(() => props.workspaceID ?? project.workspace.current())

  async function handleMemoryCommand(input: string) {
    const root = getMemoryRoot(project)
    if (!root) {
      toast.show({ message: "Project path unavailable for memory", variant: "error" })
      return completeLocalCommand()
    }

    const trimmed = input.trim()
    const parts = trimmed.split(/\s+/)
    if (parts[0] !== "/memory") return false

    const action = parts[1] ?? "show"
    const query = trimmed.split(/\s+/, 3)[2]?.trim() ?? ""
    const files = await readMemoryFiles(root)

    if (action === "show") {
      toast.show({ message: formatMemorySnapshot(root, files), variant: "success", duration: 5000 })
      return completeLocalCommand()
    }

    if (action === "search") {
      const matches = searchMemory(files, query)
      toast.show({
        message: matches.length ? matches.slice(0, 12).join("\n") : `No memory entries found for \"${query}\"`,
        variant: matches.length ? "success" : "warning",
        duration: 5000,
      })
      return completeLocalCommand()
    }

    if (action === "forget") {
      const removed = await forgetMemory(root, files, query)
      toast.show({
        message: removed > 0 ? `Removed ${removed} matching memory line(s)` : `No memory entries found for \"${query}\"`,
        variant: removed > 0 ? "success" : "warning",
        duration: 4000,
      })
      return completeLocalCommand()
    }

    if (action === "add") {
      if (!query) {
        toast.show({ message: "Usage: /memory add <text>", variant: "warning" })
        return completeLocalCommand()
      }
      if (detectMemorySecrets(query)) {
        const confirmed = await DialogConfirm.show(
          dialog,
          "Store sensitive memory?",
          "This looks like it may contain a secret. Save it to .vibe/memory.md anyway?",
          "cancel",
        )
        if (confirmed !== true) return true
      }
      await appendFile(path.join(root, VIBE_MEMORY), `- [${new Date().toISOString()}] ${query}\n`)
      toast.show({
        message: `Saved memory in ${path.join(VIBE_DIRNAME, VIBE_MEMORY)}`,
        variant: "success",
        duration: 4000,
      })
      return completeLocalCommand()
    }

    toast.show({ message: "Usage: /memory show|add|search|forget", variant: "warning", duration: 4000 })
    return completeLocalCommand()
  }

  async function handleDecisionCommand(input: string) {
    const root = getMemoryRoot(project)
    if (!root) {
      toast.show({ message: "Project path unavailable for decisions", variant: "error" })
      return completeLocalCommand()
    }

    await ensureMemoryFiles(root)
    const trimmed = input.trim()

    if (trimmed === "/decisions") {
      const files = await readMemoryFiles(root)
      const entries = files[VIBE_DECISIONS]
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .slice(-8)

      toast.show({
        message: entries.length ? entries.join("\n") : `No decisions recorded in ${path.join(VIBE_DIRNAME, VIBE_DECISIONS)}`,
        variant: entries.length ? "success" : "warning",
        duration: 5000,
      })
      return completeLocalCommand()
    }

    if (!trimmed.startsWith("/decide")) return false
    const text = trimmed.slice("/decide".length).trim().replace(/^['"]|['"]$/g, "")
    if (!text) {
      toast.show({ message: "Usage: /decide <text>", variant: "warning", duration: 4000 })
      return completeLocalCommand()
    }

    if (detectMemorySecrets(text)) {
      const confirmed = await DialogConfirm.show(
        dialog,
        "Store sensitive decision?",
        "This looks like it may contain a secret. Save it to .vibe/decisions.md anyway?",
        "cancel",
      )
      if (confirmed !== true) return true
    }

    const author = currentDecisionAuthor(sync)
    await appendFile(path.join(root, VIBE_DECISIONS), formatDecisionLine(text, author))
    toast.show({
      message: `Saved decision in ${path.join(VIBE_DIRNAME, VIBE_DECISIONS)}`,
      variant: "success",
      duration: 4000,
    })
    return completeLocalCommand()
  }

  async function handleRulesCommand(input: string) {
    const root = getMemoryRoot(project)
    if (!root) {
      toast.show({ message: "Project path unavailable for rules", variant: "error" })
      return completeLocalCommand()
    }

    const trimmed = input.trim()
    const parts = trimmed.split(/\s+/)
    if (parts[0] !== "/rules") return false

    await ensureMemoryFiles(root)
    const action = parts[1] ?? "show"
    const text = trimmed.split(/\s+/, 3)[2]?.trim().replace(/^['"]|['"]$/g, "") ?? ""

    if (action === "show") {
      const files = await readMemoryFiles(root)
      toast.show({ message: formatRulesSnapshot(root, files[VIBE_RULES]), variant: "success", duration: 5000 })
      return completeLocalCommand()
    }

    if (action === "add") {
      if (!text) {
        toast.show({ message: "Usage: /rules add <rule>", variant: "warning", duration: 4000 })
        return completeLocalCommand()
      }
      const { recognized, invalid } = parseRules(text)
      if (recognized.length === 0 || invalid.length > 0) {
        toast.show({
          message: "Rule must match DO NOT EDIT <path>, ASK BEFORE EDIT <path>, PREFER <technology>, or AVOID <technology>",
          variant: "warning",
          duration: 5000,
        })
        return completeLocalCommand()
      }
      await appendFile(path.join(root, VIBE_RULES), `${text}\n`)
      toast.show({
        message: `Saved rule in ${path.join(VIBE_DIRNAME, VIBE_RULES)}`,
        variant: "success",
        duration: 4000,
      })
      return completeLocalCommand()
    }

    if (action === "check") {
      const files = await readMemoryFiles(root)
      const summary = formatRulesCheck(files[VIBE_RULES])
      toast.show({
        message: summary.text,
        variant: summary.parsed.invalid.length ? "warning" : "success",
        duration: 5000,
      })
      return completeLocalCommand()
    }

    toast.show({ message: "Usage: /rules show|add|check", variant: "warning", duration: 4000 })
    return completeLocalCommand()
  }

  async function handleMapCommand(input: string) {
    const root = getMemoryRoot(project)
    if (!root) {
      toast.show({ message: "Project path unavailable for repo map", variant: "error" })
      return completeLocalCommand()
    }

    await ensureMemoryFiles(root)
    const projectRoot = path.dirname(root)
    const trimmed = input.trim()
    if (!trimmed.startsWith("/map")) return false

    const rest = trimmed.slice("/map".length).trim()
    const filepath = path.join(root, VIBE_REPO_MAP)

    if (!rest) {
      const content = (await Filesystem.exists(filepath)) ? await readRepoMap(root) : await buildRepoMap(projectRoot)
      if (!(await Filesystem.exists(filepath))) await writeFile(filepath, content)
      toast.show({ message: content, variant: "success", duration: 5000 })
      return completeLocalCommand()
    }

    if (rest === "refresh") {
      const content = await buildRepoMap(projectRoot)
      await writeFile(filepath, content)
      toast.show({ message: content, variant: "success", duration: 5000 })
      return completeLocalCommand()
    }

    const content = await buildRepoMap(projectRoot)
    await writeFile(filepath, content)
    toast.show({ message: filterRepoMap(content, rest), variant: "success", duration: 5000 })
    return completeLocalCommand()
  }

  async function prepareAskPrompt(input: string) {
    const root = getMemoryRoot(project)
    if (!root) {
      toast.show({ message: "Project path unavailable for repo questions", variant: "error" })
      return { handled: true as const, prompt: undefined }
    }

    const question = input.slice("/ask".length).trim()
    if (!question) {
      toast.show({ message: "Usage: /ask <question>", variant: "warning", duration: 4000 })
      return { handled: true as const, prompt: undefined }
    }

    await ensureMemoryFiles(root)
    const projectRoot = path.dirname(root)
    const repoMapPath = path.join(root, VIBE_REPO_MAP)
    const repoMap = (await Filesystem.exists(repoMapPath)) ? await readRepoMap(root) : await buildRepoMap(projectRoot)
    if (!(await Filesystem.exists(repoMapPath))) await writeFile(repoMapPath, repoMap)

    const askContext = await collectAskContext({
      projectRoot,
      question,
      repoMap,
    })

    if (askContext.insufficient) {
      toast.show({
        message: "Repo evidence is limited for this question. I will answer conservatively.",
        variant: "warning",
        duration: 3000,
      })
    }

    return {
      handled: false as const,
      prompt: buildAskPrompt(question, askContext),
    }
  }

  async function handleAgentCommand(input: string) {
    const root = getMemoryRoot(project)
    if (!root) {
      toast.show({ message: "Project path unavailable for agent presets", variant: "error" })
      return completeLocalCommand()
    }

    await ensureMemoryFiles(root)
    const trimmed = input.trim()
    const parts = trimmed.split(/\s+/)
    if (parts[0] !== "/agent") return false

    const action = parts[1] ?? "list"
    const name = parts[2]?.trim()
    const rest = trimmed.split(/\s+/, 4)[3]?.trim().replace(/^['"]|['"]$/g, "") ?? ""

    if (action === "list") {
      const presets = await ensureDefaultAgentPresets(root)
      toast.show({ message: formatAgentPresetList(presets), variant: "success", duration: 5000 })
      return completeLocalCommand()
    }

    if (action === "create") {
      if (!name) {
        toast.show({ message: "Usage: /agent create <name>", variant: "warning", duration: 4000 })
        return completeLocalCommand()
      }
      const preset = createDefaultAgentPreset(name)
      await upsertAgentPreset(root, preset)
      toast.show({ message: `Saved agent preset ${name} in ${path.join(VIBE_DIRNAME, VIBE_AGENTS)}`, variant: "success", duration: 4000 })
      return completeLocalCommand()
    }

    if (action === "delete") {
      if (!name) {
        toast.show({ message: "Usage: /agent delete <name>", variant: "warning", duration: 4000 })
        return completeLocalCommand()
      }
      const deleted = await deleteAgentPreset(root, name)
      toast.show({
        message: deleted ? `Deleted agent preset ${name}` : `Agent preset not found: ${name}`,
        variant: deleted ? "success" : "warning",
        duration: 4000,
      })
      return completeLocalCommand()
    }

    if (action === "model") {
      if (!name || !rest) {
        toast.show({ message: "Usage: /agent model <name> <provider:model>", variant: "warning", duration: 4000 })
        return completeLocalCommand()
      }
      const existing = (await resolveAgentPreset(root, name)) ?? createDefaultAgentPreset(name)
      const parsed = normalizeAgentModelRef(rest)
      if (!parsed) {
        toast.show({ message: "Model must match provider:model", variant: "warning", duration: 4000 })
        return completeLocalCommand()
      }
      await upsertAgentPreset(root, {
        ...existing,
        provider: parsed.provider,
        model: parsed.model,
      })
      toast.show({ message: `Updated model for ${name} to ${parsed.provider}:${parsed.model}`, variant: "success", duration: 4000 })
      return completeLocalCommand()
    }

    if (action === "prompt") {
      if (!name) {
        toast.show({ message: "Usage: /agent prompt <name>", variant: "warning", duration: 4000 })
        return completeLocalCommand()
      }
      const promptText = trimmed.split(/\s+/, 4)[3] ?? ""
      if (!promptText.trim()) {
        const existing = await resolveAgentPreset(root, name)
        toast.show({
          message: existing?.system_prompt ?? `Agent preset not found: ${name}`,
          variant: existing ? "success" : "warning",
          duration: 5000,
        })
        return completeLocalCommand()
      }
      const existing = (await resolveAgentPreset(root, name)) ?? createDefaultAgentPreset(name)
      await upsertAgentPreset(root, {
        ...existing,
        system_prompt: promptText.trim(),
      })
      toast.show({ message: `Updated prompt for ${name}`, variant: "success", duration: 4000 })
      return completeLocalCommand()
    }

toast.show({ message: "Usage: /agent create|model|prompt|list|delete", variant: "warning", duration: 4000 })
    return completeLocalCommand()
  }

  async function handleDebateCommand(input: string) {
    return false
  }

  async function prepareAgentAliasPrompt(input: string) {
    const root = getMemoryRoot(project)
    if (!root) return { handled: false as const, prompt: undefined, modelOverride: undefined }

    const trimmed = input.trim()
    const { name, argumentsText } = parseSlashInput(trimmed)
    if (!name) return { handled: false as const, prompt: undefined, modelOverride: undefined }

    const presets = await ensureDefaultAgentPresets(root)
    const preset = presets.find((item) => item.name === name)
    if (!preset) return { handled: false as const, prompt: undefined, modelOverride: undefined }

    const userText = argumentsText.trim()
    if (!userText) {
      toast.show({ message: `Usage: /${name} <prompt>`, variant: "warning", duration: 4000 })
      return { handled: true as const, prompt: undefined, modelOverride: undefined }
    }

return {
      handled: false as const,
      prompt: buildAgentPresetPrompt(userText, preset),
      modelOverride: formatAgentModelRef(preset),
    }
  }

  async function prepareDebatePrompt(input: string) {
    const root = getMemoryRoot(project)
    if (!root) {
      toast.show({ message: "Project path unavailable for agent debate", variant: "error" })
      return { handled: true as const, prompt: undefined }
    }

    const question = input.slice("/agents debate".length).trim()
    if (!question) {
      toast.show({ message: "Usage: /agents debate <question>", variant: "warning", duration: 4000 })
      return { handled: true as const, prompt: undefined }
    }

    const agents = await loadDebateAgents(root, question)
    if (agents.length === 0) {
      toast.show({
        message: "No agent presets found. Run /agent create to add presets, or ensure .vibe/agents.yaml exists.",
        variant: "warning",
        duration: 5000,
      })
      return { handled: true as const, prompt: undefined }
    }

    toast.show({
      message: `Running debate with ${agents.map((a) => a.preset.name).join(", ")}...\n\nUse /decide to save the outcome when ready.`,
      variant: "info",
      duration: 5000,
    })

    return {
      handled: false as const,
      prompt: buildDebatePrompt(question, agents),
    }
  }

  async function handleContextCommand(input: string) {
    const root = getMemoryRoot(project)
    if (!root) {
      toast.show({ message: "Project path unavailable for context", variant: "error" })
      return completeLocalCommand()
    }

    const trimmed = input.trim()
    const parts = trimmed.split(/\s+/)
    if (parts[0] !== "/context") return false

    const action = parts[1] ?? "show"
    const targetPath = parts.slice(2).join(" ").trim().replace(/^['"]|['"]$/g, "") ?? ""

    if (action === "show") {
      const projectRoot = path.dirname(root)
      const items = await collectContextItems(root, projectRoot)
      const lines = ["## AI Context Items", ""]

      for (const item of items) {
        const truncatedNote = item.truncated ? " [TRUNCATED]" : ""
        lines.push(`### ${item.source}: ${item.path}`)
        lines.push(`Size: ${item.size} bytes${truncatedNote}`)
        if (item.preview) {
          lines.push("```")
          lines.push(item.preview.slice(0, 300))
          lines.push("```")
        }
        lines.push("")
      }

      if (items.length === 0) {
        lines.push("No context items found. Add memory with /memory add or create .vibe/context.md")
      }

      toast.show({ message: lines.join("\n"), variant: "success", duration: 7000 })
      return completeLocalCommand()
    }

    if (action === "why") {
      const reasons = explainContextSources()
      toast.show({
        message: ["## AI Context Sources", "", ...reasons, "", "Tip: Use /context pin <path> to always include a file"].join("\n"),
        variant: "info",
        duration: 6000,
      })
      return completeLocalCommand()
    }

    if (action === "pin") {
      if (!targetPath) {
        toast.show({ message: "Usage: /context pin <path>", variant: "warning", duration: 4000 })
        return completeLocalCommand()
      }
      await pinPath(root, targetPath)
      toast.show({ message: `Pinned ${targetPath} — will always be in AI context`, variant: "success", duration: 4000 })
      return completeLocalCommand()
    }

    if (action === "unpin") {
      if (!targetPath) {
        toast.show({ message: "Usage: /context unpin <path>", variant: "warning", duration: 4000 })
        return completeLocalCommand()
      }
      await unpinPath(root, targetPath)
      toast.show({ message: `Unpinned ${targetPath}`, variant: "success", duration: 4000 })
      return completeLocalCommand()
    }

    if (action === "exclude") {
      if (!targetPath) {
        toast.show({ message: "Usage: /context exclude <path>", variant: "warning", duration: 4000 })
        return completeLocalCommand()
      }
      await excludePath(root, targetPath)
      toast.show({ message: `Excluded ${targetPath} — will not appear in AI context`, variant: "success", duration: 4000 })
      return completeLocalCommand()
    }

    if (action === "include") {
      if (!targetPath) {
        toast.show({ message: "Usage: /context include <path>", variant: "warning", duration: 4000 })
        return completeLocalCommand()
      }
      await includePath(root, targetPath)
      toast.show({ message: `Included ${targetPath} — will appear in AI context`, variant: "success", duration: 4000 })
      return completeLocalCommand()
    }

    toast.show({
      message: "Usage: /context show|why|pin|unpin|exclude|include <path>",
      variant: "warning",
      duration: 4000,
    })
    return completeLocalCommand()
  }

  function selectWorkspace(selection: WorkspaceSelection | undefined) {
    setWorkspaceSelection(selection)
  }

  function setCreatingWorkspace(creating: boolean) {
    setWorkspaceCreating(creating)
  }

  function showWarpNotice(name: string) {
    setWarpNotice(`Warped to ${name}`)
    setTimeout(() => setWarpNotice(undefined), 4000)
  }

  async function createWorkspace(selection: Extract<WorkspaceSelection, { type: "new" }>) {
    setCreatingWorkspace(true)
    const result = await sdk.client.experimental.workspace
      .create({ type: selection.workspaceType, branch: null })
      .catch(() => undefined)
    if (result == undefined || result.error || !result.data) {
      selectWorkspace(undefined)
      setCreatingWorkspace(false)
      toast.show({
        message: "Creating workspace failed",
        variant: "error",
      })
      return
    }

    await project.workspace.sync()
    const workspace = result.data
    selectWorkspace({
      type: "existing",
      workspaceID: workspace.id,
      workspaceType: workspace.type,
      workspaceName: workspace.name,
    })
    setCreatingWorkspace(false)
    return workspace
  }

  async function warpSession(selection: WorkspaceSelection) {
    if (!props.sessionID) {
      selectWorkspace(selection)
      dialog.clear()
      if (selection.type === "new") void createWorkspace(selection)
      return
    }
    const sourceWorkspaceID = project.workspace.current()
    const copyChanges = await confirmWorkspaceFileChanges({ dialog, sdk, sourceWorkspaceID })
    if (copyChanges === undefined) return
    selectWorkspace(selection)
    dialog.clear()

    const workspace =
      selection.type === "none"
        ? { id: null, name: "local project" }
        : selection.type === "existing"
          ? { id: selection.workspaceID, name: selection.workspaceName }
          : await createWorkspace(selection)
    if (!workspace) return

    const warped = await warpWorkspaceSession({
      dialog,
      sdk,
      sync,
      project,
      toast,
      sourceWorkspaceID,
      workspaceID: workspace.id,
      sessionID: props.sessionID,
      copyChanges,
    })
    if (warped) showWarpNotice(workspace.name)
  }

  createEffect(() => {
    if (!workspaceCreating()) {
      setWorkspaceCreatingDots(3)
      return
    }
    const timer = setInterval(() => setWorkspaceCreatingDots((dots) => (dots % 3) + 1), 1000)
    onCleanup(() => clearInterval(timer))
  })

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "Connect a provider to send prompts",
      duration: 3000,
    })
    if (sync.data.provider.length === 0) {
      dialog.replace(() => <DialogProviderConnect />)
    }
  }

  function dismissEditorContext() {
    setDismissedEditorSelectionKey(editorSelectionKey(editorContext()))
    editor.clearSelection()
  }
  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0
  const event = useEvent()

  event.on(TuiEvent.PromptAppend.type, (evt) => {
    if (!input || input.isDestroyed) return
    input.insertText(evt.properties.text)
    setTimeout(() => {
      // setTimeout is a workaround and needs to be addressed properly
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.disabled) input.cursorColor = theme.backgroundElement
    if (!props.disabled) input.cursorColor = theme.text
  })

  const lastUserMessage = createMemo(() => {
    if (!props.sessionID) return undefined
    const messages = sync.data.message[props.sessionID]
    if (!messages) return undefined
    return messages.findLast((m): m is UserMessage => m.role === "user")
  })

  const usage = createMemo(() => {
    if (!props.sessionID) return
    const msg = sync.data.message[props.sessionID] ?? []
    const last = msg.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) return

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    if (tokens <= 0) return

    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const pct = model?.limit.context ? `${Math.round((tokens / model.limit.context) * 100)}%` : undefined
    const cost = msg.reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0)
    return {
      context: pct ? `${Locale.number(tokens)} (${pct})` : Locale.number(tokens),
      cost: cost > 0 ? money.format(cost) : undefined,
    }
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPartIndex: Map<number, number>
    interrupt: number
    placeholder: number
  }>({
    placeholder: randomIndex(list().length),
    prompt: {
      input: "",
      parts: [],
    },
    mode: "normal",
    extmarkToPartIndex: new Map(),
    interrupt: 0,
  })

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", randomIndex(list().length))
      },
      { defer: true },
    ),
  )

  // Initialize agent/model/variant from last user message when session changes
  let syncedSessionID: string | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    const msg = lastUserMessage()

    if (sessionID !== syncedSessionID) {
      if (!sessionID || !msg) return

      syncedSessionID = sessionID

      // Only set agent if it's a primary agent (not a subagent)
      const isPrimaryAgent = local.agent.list().some((x) => x.name === msg.agent)
      if (msg.agent && isPrimaryAgent) {
        // Keep command line --agent if specified.
        if (!args.agent) local.agent.set(msg.agent)
        if (msg.model) {
          local.model.set(msg.model)
          local.model.variant.set(msg.model.variant)
        }
      }
    }
  })

  const promptCommands = createMemo(() =>
    [
      {
        title: "Clear prompt",
        name: "prompt.clear",
        category: "Prompt",
        hidden: true,
        run: () => {
          clearPrompt()
          dialog.clear()
        },
      },
      {
        title: "Submit prompt",
        name: "prompt.submit",
        category: "Prompt",
        hidden: true,
        run: async () => {
          if (!input.focused) return
          const handled = await submit()
          if (!handled) return

          dialog.clear()
        },
      },
      {
        title: "Remove editor context",
        name: "prompt.editor_context.clear",
        category: "Prompt",
        enabled: Boolean(editorContext()),
        run: () => {
          dismissEditorContext()
          dialog.clear()
        },
      },
      {
        title: "Paste",
        name: "prompt.paste",
        category: "Prompt",
        hidden: true,
        run: async (ctx: CommandContext<Renderable, KeyEvent>) => {
          ctx.event.preventDefault()
          ctx.event.stopPropagation()
          const content = await Clipboard.read()
          if (content?.mime.startsWith("image/")) {
            await pasteAttachment({
              filename: "clipboard",
              mime: content.mime,
              content: content.data,
            })
            return
          }
          if (content?.mime === "text/plain") {
            await pasteInputText(content.data)
          }
        },
      },
      {
        title: "Interrupt session",
        name: "session.interrupt",
        category: "Session",
        hidden: true,
        enabled: status().type !== "idle",
        run: () => {
          if (auto()?.visible) return
          if (!input.focused) return
          // TODO: this should be its own command
          if (store.mode === "shell") {
            setStore("mode", "normal")
            return
          }
          if (!props.sessionID) return

          setStore("interrupt", store.interrupt + 1)

          setTimeout(() => {
            setStore("interrupt", 0)
          }, 5000)

          if (store.interrupt >= 2) {
            void sdk.client.session.abort({
              sessionID: props.sessionID,
            })
            setStore("interrupt", 0)
          }
          dialog.clear()
        },
      },
      {
        title: "Open editor",
        category: "Session",
        name: "prompt.editor",
        slashName: "editor",
        run: async () => {
          dialog.clear()

          // replace summarized text parts with the actual text
          const text = store.prompt.parts
            .filter((p) => p.type === "text")
            .reduce((acc, p) => {
              if (!p.source) return acc
              return acc.replace(p.source.text.value, p.text)
            }, store.prompt.input)

          const nonTextParts = store.prompt.parts.filter((p) => p.type !== "text")

          const value = text
          const content = await Editor.open({ value, renderer })
          if (!content) return

          input.setText(content)

          // Update positions for nonTextParts based on their location in new content
          // Filter out parts whose virtual text was deleted
          // this handles a case where the user edits the text in the editor
          // such that the virtual text moves around or is deleted
          const updatedNonTextParts = nonTextParts
            .map((part) => {
              let virtualText = ""
              if (part.type === "file" && part.source?.text) {
                virtualText = part.source.text.value
              } else if (part.type === "agent" && part.source) {
                virtualText = part.source.value
              }

              if (!virtualText) return part

              const newStart = content.indexOf(virtualText)
              // if the virtual text is deleted, remove the part
              if (newStart === -1) return null

              const newEnd = newStart + virtualText.length

              if (part.type === "file" && part.source?.text) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    text: {
                      ...part.source.text,
                      start: newStart,
                      end: newEnd,
                    },
                  },
                }
              }

              if (part.type === "agent" && part.source) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    start: newStart,
                    end: newEnd,
                  },
                }
              }

              return part
            })
            .filter((part) => part !== null)

          setStore("prompt", {
            input: content,
            // keep only the non-text parts because the text parts were
            // already expanded inline
            parts: updatedNonTextParts,
          })
          restoreExtmarksFromParts(updatedNonTextParts)
          input.cursorOffset = Bun.stringWidth(content)
        },
      },
      {
        title: "Skills",
        name: "prompt.skills",
        category: "Prompt",
        slashName: "skills",
        run: () => {
          dialog.replace(() => (
            <DialogSkill
              onSelect={(skill) => {
                input.setText(`/${skill} `)
                setStore("prompt", {
                  input: `/${skill} `,
                  parts: [],
                })
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
      {
        title: "Warp",
        desc: "Change the workspace for the session",
        name: "workspace.set",
        category: "Session",
        enabled: Flag.OPENCODE_EXPERIMENTAL_WORKSPACES,
        slashName: "warp",
        run: () => {
          void openWorkspaceSelect({
            dialog,
            sdk,
            sync,
            project,
            toast,
            onSelect: (selection) => {
              void warpSession(selection)
            },
          })
        },
      },
      {
        title: "Project memory",
        desc: "Show or manage project memory",
        name: "prompt.memory",
        category: "Prompt",
        slashName: "memory",
        run: () => {
          input.setText("/memory ")
          setStore("prompt", {
            input: "/memory ",
            parts: [],
          })
          input.gotoBufferEnd()
          dialog.clear()
        },
      },
      {
        title: "Record decision",
        desc: "Add a decision to the project decision log",
        name: "prompt.decide",
        category: "Prompt",
        slashName: "decide",
        run: () => {
          input.setText("/decide ")
          setStore("prompt", {
            input: "/decide ",
            parts: [],
          })
          input.gotoBufferEnd()
          dialog.clear()
        },
      },
      {
        title: "Project rules",
        desc: "Show or manage project rules",
        name: "prompt.rules",
        category: "Prompt",
        slashName: "rules",
        run: () => {
          input.setText("/rules ")
          setStore("prompt", {
            input: "/rules ",
            parts: [],
          })
          input.gotoBufferEnd()
          dialog.clear()
        },
      },
      {
        title: "Show decisions",
        desc: "Show recent project decisions",
        name: "prompt.decisions",
        category: "Prompt",
        slashName: "decisions",
        run: () => {
          input.setText("/decisions")
          setStore("prompt", {
            input: "/decisions",
            parts: [],
          })
          input.gotoBufferEnd()
          dialog.clear()
        },
      },
      {
        title: "Repo map",
        desc: "Show or refresh the cached repo map",
        name: "prompt.map",
        category: "Prompt",
        slashName: "map",
        run: () => {
          input.setText("/map ")
          setStore("prompt", {
            input: "/map ",
            parts: [],
          })
          input.gotoBufferEnd()
          dialog.clear()
        },
      },
      {
        title: "Ask the repo",
        desc: "Ask a repository question with file-backed evidence",
        name: "prompt.ask",
        category: "Prompt",
        slashName: "ask",
        run: () => {
          input.setText("/ask ")
          setStore("prompt", {
            input: "/ask ",
            parts: [],
          })
          input.gotoBufferEnd()
          dialog.clear()
        },
      },
{
        title: "Agent presets",
        desc: "Create, list, update, or delete .vibe agent presets",
        name: "prompt.agent",
        category: "Prompt",
        slashName: "agent",
        run: () => {
          input.setText("/agent ")
          setStore("prompt", {
            input: "/agent ",
            parts: [],
          })
          input.gotoBufferEnd()
          dialog.clear()
        },
      },
      {
        title: "Agents debate",
        desc: "Run an architectural debate between multiple agent perspectives",
        name: "prompt.agents.debate",
        category: "Prompt",
        slashName: "agents debate",
        run: () => {
          input.setText("/agents debate ")
          setStore("prompt", {
            input: "/agents debate ",
            parts: [],
          })
          input.gotoBufferEnd()
          dialog.clear()
        },
      },
      {
        title: "Context inspector",
        desc: "Show, pin, or exclude files from AI context",
        name: "prompt.context",
        category: "Prompt",
        slashName: "context",
        run: () => {
          input.setText("/context ")
          setStore("prompt", {
            input: "/context ",
            parts: [],
          })
          input.gotoBufferEnd()
          dialog.clear()
        },
      },
      ...["frontend", "backend", "reviewer", "devops", "designer"].map((preset) => ({
        title: `Preset: ${preset}`,
        desc: `Run a prompt with the ${preset} preset agent`,
        name: `prompt.agent-preset.${preset}`,
        category: "Prompt",
        slashName: preset,
        run: () => {
          input.setText(`/${preset} `)
          setStore("prompt", {
            input: `/${preset} `,
            parts: [],
          })
          input.gotoBufferEnd()
          dialog.clear()
        },
      })),
    ].map((entry) => ({
      namespace: "palette",
      ...entry,
    })),
  )

  useBindings(() => ({
    commands: promptCommands(),
  }))

  useBindings(() => ({
    enabled: command.matcher,
    bindings: keymapConfig.pick("prompt", [
      "prompt.submit",
      "prompt.editor",
      "prompt.editor_context.clear",
      "prompt.stash",
      "prompt.stash.pop",
      "prompt.stash.list",
      "session.interrupt",
      "workspace.set",
    ]),
  }))

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      input.setText(prompt.input)
      setStore("prompt", prompt)
      restoreExtmarksFromParts(prompt.parts)
      input.gotoBufferEnd()
    },
    reset() {
      input.clear()
      input.extmarks.clear()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
    },
    submit() {
      void submit()
    },
  }

  onMount(() => {
    const saved = stashed
    stashed = undefined
    if (store.prompt.input) return
    if (saved && saved.prompt.input) {
      input.setText(saved.prompt.input)
      setStore("prompt", saved.prompt)
      restoreExtmarksFromParts(saved.prompt.parts)
      input.cursorOffset = saved.cursor
    }
  })

  onCleanup(() => {
    if (store.prompt.input) {
      stashed = { prompt: unwrap(store.prompt), cursor: input.cursorOffset }
    }
    setInputTarget(undefined)
    props.ref?.(undefined)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.visible === false || dialog.stack.length > 0) {
      if (input.focused) input.blur()
      return
    }

    // Slot/plugin updates can remount the background prompt while a dialog is open.
    // Keep focus with the dialog and let the prompt reclaim it after the dialog closes.
    if (!input.focused) input.focus()
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.traits = {
      ...input.traits,
      ...computePromptTraits({
        mode: store.mode,
        disabled: !!props.disabled,
        autocompleteVisible: !!auto()?.visible,
      }),
    }
  })

  function restoreExtmarksFromParts(parts: PromptInfo["parts"]) {
    input.extmarks.clear()
    setStore("extmarkToPartIndex", new Map())

    parts.forEach((part, partIndex) => {
      let start = 0
      let end = 0
      let virtualText = ""
      let styleId: number | undefined

      if (part.type === "file" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = fileStyleId
      } else if (part.type === "agent" && part.source) {
        start = part.source.start
        end = part.source.end
        virtualText = part.source.value
        styleId = agentStyleId
      } else if (part.type === "text" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = pasteStyleId
      }

      if (virtualText) {
        const extmarkId = input.extmarks.create({
          start,
          end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPartIndex", (map: Map<number, number>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, partIndex)
          return newMap
        })
      }
    })
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, number>()
        const newParts: typeof draft.prompt.parts = []

        for (const extmark of allExtmarks) {
          const partIndex = draft.extmarkToPartIndex.get(extmark.id)
          if (partIndex !== undefined) {
            const part = draft.prompt.parts[partIndex]
            if (part) {
              if (part.type === "agent" && part.source) {
                part.source.start = extmark.start
                part.source.end = extmark.end
              } else if (part.type === "file" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              } else if (part.type === "text" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              }
              newMap.set(extmark.id, newParts.length)
              newParts.push(part)
            }
          }
        }

        draft.extmarkToPartIndex = newMap
        draft.prompt.parts = newParts
      }),
    )
  }

  const stashCommands = createMemo(() =>
    [
      {
        title: "Stash prompt",
        name: "prompt.stash",
        category: "Prompt",
        enabled: !!store.prompt.input,
        run: () => {
          if (!store.prompt.input) return
          stash.push({
            input: store.prompt.input,
            parts: store.prompt.parts,
          })
          input.extmarks.clear()
          input.clear()
          setStore("prompt", { input: "", parts: [] })
          setStore("extmarkToPartIndex", new Map())
          dialog.clear()
        },
      },
      {
        title: "Stash pop",
        name: "prompt.stash.pop",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          const entry = stash.pop()
          if (entry) {
            input.setText(entry.input)
            setStore("prompt", { input: entry.input, parts: entry.parts })
            restoreExtmarksFromParts(entry.parts)
            input.gotoBufferEnd()
          }
          dialog.clear()
        },
      },
      {
        title: "Stash list",
        name: "prompt.stash.list",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          dialog.replace(() => (
            <DialogStash
              onSelect={(entry) => {
                input.setText(entry.input)
                setStore("prompt", { input: entry.input, parts: entry.parts })
                restoreExtmarksFromParts(entry.parts)
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
    ].map((entry) => ({
      namespace: "palette",
      ...entry,
    })),
  )

  useBindings(() => ({
    commands: stashCommands(),
  }))

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !props.disabled,
      bindings: keymapConfig.pick("prompt", ["prompt.paste"]),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !props.disabled && store.prompt.input !== "",
      bindings: keymapConfig.pick("prompt", ["prompt.clear"]),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return (
          inputTarget() !== undefined &&
          !props.disabled &&
          store.mode === "normal" &&
          !auto()?.visible &&
          input?.visualCursor.offset === 0
        )
      })(),
      bindings: [
        {
          key: "!",
          desc: "Shell mode",
          group: "Prompt",
          cmd: () => {
            setStore("placeholder", randomIndex(shell().length))
            setStore("mode", "shell")
          },
        },
      ],
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && store.mode === "shell",
      bindings: [{ key: "escape", desc: "Exit shell mode", group: "Prompt", cmd: () => setStore("mode", "normal") }],
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && store.mode === "shell" && input?.visualCursor.offset === 0
      })(),
      bindings: [{ key: "backspace", desc: "Exit shell mode", group: "Prompt", cmd: () => setStore("mode", "normal") }],
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return (
          inputTarget() !== undefined &&
          !props.disabled &&
          !auto()?.visible &&
          input !== undefined &&
          (input.cursorOffset === 0 || input.visualCursor.visualRow === 0)
        )
      })(),
      commands: [
        {
          name: "prompt.history.previous",
          title: "Previous prompt history",
          category: "Prompt",
          run() {
            if (input.cursorOffset !== 0) {
              input.cursorOffset = 0
              return
            }

            const item = history.move(-1, input.plainText)
            if (!item) return
            input.setText(item.input)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromParts(item.parts)
            input.cursorOffset = 0
          },
        },
      ],
      bindings: keymapConfig.pick("prompt", ["prompt.history.previous"]),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return (
          inputTarget() !== undefined &&
          !props.disabled &&
          !auto()?.visible &&
          input !== undefined &&
          (input.cursorOffset === input.plainText.length || input.visualCursor.visualRow === input.height - 1)
        )
      })(),
      commands: [
        {
          name: "prompt.history.next",
          title: "Next prompt history",
          category: "Prompt",
          run() {
            if (input.cursorOffset !== input.plainText.length) {
              input.cursorOffset = input.plainText.length
              return
            }

            const item = history.move(1, input.plainText)
            if (!item) return
            input.setText(item.input)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromParts(item.parts)
            input.cursorOffset = input.plainText.length
          },
        },
      ],
      bindings: keymapConfig.pick("prompt", ["prompt.history.next"]),
    }
  })

  async function submit() {
    setWarpNotice(undefined)

    // IME: double-defer may fire before onContentChange flushes the last
    // composed character (e.g. Korean hangul) to the store, so read
    // plainText directly and sync before any downstream reads.
    if (input && !input.isDestroyed && input.plainText !== store.prompt.input) {
      setStore("prompt", "input", input.plainText)
      syncExtmarksWithPromptParts()
    }
    if (props.disabled) return false
    if (workspaceCreating()) return false
    if (auto()?.visible) {
      const trimmedVisible = input?.plainText.trim() ?? store.prompt.input.trim()
      if (!isExactSlashCommand(trimmedVisible)) return false
      auto()?.onInput(trimmedVisible + " ")
    }
    if (!store.prompt.input) return false
    const agent = local.agent.current()
    if (!agent) return false
    const trimmed = store.prompt.input.trim()
    if (trimmed.startsWith("/memory")) return await handleMemoryCommand(trimmed)
    if (trimmed.startsWith("/rules")) return await handleRulesCommand(trimmed)
    if (trimmed === "/decisions" || trimmed.startsWith("/decide")) return await handleDecisionCommand(trimmed)
    if (trimmed.startsWith("/map")) return await handleMapCommand(trimmed)
if (trimmed.startsWith("/agent")) return await handleAgentCommand(trimmed)
    if (trimmed.startsWith("/agents debate")) return await handleDebateCommand(trimmed)
    if (trimmed.startsWith("/context")) return await handleContextCommand(trimmed)
    if (trimmed === "exit" || trimmed === "quit" || trimmed === ":q") {
      void exit()
      return true
    }
    const selectedModel = local.model.current()
    if (!selectedModel) {
      void promptModelWarning()
      return false
    }

    let inputTextOverride: string | undefined
    let selectedModelOverride = selectedModel
if (trimmed.startsWith("/ask")) {
      const prepared = await prepareAskPrompt(trimmed)
      if (prepared.handled) return true
      inputTextOverride = prepared.prompt
    }

    if (trimmed.startsWith("/agents debate")) {
      const prepared = await prepareDebatePrompt(trimmed)
      if (prepared.handled) return true
      inputTextOverride = prepared.prompt
    }

    if (trimmed.startsWith("/")) {
      const prepared = await prepareAgentAliasPrompt(trimmed)
      if (prepared.handled) return true
      if (prepared.prompt) inputTextOverride = prepared.prompt
      if (prepared.modelOverride) {
        const parsed = normalizeAgentModelRef(prepared.modelOverride)
        if (parsed) {
          const nextModel = {
            providerID: parsed.provider,
            modelID: parsed.model,
          }
          local.model.set(nextModel, { recent: true })
          selectedModelOverride = nextModel
        }
      }
    }

    const workspaceSession = props.sessionID ? sync.session.get(props.sessionID) : undefined
    const workspaceID = workspaceSession?.workspaceID
    const workspaceStatus = workspaceID ? (project.workspace.status(workspaceID) ?? "error") : undefined
    if (props.sessionID && workspaceID && workspaceStatus !== "connected") {
      dialog.replace(() => (
        <DialogWorkspaceUnavailable
          onRestore={() => {
            void openWorkspaceSelect({
              dialog,
              sdk,
              sync,
              project,
              toast,
              onSelect: (selection) => {
                void warpSession(selection)
              },
            })
            return false
          }}
        />
      ))
      return false
    }

    const variant = local.model.variant.current()
    let sessionID = props.sessionID
    if (sessionID == null) {
      const workspace = workspaceSelection()
          const workspaceID = iife(() => {
            if (!workspace) return defaultWorkspaceID()
            if (workspace.type === "none") return undefined
            if (workspace.type === "existing") return workspace.workspaceID
            return undefined
      })

      const res = await sdk.client.session.create({
        workspace: workspaceID,
        agent: agent.name,
        model: {
          providerID: selectedModelOverride.providerID,
          id: selectedModelOverride.modelID,
          variant,
        },
      })

      if (res.error) {
        console.log("Creating a session failed:", res.error)

        toast.show({
          message: "Creating a session failed. Open console for more details.",
          variant: "error",
        })

        return true
      }

      sessionID = res.data.id
    }

    const messageID = MessageID.ascending()
    let inputText = inputTextOverride ?? store.prompt.input

    // Expand pasted text inline before submitting
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    const sortedExtmarks = allExtmarks.sort((a: { start: number }, b: { start: number }) => b.start - a.start)

    for (const extmark of sortedExtmarks) {
      const partIndex = store.extmarkToPartIndex.get(extmark.id)
      if (partIndex !== undefined) {
        const part = store.prompt.parts[partIndex]
        if (part?.type === "text" && part.text) {
          const before = inputText.slice(0, extmark.start)
          const after = inputText.slice(extmark.end)
          inputText = before + part.text + after
        }
      }
    }

    // Filter out text parts (pasted content) since they're now expanded inline
    const nonTextParts = store.prompt.parts.filter((part) => part.type !== "text")
    const slash = parseSlashInput(inputText)
    const localSlash = command.slashes().find((entry) => {
      const display = normalizeSlashAlias(entry.display)
      if (display === slash.name) return true
      return entry.aliases?.some((alias) => normalizeSlashAlias(alias) === slash.name) ?? false
    })

    // Capture mode before it gets reset
    const currentMode = store.mode
    const editorSelection = editorContext()
    const editorParts =
      editorSelection && editor.labelState() === "pending"
        ? [
            {
              id: PartID.ascending(),
              type: "text" as const,
              text: formatEditorContext(editorSelection),
              synthetic: true,
              metadata: {
                kind: "editor_context",
                source: editorSelection.source ?? "editor",
                filePath: editorSelection.filePath,
                ranges: editorSelection.ranges,
              },
            },
          ]
        : []

    if (store.mode === "shell") {
      void sdk.client.session.shell({
        sessionID,
        agent: agent.name,
        model: {
          providerID: selectedModelOverride.providerID,
          modelID: selectedModelOverride.modelID,
        },
        command: inputText,
      })
      setStore("mode", "normal")
    } else if (inputText.startsWith("/") && localSlash) {
      localSlash.onSelect()
      if (input.plainText !== store.prompt.input) {
        setStore("prompt", "input", input.plainText)
        syncExtmarksWithPromptParts()
        return await submit()
      }
      return true
    } else if (inputText.startsWith("/") && sync.data.command.some((x) => x.name === slash.name)) {
      // Parse command from first line, preserve multi-line content in arguments
        void sdk.client.session.command({
          sessionID,
          command: slash.name,
          arguments: slash.argumentsText,
          agent: agent.name,
          model: `${selectedModelOverride.providerID}/${selectedModelOverride.modelID}`,
          messageID,
          variant,
          parts: nonTextParts
          .filter((x) => x.type === "file")
          .map((x) => ({
            id: PartID.ascending(),
            ...x,
          })),
      })
    } else {
      sdk.client.session
        .prompt({
          sessionID,
          ...selectedModelOverride,
          messageID,
          agent: agent.name,
          model: selectedModelOverride,
          variant,
          parts: [
            ...editorParts,
            {
              id: PartID.ascending(),
              type: "text",
              text: inputText,
            },
            ...nonTextParts.map(assign),
          ],
        })
        .catch(() => {})
      if (editorParts.length > 0) editor.markSelectionSent()
    }
    history.append({
      ...store.prompt,
      mode: currentMode,
    })
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
    props.onSubmit?.()

    // temporary hack to make sure the message is sent
    if (!props.sessionID) {
      if (editorParts.length > 0) editor.preserveSelectionFromNewSession()
      setTimeout(() => {
        route.navigate({
          type: "session",
          sessionID,
        })
      }, 50)
    }
    input.clear()
    return true
  }
  const exit = useExit()

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + virtualText.length

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push({
          type: "text" as const,
          text,
          source: {
            text: {
              start: extmarkStart,
              end: extmarkEnd,
              value: virtualText,
            },
          },
        })
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
  }

  async function pasteInputText(text: string) {
    const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    const pastedContent = normalizedText.trim()
    const filepath = iife(() => {
      const raw = pastedContent.replace(/^['"]+|['"]+$/g, "")
      if (raw.startsWith("file://")) {
        try {
          return fileURLToPath(raw)
        } catch {}
      }
      if (process.platform === "win32") return raw
      return raw.replace(/\\(.)/g, "$1")
    })
    const isUrl = /^(https?):\/\//.test(filepath)
    if (!isUrl) {
      try {
        const mime = await Filesystem.mimeType(filepath)
        const filename = path.basename(filepath)
        if (mime === "image/svg+xml") {
          const content = await Filesystem.readText(filepath).catch(() => {})
          if (content) {
            pasteText(content, `[SVG: ${filename ?? "image"}]`)
            return
          }
        }
        if (mime.startsWith("image/") || mime === "application/pdf") {
          const content = await Filesystem.readArrayBuffer(filepath)
            .then((buffer) => Buffer.from(buffer).toString("base64"))
            .catch(() => {})
          if (content) {
            await pasteAttachment({
              filename,
              filepath,
              mime,
              content,
            })
            return
          }
        }
      } catch {}
    }

    const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
    if (
      (lineCount >= 3 || pastedContent.length > 150) &&
      kv.get("paste_summary_enabled", !sync.data.config.experimental?.disable_paste_summary)
    ) {
      pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
      return
    }

    input.insertText(normalizedText)

    setTimeout(() => {
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      renderer.requestRender()
    }, 0)
  }

  async function pasteAttachment(file: { filename?: string; filepath?: string; content: string; mime: string }) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const pdf = file.mime === "application/pdf"
    const count = store.prompt.parts.filter((x) => {
      if (x.type !== "file") return false
      if (pdf) return x.mime === "application/pdf"
      return x.mime.startsWith("image/")
    }).length
    const virtualText = pdf ? `[PDF ${count + 1}]` : `[Image ${count + 1}]`
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: Omit<FilePart, "id" | "messageID" | "sessionID"> = {
      type: "file" as const,
      mime: file.mime,
      filename: file.filename,
      url: `data:${file.mime};base64,${file.content}`,
      source: {
        type: "file",
        path: file.filepath ?? file.filename ?? "",
        text: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      },
    }
    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push(part)
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
    return
  }

  function clearPrompt() {
    if (store.prompt.input.trim().length >= DRAFT_RETENTION_MIN_CHARS || store.prompt.parts.length > 0) {
      history.append({
        ...store.prompt,
        mode: store.mode,
      })
    }
    input.clear()
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
  }

  function completeLocalCommand() {
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
    props.onSubmit?.()
    input.clear()
    return true
  }

  const highlight = createMemo(() => {
    if (leader()) return theme.border
    if (store.mode === "shell") return theme.primary
    const agent = local.agent.current()
    if (!agent) return theme.border
    return local.agent.color(agent.name)
  })

  const showVariant = createMemo(() => {
    const variants = local.model.variant.list()
    if (variants.length === 0) return false
    const current = local.model.variant.current()
    return !!current
  })

  const agentMetaAlpha = createFadeIn(() => !!local.agent.current(), animationsEnabled)
  const modelMetaAlpha = createFadeIn(() => !!local.agent.current() && store.mode === "normal", animationsEnabled)
  const variantMetaAlpha = createFadeIn(
    () => !!local.agent.current() && store.mode === "normal" && showVariant(),
    animationsEnabled,
  )
  const borderHighlight = createMemo(() => tint(theme.border, highlight(), agentMetaAlpha()))

  const placeholderText = createMemo(() => {
    if (props.showPlaceholder === false) return undefined
    if (store.mode === "shell") {
      if (!shell().length) return undefined
      const example = shell()[store.placeholder % shell().length]
      return `Run a command... "${example}"`
    }
    if (!list().length) return undefined
    return `Ask anything... "${list()[store.placeholder % list().length]}"`
  })

  const workspaceLabel = createMemo<
    | { type: "new"; workspaceType: string }
    | { type: "existing"; workspaceType: string; workspaceName: string; status?: WorkspaceStatus }
    | undefined
  >(() => {
    const selected = workspaceSelection()
    if (!selected) {
      const workspaceID = defaultWorkspaceID()
      if (props.sessionID || !workspaceID) return
      const workspace = project.workspace.get(workspaceID)
      return {
        type: "existing",
        workspaceType: workspace?.type ?? "unknown",
        workspaceName: workspace?.name ?? workspaceID,
        status: project.workspace.status(workspaceID) ?? "error",
      }
    }
    if (selected.type === "none") return
    if (props.sessionID && !workspaceCreating()) return
    if (selected.type === "new") {
      return {
        type: "new",
        workspaceType: selected.workspaceType,
      }
    }
    return {
      type: "existing",
      workspaceType: selected.workspaceType,
      workspaceName: selected.workspaceName,
      status: selected.type === "existing" ? "connected" : undefined,
    }
  })

  const spinnerDef = createMemo(() => {
    const agent = local.agent.current()
    const color = agent ? local.agent.color(agent.name) : theme.border
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
    }
  })

  return (
    <>
      <box ref={(r: BoxRenderable) => (anchor = r)} visible={props.visible !== false}>
        <box
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...SplitBorder.customBorderChars,
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={theme.backgroundElement}
            flexGrow={1}
          >
            <textarea
              placeholder={placeholderText()}
              placeholderColor={theme.textMuted}
              textColor={leader() ? theme.textMuted : theme.text}
              focusedTextColor={leader() ? theme.textMuted : theme.text}
              minHeight={1}
              maxHeight={6}
              onContentChange={() => {
                const value = input.plainText
                setStore("prompt", "input", value)
                auto()?.onInput(value)
                syncExtmarksWithPromptParts()
                setCursorVersion((value) => value + 1)
              }}
              onCursorChange={() => setCursorVersion((value) => value + 1)}
              onKeyDown={(e: { preventDefault(): void }) => {
                if (props.disabled) {
                  e.preventDefault()
                  return
                }
              }}
              onSubmit={() => {
                // IME: double-defer so the last composed character (e.g. Korean
                // hangul) is flushed to plainText before we read it for submission.
                setTimeout(() => setTimeout(() => submit(), 0), 0)
              }}
              onPaste={async (event: PasteEvent) => {
                if (props.disabled) {
                  event.preventDefault()
                  return
                }

                // Normalize line endings at the boundary
                // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                // Replace CRLF first, then any remaining CR
                const normalizedText = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                const pastedContent = normalizedText.trim()

                // Windows Terminal <1.25 can surface image-only clipboard as an
                // empty bracketed paste. Windows Terminal 1.25+ does not.
                if (!pastedContent) {
                  keymap.dispatchCommand("prompt.paste")
                  return
                }

                // Once we cross an async boundary below, the terminal may perform its
                // default paste unless we suppress it first and handle insertion ourselves.
                event.preventDefault()

                await pasteInputText(normalizedText)
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                setInputTarget(r)
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                props.ref?.(ref)
                setTimeout(() => {
                  // setTimeout is a workaround and needs to be addressed properly
                  if (!input || input.isDestroyed) return
                  input.cursorColor = theme.text
                }, 0)
              }}
              onMouseDown={(r: MouseEvent) => r.target?.focus()}
              focusedBackgroundColor={theme.backgroundElement}
              cursorColor={props.disabled ? theme.backgroundElement : theme.text}
              syntaxStyle={syntax()}
            />
            <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} justifyContent="space-between">
              <box flexDirection="row" gap={1}>
                <Show when={local.agent.current()} fallback={<box height={1} />}>
                  {(agent) => (
                    <>
                      <text fg={fadeColor(highlight(), agentMetaAlpha())}>
                        {store.mode === "shell" ? "Shell" : Locale.titlecase(agent().name)}
                      </text>
                      <Show when={store.mode === "normal"}>
                        <box flexDirection="row" gap={1}>
                          <text fg={fadeColor(theme.textMuted, modelMetaAlpha())}>·</text>
                          <text
                            flexShrink={0}
                            fg={fadeColor(leader() ? theme.textMuted : theme.text, modelMetaAlpha())}
                          >
                            {local.model.parsed().model}
                          </text>
                          <text fg={fadeColor(theme.textMuted, modelMetaAlpha())}>{currentProviderLabel()}</text>
                          <Show when={showVariant()}>
                            <text fg={fadeColor(theme.textMuted, variantMetaAlpha())}>·</text>
                            <text>
                              <span style={{ fg: fadeColor(theme.warning, variantMetaAlpha()), bold: true }}>
                                {local.model.variant.current()}
                              </span>
                            </text>
                          </Show>
                        </box>
                      </Show>
                    </>
                  )}
                </Show>
              </box>
              <Show when={hasRightContent()}>
                <box flexDirection="row" gap={1} alignItems="center">
                  {props.right}
                </box>
              </Show>
            </box>
          </box>
        </box>
        <box
          height={1}
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: theme.backgroundElement.a !== 0 ? "╹" : " ",
          }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={theme.backgroundElement}
            customBorderChars={
              theme.backgroundElement.a !== 0
                ? {
                    ...EmptyBorder,
                    horizontal: "▀",
                  }
                : {
                    ...EmptyBorder,
                    horizontal: " ",
                  }
            }
          />
        </box>
        <box width="100%" flexDirection="row" justifyContent="space-between">
          <Switch>
            <Match when={status().type !== "idle"}>
              <box
                flexDirection="row"
                gap={1}
                flexGrow={1}
                justifyContent={status().type === "retry" ? "space-between" : "flex-start"}
              >
                <box flexShrink={0} flexDirection="row" gap={1}>
                  <box marginLeft={1}>
                    <Show when={kv.get("animations_enabled", true)} fallback={<text fg={theme.textMuted}>[⋯]</text>}>
                      <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
                    </Show>
                  </box>
                  <box flexDirection="row" gap={1} flexShrink={0}>
                    {(() => {
                      const retry = createMemo(() => {
                        const s = status()
                        if (s.type !== "retry") return
                        return s
                      })
                      const message = createMemo(() => {
                        const r = retry()
                        if (!r) return
                        if (r.message.includes("exceeded your current quota") && r.message.includes("gemini"))
                          return "gemini is way too hot right now"
                        if (r.message.length > 80) return r.message.slice(0, 80) + "..."
                        return r.message
                      })
                      const isTruncated = createMemo(() => {
                        const r = retry()
                        if (!r) return false
                        return r.message.length > 120
                      })
                      const [seconds, setSeconds] = createSignal(0)
                      onMount(() => {
                        const timer = setInterval(() => {
                          const next = retry()?.next
                          if (next) setSeconds(Math.round((next - Date.now()) / 1000))
                        }, 1000)

                        onCleanup(() => {
                          clearInterval(timer)
                        })
                      })
                      const handleMessageClick = () => {
                        const r = retry()
                        if (!r) return
                        if (isTruncated()) {
                          void DialogAlert.show(dialog, "Retry Error", r.message)
                        }
                      }

                      const retryText = () => {
                        const r = retry()
                        if (!r) return ""
                        const baseMessage = message()
                        const truncatedHint = isTruncated() ? " (click to expand)" : ""
                        const duration = formatDuration(seconds())
                        const retryInfo = ` [retrying ${duration ? `in ${duration} ` : ""}attempt #${r.attempt}]`
                        return baseMessage + truncatedHint + retryInfo
                      }

                      return (
                        <Show when={retry()}>
                          <box onMouseUp={handleMessageClick}>
                            <text fg={theme.error}>{retryText()}</text>
                          </box>
                        </Show>
                      )
                    })()}
                  </box>
                </box>
                <text fg={store.interrupt > 0 ? theme.primary : theme.text}>
                  esc{" "}
                  <span style={{ fg: store.interrupt > 0 ? theme.primary : theme.textMuted }}>
                    {store.interrupt > 0 ? "again to interrupt" : "interrupt"}
                  </span>
                </text>
              </box>
            </Match>
            <Match when={warpNotice()}>
              {(notice) => (
                <box paddingLeft={3}>
                  <text fg={theme.accent}>{notice()}</text>
                </box>
              )}
            </Match>
            <Match when={workspaceLabel()}>
              {(workspace) => (
                <box paddingLeft={3} flexDirection="row" gap={1}>
                  <Show when={workspaceCreating()}>
                    <Spinner color={theme.accent} />
                  </Show>
                  <text fg={workspaceCreating() ? theme.accent : theme.text}>
                    {(() => {
                      const item = workspace()
                      if (item.type === "new") {
                        if (workspaceCreating())
                          return `Creating ${item.workspaceType}${".".repeat(workspaceCreatingDots())}`
                        return (
                          <>
                            Workspace <span style={{ fg: theme.textMuted }}>(new {item.workspaceType})</span>
                          </>
                        )
                      }
                      return (
                        <>
                          Workspace <span style={{ fg: theme.textMuted }}>{item.workspaceName}</span>
                        </>
                      )
                    })()}
                  </text>
                </box>
              )}
            </Match>
            <Match when={true}>{props.hint ?? <text />}</Match>
          </Switch>
          <Show when={status().type !== "retry"}>
            <box gap={2} flexDirection="row">
              <Show when={editorContextLabelState() !== "none" ? editorFileLabelDisplay() : undefined}>
                {(file) => (
                  <text fg={editorContextLabelState() === "pending" ? theme.secondary : theme.textMuted}>{file()}</text>
                )}
              </Show>
              <Switch>
                <Match when={store.mode === "normal"}>
                  <Switch>
                    <Match when={usage()}>
                      {(item) => (
                        <text fg={theme.textMuted} wrapMode="none">
                          {[item().context, item().cost].filter(Boolean).join(" · ")}
                        </text>
                      )}
                    </Match>
                    <Match when={true}>
                      <text fg={theme.text}>
                        {agentShortcut()} <span style={{ fg: theme.textMuted }}>agents</span>
                      </text>
                    </Match>
                  </Switch>
                  <text fg={theme.text}>
                    {paletteShortcut()} <span style={{ fg: theme.textMuted }}>commands</span>
                  </text>
                </Match>
                <Match when={store.mode === "shell"}>
                  <text fg={theme.text}>
                    esc <span style={{ fg: theme.textMuted }}>exit shell mode</span>
                  </text>
                </Match>
              </Switch>
            </box>
          </Show>
        </box>
      </box>
      <Show when={props.bottom}>
        <box paddingX={2} paddingY={1}>
          {props.bottom}
        </box>
      </Show>
      <Autocomplete
        sessionID={props.sessionID}
        ref={(r) => {
          setAuto(() => r)
        }}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(partIndex, extmarkId) => {
          setStore("extmarkToPartIndex", (map: Map<number, number>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, partIndex)
            return newMap
          })
        }}
        value={store.prompt.input}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        promptPartTypeId={() => promptPartTypeId}
      />
    </>
  )
}
