import path from "path"
import matter from "gray-matter"
import { readFile, writeFile } from "fs/promises"
import { Filesystem } from "@/util/filesystem"

export const VIBE_AGENTS = "agents.yaml"

export type AgentPreset = {
  name: string
  description: string
  system_prompt: string
  provider?: string
  model?: string
}

const DEFAULT_PRESET_TEXT: Record<string, { description: string; system_prompt: string }> = {
  frontend: {
    description: "Frontend implementation preset",
    system_prompt:
      "You are the frontend specialist for this task. Prioritize UI correctness, responsive behavior, accessibility, and preserving the existing design system.",
  },
  backend: {
    description: "Backend implementation preset",
    system_prompt:
      "You are the backend specialist for this task. Prioritize API correctness, data flow, error handling, and minimal, maintainable server-side changes.",
  },
  reviewer: {
    description: "Code review preset",
    system_prompt:
      "You are the reviewer for this task. Focus first on bugs, regressions, risks, and missing tests. Keep summaries brief after findings.",
  },
  devops: {
    description: "DevOps and infra preset",
    system_prompt:
      "You are the DevOps specialist for this task. Prioritize deployment safety, reproducibility, environment correctness, and operational clarity.",
  },
  designer: {
    description: "Design and UX preset",
    system_prompt:
      "You are the design specialist for this task. Prioritize usability, hierarchy, visual coherence, and fit with the existing product language.",
  },
}

function escapeYamlScalar(value: string) {
  return JSON.stringify(value)
}

function indentBlock(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n")
}

export function createDefaultAgentPreset(name: string): AgentPreset {
  const normalized = name.trim()
  const template = DEFAULT_PRESET_TEXT[normalized.toLowerCase()]
  return {
    name: normalized,
    description: template?.description ?? `${normalized} preset`,
    system_prompt:
      template?.system_prompt ??
      `You are the ${normalized} specialist for this task. Keep the work focused, pragmatic, and aligned with the repository's existing patterns.`,
  }
}

export function normalizeAgentModelRef(input: string) {
  const value = input.trim()
  const colon = value.indexOf(":")
  if (colon > 0) {
    const provider = value.slice(0, colon).trim()
    const model = value.slice(colon + 1).trim()
    if (provider && model) return { provider, model }
  }

  const slash = value.indexOf("/")
  if (slash > 0) {
    const provider = value.slice(0, slash).trim()
    const model = value.slice(slash + 1).trim()
    if (provider && model) return { provider, model }
  }
}

export function formatAgentModelRef(preset: Pick<AgentPreset, "provider" | "model">) {
  if (!preset.provider || !preset.model) return undefined
  return `${preset.provider}/${preset.model}`
}

export function buildAgentPresetPrompt(userText: string, preset: AgentPreset) {
  const lines = [
    `<system-reminder>The active preset agent is \"${preset.name}\".`,
    preset.description ? `Description: ${preset.description}` : undefined,
    "Apply the following preset-specific instruction in addition to the main system prompt:",
    preset.system_prompt.trim(),
    "</system-reminder>",
    "",
    userText.trim(),
  ].filter((line): line is string => Boolean(line))

  return lines.join("\n")
}

export function serializeAgentPresets(presets: AgentPreset[]) {
  const list = presets
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((preset) => {
      const lines = [
        `  - name: ${escapeYamlScalar(preset.name)}`,
        `    description: ${escapeYamlScalar(preset.description)}`,
        "    system_prompt: |-",
        indentBlock(preset.system_prompt.trim()),
      ]
      if (preset.provider) lines.push(`    provider: ${escapeYamlScalar(preset.provider)}`)
      if (preset.model) lines.push(`    model: ${escapeYamlScalar(preset.model)}`)
      return lines.join("\n")
    })

  return ["agents:", ...list].join("\n") + "\n"
}

function normalizePreset(input: unknown): AgentPreset | undefined {
  if (!input || typeof input !== "object") return
  const value = input as Record<string, unknown>
  if (typeof value.name !== "string" || !value.name.trim()) return
  return {
    name: value.name.trim(),
    description: typeof value.description === "string" ? value.description.trim() : `${value.name.trim()} preset`,
    system_prompt:
      typeof value.system_prompt === "string" && value.system_prompt.trim()
        ? value.system_prompt.trim()
        : createDefaultAgentPreset(value.name.trim()).system_prompt,
    provider: typeof value.provider === "string" && value.provider.trim() ? value.provider.trim() : undefined,
    model: typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined,
  }
}

export function parseAgentPresets(content: string) {
  const wrapped = `---\n${content}\n---\n`
  const parsed = matter(wrapped).data as Record<string, unknown>
  const source = parsed.agents
  const presets = Array.isArray(source)
    ? source.map(normalizePreset).filter((item): item is AgentPreset => Boolean(item))
    : source && typeof source === "object"
      ? Object.entries(source as Record<string, unknown>)
          .map(([name, value]) => normalizePreset({ name, ...(typeof value === "object" && value ? value : {}) }))
          .filter((item): item is AgentPreset => Boolean(item))
      : []

  return presets.toSorted((a, b) => a.name.localeCompare(b.name))
}

export function agentPresetPath(root: string) {
  return path.join(root, VIBE_AGENTS)
}

export async function readAgentPresets(root: string) {
  const filepath = agentPresetPath(root)
  if (!(await Filesystem.exists(filepath))) return [] as AgentPreset[]
  const content = await readFile(filepath, "utf-8")
  return parseAgentPresets(content)
}

export async function writeAgentPresets(root: string, presets: AgentPreset[]) {
  await writeFile(agentPresetPath(root), serializeAgentPresets(presets))
}

export async function upsertAgentPreset(root: string, preset: AgentPreset) {
  const presets = await readAgentPresets(root)
  const next = presets.filter((item) => item.name !== preset.name)
  next.push(preset)
  await writeAgentPresets(root, next)
  return next.toSorted((a, b) => a.name.localeCompare(b.name))
}

export async function deleteAgentPreset(root: string, name: string) {
  const presets = await readAgentPresets(root)
  const next = presets.filter((item) => item.name !== name)
  if (next.length === presets.length) return false
  await writeAgentPresets(root, next)
  return true
}

export async function ensureDefaultAgentPresets(root: string) {
  const existing = await readAgentPresets(root)
  if (existing.length > 0) return existing
  const defaults = ["frontend", "backend", "reviewer", "devops", "designer"].map(createDefaultAgentPreset)
  await writeAgentPresets(root, defaults)
  return defaults.toSorted((a, b) => a.name.localeCompare(b.name))
}
