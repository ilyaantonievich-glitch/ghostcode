import path from "path"
import { Context, Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@/util/wildcard"

export const DIRNAME = ".vibe"
export const MEMORY_FILENAME = "memory.md"
export const RULES_FILENAME = "rules.md"
export const DECISIONS_FILENAME = "decisions.md"
export const CONTEXT_FILENAME = "context.md"
export const REPO_MAP_FILENAME = "repo-map.md"

const DEFAULT_FILES = {
  [MEMORY_FILENAME]: "# Memory\n",
  [RULES_FILENAME]: "# Rules\n",
  [DECISIONS_FILENAME]: "# Decisions\n",
  [CONTEXT_FILENAME]: "# Context\n",
} as const

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)\b\s*[:=]/i,
  /\b(?:ghp|gho|ghu|github_pat|sk-[A-Za-z0-9]|xox[baprs]-|AIzaSy)[A-Za-z0-9_\-]{10,}/,
  /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*\b\s*[:=]/,
]

export type MemoryFileKey = keyof typeof DEFAULT_FILES

export interface MemorySearchResult {
  readonly file: MemoryFileKey
  readonly line: number
  readonly text: string
}

export interface MemorySnapshot {
  readonly directory: string
  readonly files: Record<MemoryFileKey, string>
}

export interface PromptContext {
  readonly system: string[]
  readonly project: string[]
}

export interface DecisionEntry {
  readonly timestamp: string
  readonly author?: string
  readonly text: string
}

export interface PathRule {
  readonly kind: "do_not_edit" | "ask_before_edit"
  readonly path: string
  readonly line: number
  readonly raw: string
}

export interface TechnologyRule {
  readonly kind: "prefer" | "avoid"
  readonly technology: string
  readonly line: number
  readonly raw: string
}

export type ProjectRule = PathRule | TechnologyRule

export interface ParsedRules {
  readonly rules: ProjectRule[]
  readonly invalid: Array<{
    readonly line: number
    readonly raw: string
  }>
}

export interface RuleCheck {
  readonly total: number
  readonly recognized: number
  readonly invalid: Array<{
    readonly line: number
    readonly raw: string
  }>
  readonly pathRules: PathRule[]
  readonly technologyRules: TechnologyRule[]
}

export interface EditRuleMatch {
  readonly kind: PathRule["kind"]
  readonly path: string
  readonly matched: string
  readonly line: number
  readonly raw: string
}

export interface EditRuleGuard {
  readonly ruleset: Array<{
    readonly permission: "edit"
    readonly pattern: string
    readonly action: "ask"
  }>
  readonly matches: EditRuleMatch[]
  readonly severity?: "do_not_edit" | "ask_before_edit"
}

