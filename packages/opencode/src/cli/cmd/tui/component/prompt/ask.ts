import path from "path"
import { readFile, readdir, stat } from "fs/promises"

const IGNORED_DIRS = new Set([
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

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "where",
  "what",
  "when",
  "how",
  "does",
  "work",
  "works",
  "change",
  "find",
  "repo",
  "repository",
  "file",
  "files",
  "code",
  "about",
  "into",
  "have",
  "there",
  "would",
])

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".toml",
  ".css",
  ".scss",
  ".html",
  ".xml",
  ".sh",
  ".ps1",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".sql",
])

const MAX_FILE_COUNT = 2500
const MAX_SCAN_FILES = 400
const MAX_FILE_BYTES = 96_000
const MAX_CANDIDATE_FILES = 8
const MAX_SNIPPETS = 12

export interface AskSnippet {
  readonly path: string
  readonly line: number
  readonly text: string
}

export interface AskFileEvidence {
  readonly path: string
  readonly score: number
  readonly snippets: AskSnippet[]
}

export interface AskContext {
  readonly repoMapExcerpt: string[]
  readonly files: AskFileEvidence[]
  readonly confidence: "high" | "medium" | "low"
  readonly insufficient: boolean
}

export function tokenizeAskQuestion(question: string) {
  return [...new Set(question.toLowerCase().split(/[^a-z0-9_./-]+/).filter((token) => token.length >= 3 && !STOP_WORDS.has(token)))]
}

export function extractRepoMapPaths(repoMap: string) {
  const paths = new Set<string>()

  for (const raw of repoMap.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue

    const fileMatch = line.match(/^(?:main|module|types|bin|file):\s+(.+)$/)
    if (fileMatch) {
      const candidate = fileMatch[1].trim().replaceAll("\\", "/")
      if (candidate.includes("/") || candidate.includes(".")) paths.add(candidate)
      continue
    }

    if (line.includes(":")) continue
    if (line.startsWith("(") && line.endsWith(")")) continue

    const candidate = line.replaceAll("\\", "/").replace(/\/$/, "")
    if (!candidate || candidate.startsWith("- ")) continue
    if (candidate.includes("/") || candidate.includes(".")) paths.add(candidate)
  }

  return [...paths]
}

function scorePath(file: string, tokens: string[], repoMapHints: Set<string>) {
  const normalized = file.replaceAll("\\", "/").toLowerCase()
  const base = path.basename(normalized)
  let score = 0

  for (const token of tokens) {
    if (base.includes(token)) score += 6
    else if (normalized.includes(token)) score += 3
  }

  if (repoMapHints.has(normalized)) score += 8
  return score
}

function isTextFile(file: string) {
  const ext = path.extname(file).toLowerCase()
  return TEXT_EXTENSIONS.has(ext) || path.basename(file).toLowerCase() === "package.json"
}

async function listFiles(root: string) {
  const result: string[] = []

  async function walk(dir: string): Promise<void> {
    if (result.length >= MAX_FILE_COUNT) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      if (result.length >= MAX_FILE_COUNT) return
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        if (entry.name.endsWith(".cache") || entry.name.endsWith(".lock")) continue
        await walk(path.join(dir, entry.name))
        continue
      }
      result.push(path.relative(root, path.join(dir, entry.name)).replaceAll("\\", "/"))
    }
  }

  await walk(root)
  return result
}

function excerptRepoMap(repoMap: string, tokens: string[]) {
  if (tokens.length === 0) return repoMap.split(/\r?\n/).slice(0, 30)
  const lines = repoMap.split(/\r?\n/)
  const matches = lines.filter((line) => tokens.some((token) => line.toLowerCase().includes(token)))
  return matches.slice(0, 30)
}

async function readSnippets(projectRoot: string, file: string, tokens: string[]) {
  if (!isTextFile(file)) return [] as AskSnippet[]

  const absolute = path.join(projectRoot, file)
  const info = await stat(absolute).catch(() => undefined)
  if (!info || !info.isFile() || info.size > MAX_FILE_BYTES) return []

  const content = await readFile(absolute, "utf-8").catch(() => "")
  if (!content || content.includes("\u0000")) return []

  const snippets: AskSnippet[] = []
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const lowered = line.toLowerCase()
    if (!tokens.some((token) => lowered.includes(token))) continue
    snippets.push({ path: file, line: index + 1, text: line.trim().slice(0, 240) })
    if (snippets.length >= 3) break
  }
  return snippets
}

export async function collectAskContext(input: { projectRoot: string; question: string; repoMap: string }) {
  const tokens = tokenizeAskQuestion(input.question)
  const repoMapPaths = extractRepoMapPaths(input.repoMap)
  const repoMapHints = new Set(repoMapPaths.map((item) => item.toLowerCase()))
  const files = await listFiles(input.projectRoot)

  const ranked = files
    .map((file) => ({ file, score: scorePath(file, tokens, repoMapHints) }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))

  const scanPool = ranked.some((item) => item.score > 0) ? ranked.slice(0, MAX_SCAN_FILES) : ranked.slice(0, Math.min(ranked.length, MAX_SCAN_FILES))
  const evidence: AskFileEvidence[] = []

  for (const item of scanPool) {
    const snippets = await readSnippets(input.projectRoot, item.file, tokens)
    if (snippets.length === 0 && item.score <= 0) continue
    const score = item.score + snippets.length * 5
    if (score <= 0) continue
    evidence.push({ path: item.file, score, snippets })
  }

  const selected = evidence
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, MAX_CANDIDATE_FILES)
    .map((file) => ({ ...file, snippets: file.snippets.slice(0, 2) }))

  const snippetCount = selected.reduce((count, file) => count + file.snippets.length, 0)
  const confidence = snippetCount >= 5 ? "high" : snippetCount >= 2 || selected.length >= 2 ? "medium" : "low"

  return {
    repoMapExcerpt: excerptRepoMap(input.repoMap, tokens),
    files: selected,
    confidence,
    insufficient: selected.length === 0 && tokens.length > 0,
  } satisfies AskContext
}

export function buildAskPrompt(question: string, context: AskContext) {
  const repoMapSection = context.repoMapExcerpt.length ? context.repoMapExcerpt.join("\n") : "No relevant repo map lines found."
  const fileSection = context.files.length
    ? context.files
        .map((file) =>
          [
            `File: ${file.path}`,
            `Score: ${file.score}`,
            ...(file.snippets.length
              ? file.snippets.slice(0, MAX_SNIPPETS).map((snippet) => `- line ${snippet.line}: ${snippet.text}`)
              : ["- No direct text snippet match found."]),
          ].join("\n"),
        )
        .join("\n\n")
    : "No relevant files found."

  return [
    "You are answering a repository question using only the repository evidence below.",
    "Do not guess. If the evidence is insufficient, say the answer was not found in the repository.",
    "Your response must include:",
    "- a short answer;",
    "- relevant files;",
    "- line numbers or snippets when available;",
    "- confidence level: high, medium, or low.",
    "",
    `User question: ${question}`,
    `Initial evidence confidence: ${context.confidence}`,
    `Evidence completeness: ${context.insufficient ? "insufficient" : "usable"}`,
    "",
    "Repo map excerpt:",
    repoMapSection,
    "",
    "Relevant file evidence:",
    fileSection,
  ].join("\n")
}
