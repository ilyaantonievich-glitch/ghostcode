import { readFile, writeFile } from "fs/promises"
import matter from "gray-matter"
import path from "path"

export const CONTEXT_CONFIG = "context.yaml"

export type ContextConfig = {
  pinned: string[]
  excluded: string[]
}

const DEFAULT_CONFIG: ContextConfig = {
  pinned: [],
  excluded: [],
}

function escapeYamlScalar(value: string) {
  return JSON.stringify(value)
}

export function serializeContextConfig(config: ContextConfig) {
  const lines = ["context:", "  pinned:"]
  for (const p of config.pinned) {
    lines.push(`    - ${escapeYamlScalar(p)}`)
  }
  lines.push("  excluded:")
  for (const p of config.excluded) {
    lines.push(`    - ${escapeYamlScalar(p)}`)
  }
  return lines.join("\n") + "\n"
}

function parseContextConfig(content: string): ContextConfig {
  if (!content.trim()) return DEFAULT_CONFIG

  const wrapped = `---\n${content}\n---\n`
  const parsed = matter(wrapped).data as Record<string, unknown>

  return {
    pinned: Array.isArray(parsed.pinned)
      ? parsed.pinned.filter((p): p is string => typeof p === "string")
      : [],
    excluded: Array.isArray(parsed.excluded)
      ? parsed.excluded.filter((p): p is string => typeof p === "string")
      : [],
  }
}

export function contextConfigPath(root: string) {
  return path.join(root, CONTEXT_CONFIG)
}

export async function readContextConfig(root: string): Promise<ContextConfig> {
  try {
    const filepath = contextConfigPath(root)
    const content = await readFile(filepath, "utf-8")
    return parseContextConfig(content)
  } catch {
    return DEFAULT_CONFIG
  }
}

export async function writeContextConfig(root: string, config: ContextConfig): Promise<void> {
  const filepath = contextConfigPath(root)
  await writeFile(filepath, serializeContextConfig(config))
}

export async function pinPath(root: string, filePath: string): Promise<ContextConfig> {
  const config = await readContextConfig(root)
  if (!config.pinned.includes(filePath)) {
    config.pinned.push(filePath)
    await writeContextConfig(root, config)
  }
  return config
}

export async function unpinPath(root: string, filePath: string): Promise<ContextConfig> {
  const config = await readContextConfig(root)
  config.pinned = config.pinned.filter((p) => p !== filePath)
  await writeContextConfig(root, config)
  return config
}

export async function excludePath(root: string, filePath: string): Promise<ContextConfig> {
  const config = await readContextConfig(root)
  if (!config.excluded.includes(filePath)) {
    config.excluded.push(filePath)
    await writeContextConfig(root, config)
  }
  return config
}

export async function includePath(root: string, filePath: string): Promise<ContextConfig> {
  const config = await readContextConfig(root)
  config.excluded = config.excluded.filter((p) => p !== filePath)
  await writeContextConfig(root, config)
  return config
}

export const MAX_CONTEXT_SIZE = 48 * 1024

export interface ContextItem {
  source: "memory" | "context" | "rules" | "decisions" | "repo-map" | "pinned"
  path: string
  size: number
  preview: string
  truncated?: boolean
}

export async function collectContextItems(
  memoryRoot: string,
  projectRoot: string,
): Promise<ContextItem[]> {
  const items: ContextItem[] = []
  const config = await readContextConfig(memoryRoot)

  const files = [
    { key: "memory", path: path.join(memoryRoot, "memory.md"), source: "memory" as const },
    { key: "context", path: path.join(memoryRoot, "context.md"), source: "context" as const },
    { key: "rules", path: path.join(memoryRoot, "rules.md"), source: "rules" as const },
    { key: "decisions", path: path.join(memoryRoot, "decisions.md"), source: "decisions" as const },
    { key: "repo-map", path: path.join(memoryRoot, "repo-map.md"), source: "repo-map" as const },
  ]

  for (const file of files) {
    try {
      const content = await readFile(file.path, "utf-8")
      const truncated = content.length > MAX_CONTEXT_SIZE
      const preview = truncated ? content.slice(0, MAX_CONTEXT_SIZE) + "\n... [truncated]" : content
      items.push({
        source: file.source,
        path: file.key,
        size: content.length,
        preview: preview.slice(0, 500),
        truncated,
      })
    } catch {
      // File doesn't exist or is empty
    }
  }

  for (const pinnedPath of config.pinned) {
    const fullPath = path.isAbsolute(pinnedPath) ? pinnedPath : path.join(projectRoot, pinnedPath)
    try {
      const content = await readFile(fullPath, "utf-8")
      const truncated = content.length > MAX_CONTEXT_SIZE
      const preview = truncated ? content.slice(0, MAX_CONTEXT_SIZE) + "\n... [truncated]" : content
      items.push({
        source: "pinned",
        path: pinnedPath,
        size: content.length,
        preview: preview.slice(0, 500),
        truncated,
      })
    } catch {
      items.push({
        source: "pinned",
        path: pinnedPath,
        size: 0,
        preview: "[file not found]",
        truncated: false,
      })
    }
  }

  return items
}

export function explainContextSources(): string[] {
  return [
    "• .vibe/memory.md — project memory entries from /memory add",
    "• .vibe/context.md — manually written project context",
    "• .vibe/rules.md — project rules (DO NOT EDIT, PREFER, etc.)",
    "• .vibe/decisions.md — recorded decisions from /decide",
    "• .vibe/repo-map.md — cached repository structure from /map",
    "• .vibe/context.yaml — pinned files (always included)",
  ]
}