export interface Interface {
  readonly root: () => Effect.Effect<string>
  readonly ensure: () => Effect.Effect<MemorySnapshot, AppFileSystem.Error>
  readonly read: () => Effect.Effect<MemorySnapshot, AppFileSystem.Error>
  readonly add: (input: { file?: MemoryFileKey; text: string }) => Effect.Effect<void, AppFileSystem.Error>
  readonly decide: (input: { text: string; author?: string }) => Effect.Effect<void, AppFileSystem.Error>
  readonly decisions: (count?: number) => Effect.Effect<string[], AppFileSystem.Error>
  readonly forget: (query: string) => Effect.Effect<number, AppFileSystem.Error>
  readonly search: (query: string) => Effect.Effect<MemorySearchResult[], AppFileSystem.Error>
  readonly rules: () => Effect.Effect<ProjectRule[], AppFileSystem.Error>
  readonly checkRules: () => Effect.Effect<RuleCheck, AppFileSystem.Error>
  readonly editGuard: (paths: string[]) => Effect.Effect<EditRuleGuard, AppFileSystem.Error>
  readonly repoMap: (input?: { refresh?: boolean; topic?: string; depth?: number }) => Effect.Effect<string, AppFileSystem.Error>
  readonly prompt: () => Effect.Effect<PromptContext, AppFileSystem.Error>
  readonly detectSecrets: (text: string) => boolean
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

function fileOrder(): MemoryFileKey[] {
  return [RULES_FILENAME, CONTEXT_FILENAME, MEMORY_FILENAME, DECISIONS_FILENAME]
}

function normalizeLine(line: string) {
  return line.replace(/^[-*]\s+/, "").trim()
}

function matchLines(content: string, query: string, file: MemoryFileKey) {
  const needle = query.trim().toLowerCase()
  if (!needle) return [] as MemorySearchResult[]
  return content
    .split(/\r?\n/)
    .map((text, index) => ({ file, line: index + 1, text } satisfies MemorySearchResult))
    .filter((entry) => entry.text.toLowerCase().includes(needle))
}

function stripMatchingLines(content: string, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return { next: content, removed: 0 }
  const lines = content.split(/\r?\n/)
  const kept: string[] = []
  let removed = 0
  for (const line of lines) {
    if (normalizeLine(line).toLowerCase().includes(needle)) {
      removed += 1
      continue
    }
    kept.push(line)
  }
  const next = kept.join("\n").replace(/\n{3,}/g, "\n\n")
  return { next: next.endsWith("\n") ? next : next + "\n", removed }
}

function tailEntries(content: string, count: number) {
  const entries = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
  return entries.slice(-count)
}

function normalizeRulePath(input: string) {
  return input.trim().replaceAll("\\", "/")
}

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

export function parseProjectRules(content: string): ParsedRules {
  const rules: ProjectRule[] = []
  const invalid: ParsedRules["invalid"] = []

  for (const [index, original] of content.split(/\r?\n/).entries()) {
    const line = original.trim()
    if (!line || line.startsWith("#")) continue

    let match = line.match(/^DO NOT EDIT\s+(.+)$/i)
    if (match) {
      rules.push({
        kind: "do_not_edit",
        path: normalizeRulePath(match[1]),
        line: index + 1,
        raw: original,
      })
      continue
    }

    match = line.match(/^ASK BEFORE EDIT\s+(.+)$/i)
    if (match) {
      rules.push({
        kind: "ask_before_edit",
        path: normalizeRulePath(match[1]),
        line: index + 1,
        raw: original,
      })
      continue
    }

    match = line.match(/^PREFER\s+(.+)$/i)
    if (match) {
      rules.push({
        kind: "prefer",
        technology: match[1].trim(),
        line: index + 1,
        raw: original,
      })
      continue
    }

    match = line.match(/^AVOID\s+(.+)$/i)
    if (match) {
      rules.push({
        kind: "avoid",
        technology: match[1].trim(),
        line: index + 1,
        raw: original,
      })
      continue
    }

    invalid.push({ line: index + 1, raw: original })
  }

  return { rules, invalid }
}

export function summarizeRules(content: string): RuleCheck {
  const parsed = parseProjectRules(content)
  const pathRules = parsed.rules.filter((rule): rule is PathRule => rule.kind === "do_not_edit" || rule.kind === "ask_before_edit")
  const technologyRules = parsed.rules.filter((rule): rule is TechnologyRule => rule.kind === "prefer" || rule.kind === "avoid")
  return {
    total: parsed.rules.length + parsed.invalid.length,
    recognized: parsed.rules.length,
    invalid: parsed.invalid,
    pathRules,
    technologyRules,
  }
}

export function matchEditRules(rules: ProjectRule[], paths: string[]): EditRuleGuard {
  const matches = paths.flatMap((matched) => {
    const normalized = normalizeRulePath(matched)
    return rules.flatMap((rule) => {
      if (rule.kind !== "do_not_edit" && rule.kind !== "ask_before_edit") return []
      if (!Wildcard.match(normalized, rule.path)) return []
      return [{ kind: rule.kind, path: rule.path, matched: normalized, line: rule.line, raw: rule.raw } satisfies EditRuleMatch]
    })
  })

  const uniqueMatches = matches.filter(
    (match, index) =>
      matches.findIndex(
        (candidate) =>
          candidate.kind === match.kind &&
          candidate.path === match.path &&
          candidate.matched === match.matched &&
          candidate.line === match.line,
      ) === index,
  )
  const severity = uniqueMatches.some((rule) => rule.kind === "do_not_edit")
    ? "do_not_edit"
    : uniqueMatches.some((rule) => rule.kind === "ask_before_edit")
      ? "ask_before_edit"
      : undefined

  return {
    ruleset: uniqueMatches.map((match) => ({ permission: "edit" as const, pattern: match.matched, action: "ask" as const })),
    matches: uniqueMatches,
    severity,
  }
}

export function formatDecisionEntry(input: DecisionEntry) {
  const author = input.author?.trim() ? ` [${input.author.trim()}]` : ""
  return `- [${input.timestamp}]${author} ${input.text.trim()}`
}

export function detectSecrets(text: string) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text))
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const root = Effect.fn("Memory.root")(function* () {
      const ctx = yield* InstanceState.context
      return path.join(ctx.worktree, DIRNAME)
    })

    const readFile = Effect.fn("Memory.readFile")(function* (file: MemoryFileKey) {
      const dir = yield* root()
      const filepath = path.join(dir, file)
      return yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed(DEFAULT_FILES[file])))
    })

    const readOptionalFile = Effect.fn("Memory.readOptionalFile")(function* (name: string, fallback = "") {
      const dir = yield* root()
      const filepath = path.join(dir, name)
      return yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed(fallback)))
    })

    const ensure = Effect.fn("Memory.ensure")(function* () {
      const dir = yield* root()
      yield* fs.ensureDir(dir)
      for (const file of fileOrder()) {
        const filepath = path.join(dir, file)
        if (yield* fs.existsSafe(filepath)) continue
        yield* fs.writeFileString(filepath, DEFAULT_FILES[file])
      }
      const files = {} as Record<MemoryFileKey, string>
      for (const file of fileOrder()) files[file] = yield* readFile(file)
      return { directory: dir, files } satisfies MemorySnapshot
    })

    const read = Effect.fn("Memory.read")(function* () {
      yield* ensure()
      const dir = yield* root()
      const files = {} as Record<MemoryFileKey, string>
      for (const file of fileOrder()) files[file] = yield* readFile(file)
      return { directory: dir, files } satisfies MemorySnapshot
    })

    const add = Effect.fn("Memory.add")(function* (input: { file?: MemoryFileKey; text: string }) {
      const target = input.file ?? MEMORY_FILENAME
      const snapshot = yield* read()
      const filepath = path.join(snapshot.directory, target)
      const stamp = new Date().toISOString()
      const prefix = target === MEMORY_FILENAME || target === DECISIONS_FILENAME ? `- [${stamp}] ` : "\n"
      const block = target === MEMORY_FILENAME || target === DECISIONS_FILENAME ? `${prefix}${input.text.trim()}\n` : `${input.text.trim()}\n`
      const next = snapshot.files[target].endsWith("\n")
        ? snapshot.files[target] + block
        : snapshot.files[target] + "\n" + block
      yield* fs.writeFileString(filepath, next)
    })

    const decide = Effect.fn("Memory.decide")(function* (input: { text: string; author?: string }) {
      const snapshot = yield* read()
      const filepath = path.join(snapshot.directory, DECISIONS_FILENAME)
      const entry = formatDecisionEntry({
        timestamp: new Date().toISOString(),
        author: input.author,
        text: input.text,
      })
      const next = snapshot.files[DECISIONS_FILENAME].endsWith("\n")
        ? snapshot.files[DECISIONS_FILENAME] + entry + "\n"
        : snapshot.files[DECISIONS_FILENAME] + "\n" + entry + "\n"
      yield* fs.writeFileString(filepath, next)
    })

    const decisions = Effect.fn("Memory.decisions")(function* (count = 8) {
      const snapshot = yield* read()
      return tailEntries(snapshot.files[DECISIONS_FILENAME], count)
    })

    const forget = Effect.fn("Memory.forget")(function* (query: string) {
      const snapshot = yield* read()
      let removed = 0
      for (const file of [MEMORY_FILENAME, DECISIONS_FILENAME, CONTEXT_FILENAME] satisfies MemoryFileKey[]) {
        const result = stripMatchingLines(snapshot.files[file], query)
        if (result.removed === 0) continue
        removed += result.removed
        yield* fs.writeFileString(path.join(snapshot.directory, file), result.next)
      }
      return removed
    })

    const search = Effect.fn("Memory.search")(function* (query: string) {
      const snapshot = yield* read()
      return fileOrder().flatMap((file) => matchLines(snapshot.files[file], query, file))
    })

    const rules = Effect.fn("Memory.rules")(function* () {
      const snapshot = yield* read()
      return parseProjectRules(snapshot.files[RULES_FILENAME]).rules
    })

    const checkRules = Effect.fn("Memory.checkRules")(function* () {
      const snapshot = yield* read()
      return summarizeRules(snapshot.files[RULES_FILENAME])
    })

    const editGuard = Effect.fn("Memory.editGuard")(function* (paths: string[]) {
      const currentRules = yield* rules()
      return matchEditRules(currentRules, paths)
    })

    const buildRepoMap = Effect.fn("Memory.buildRepoMap")(function* (topic?: string, requestedDepth?: number) {
      const ctx = yield* InstanceState.context
      const worktree = ctx.worktree
      const depth =
        !requestedDepth || !Number.isInteger(requestedDepth) || requestedDepth < 1 || requestedDepth > 6
          ? 3
          : requestedDepth

      const entries = yield* fs.readDirectoryEntries(worktree).pipe(Effect.orElseSucceed(() => []))
      const topLevel = new Set(entries.map((entry) => entry.name))
      const dependencyFiles = REPO_MAP_DEPENDENCY_FILES.filter((file) => topLevel.has(file))
      const packageJson = topLevel.has("package.json")
        ? ((yield* fs.readJson(path.join(worktree, "package.json")).pipe(Effect.orElseSucceed(() => ({})))) as Record<
            string,
            unknown
          >)
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

      const visit: (dir: string, level: number) => Effect.Effect<void, AppFileSystem.Error> = Effect.fnUntraced(function* (
        dir: string,
        level: number,
      ) {
        if (level >= depth || lines.length >= REPO_MAP_STRUCTURE_LIMIT) {
          truncated = truncated || lines.length >= REPO_MAP_STRUCTURE_LIMIT
          return
        }

        const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.orElseSucceed(() => []))
        const sorted = yield* Effect.forEach(
          entries,
          Effect.fnUntraced(function* (entry) {
            if (REPO_MAP_IGNORED_DIRS.has(entry.name)) return undefined
            if (entry.name.endsWith(".lock") || entry.name.endsWith(".cache")) return undefined
            const full = path.join(dir, entry.name)
            const info = yield* fs.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!info) return undefined
            return { name: entry.name, full, directory: info.type === "Directory" }
          }),
          { concurrency: 16 },
        ).pipe(
          Effect.map((items) =>
            items
              .filter((item): item is { name: string; full: string; directory: boolean } => Boolean(item))
              .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)),
          ),
        )

        for (const entry of sorted) {
          if (lines.length >= REPO_MAP_STRUCTURE_LIMIT) {
            truncated = true
            return
          }

          lines.push(`${"  ".repeat(level)}${entry.name}${entry.directory ? "/" : ""}`)
          if (entry.directory) yield* visit(entry.full, level + 1)
        }
      })

      yield* visit(worktree, 0)
      const commonEntrypoints = repoMapCommonEntrypoints(
        new Set([
          ...topLevel,
          ...entries
            .filter((entry) => entry.name === "src")
            .flatMap(() => ["src/index.ts", "src/index.tsx", "src/index.js", "src/main.ts", "src/main.js"]),
        ]),
      )

      const content = [
        "# Repo Map",
        "",
        `Path: ${worktree}`,
        `Generated: ${new Date().toISOString()}`,
        `Depth: ${depth}`,
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

      return topic ? filterRepoMap(content, topic) : content
    })

    const repoMap = Effect.fn("Memory.repoMap")(function* (input?: { refresh?: boolean; topic?: string; depth?: number }) {
      const dir = yield* root()
      const filepath = path.join(dir, REPO_MAP_FILENAME)
      const refresh = input?.refresh === true
      if (!refresh && (yield* fs.existsSafe(filepath))) {
        const cached = yield* readOptionalFile(REPO_MAP_FILENAME)
        return input?.topic ? filterRepoMap(cached, input.topic) : cached
      }

      const built = yield* buildRepoMap(input?.topic, input?.depth)
      if (!input?.topic) yield* fs.writeFileString(filepath, built)
      if (input?.topic) {
        const full = yield* buildRepoMap(undefined, input?.depth)
        yield* fs.writeFileString(filepath, full)
      }
      return built
    })

    const prompt = Effect.fn("Memory.prompt")(function* () {
      const snapshot = yield* read()
      const rules = snapshot.files[RULES_FILENAME].trim()
      const context = snapshot.files[CONTEXT_FILENAME].trim()
      const recentMemory = tailEntries(snapshot.files[MEMORY_FILENAME], 8)
      const recentDecisions = tailEntries(snapshot.files[DECISIONS_FILENAME], 6)
      const repoMap = (yield* readOptionalFile(REPO_MAP_FILENAME)).trim()
      return {
        system: rules && rules !== "# Rules" ? [`Project rules from: ${path.join(snapshot.directory, RULES_FILENAME)}\n${rules}`] : [],
        project: [
          ...(context && context !== "# Context"
            ? [`Project context from: ${path.join(snapshot.directory, CONTEXT_FILENAME)}\n${context}`]
            : []),
          ...(recentMemory.length
            ? [`Recent project memory from: ${path.join(snapshot.directory, MEMORY_FILENAME)}\n${recentMemory.join("\n")}`]
            : []),
          ...(recentDecisions.length
            ? [`Recent project decisions from: ${path.join(snapshot.directory, DECISIONS_FILENAME)}\n${recentDecisions.join("\n")}`]
            : []),
          ...(repoMap && repoMap !== "# Repo Map"
            ? [`Project repo map from: ${path.join(snapshot.directory, REPO_MAP_FILENAME)}\n${repoMap}`]
            : []),
        ],
      } satisfies PromptContext
    })

    return Service.of({
      root,
      ensure,
      read,
      add,
      decide,
      decisions,
      forget,
      search,
      rules,
      checkRules,
      editGuard,
      repoMap,
      prompt,
      detectSecrets,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as Memory from "./index"
