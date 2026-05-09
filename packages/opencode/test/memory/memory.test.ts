import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Memory, detectSecrets, formatDecisionEntry, matchEditRules, parseProjectRules, summarizeRules } from "../../src/memory"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(Memory.defaultLayer, AppFileSystem.defaultLayer, NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer),
)

describe("memory.detectSecrets", () => {
  it.effect("detects obvious secret-like content", () =>
    Effect.sync(() => {
      expect(detectSecrets("API_KEY=super-secret-value")).toBe(true)
      expect(detectSecrets("-----BEGIN PRIVATE KEY-----")).toBe(true)
      expect(detectSecrets("remember the coding style guide")).toBe(false)
    }),
  )
})

describe("memory service", () => {
  it.effect("parses supported project rule formats", () =>
    Effect.sync(() => {
      const parsed = parseProjectRules([
        "# Rules",
        "DO NOT EDIT src/secret.ts",
        "ASK BEFORE EDIT docs/*.md",
        "PREFER bun",
        "AVOID lodash",
        "UNSUPPORTED something",
      ].join("\n"))

      expect(parsed.rules).toHaveLength(4)
      expect(parsed.rules[0]).toMatchObject({ kind: "do_not_edit", path: "src/secret.ts", line: 2 })
      expect(parsed.rules[1]).toMatchObject({ kind: "ask_before_edit", path: "docs/*.md", line: 3 })
      expect(parsed.rules[2]).toMatchObject({ kind: "prefer", technology: "bun", line: 4 })
      expect(parsed.rules[3]).toMatchObject({ kind: "avoid", technology: "lodash", line: 5 })
      expect(parsed.invalid).toEqual([{ line: 6, raw: "UNSUPPORTED something" }])
    }),
  )

  it.effect("matches edit rules against pending file changes", () =>
    Effect.sync(() => {
      const parsed = parseProjectRules([
        "DO NOT EDIT src/secret.ts",
        "ASK BEFORE EDIT docs/*.md",
      ].join("\n"))
      const guard = matchEditRules(parsed.rules, ["src/secret.ts", "docs/guide.md", "src/other.ts"])

      expect(guard.severity).toBe("do_not_edit")
      expect(guard.matches).toHaveLength(2)
      expect(guard.matches[0]).toMatchObject({ kind: "do_not_edit", matched: "src/secret.ts" })
      expect(guard.matches[1]).toMatchObject({ kind: "ask_before_edit", matched: "docs/guide.md" })
      expect(guard.ruleset).toEqual([
        { permission: "edit", pattern: "src/secret.ts", action: "ask" },
        { permission: "edit", pattern: "docs/guide.md", action: "ask" },
      ])
    }),
  )

  it.effect("formats decision entries with timestamp and optional author", () =>
    Effect.sync(() => {
      expect(
        formatDecisionEntry({
          timestamp: "2026-05-09T12:00:00.000Z",
          author: "ghostcode",
          text: "Use .vibe/decisions.md for team decisions",
        }),
      ).toBe("- [2026-05-09T12:00:00.000Z] [ghostcode] Use .vibe/decisions.md for team decisions")
      expect(
        formatDecisionEntry({
          timestamp: "2026-05-09T12:00:00.000Z",
          text: "Keep decisions lightweight",
        }),
      ).toBe("- [2026-05-09T12:00:00.000Z] Keep decisions lightweight")
    }),
  )

  it.instance("creates .vibe files and returns prompt fragments", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const snapshot = yield* memory.ensure()
      expect(snapshot.directory.endsWith(".vibe")).toBe(true)
      expect(snapshot.files["memory.md"]).toContain("# Memory")
      expect(snapshot.files["rules.md"]).toContain("# Rules")

      yield* memory.add({ text: "Prefer minimal patches" })
      yield* memory.decide({ text: "Use worktree-scoped project memory", author: "ghostcode" })
      yield* memory.add({ file: "context.md", text: "CLI command is ghostcode" })
      yield* memory.add({ file: "rules.md", text: "Never commit .vibe automatically" })

      const prompt = yield* memory.prompt()
      expect(prompt.system.join("\n")).toContain("Never commit .vibe automatically")
      expect(prompt.project.join("\n")).toContain("CLI command is ghostcode")
      expect(prompt.project.join("\n")).toContain("Prefer minimal patches")
      expect(prompt.project.join("\n")).toContain("Use worktree-scoped project memory")
      expect(prompt.project.join("\n")).toContain("[ghostcode]")
    }),
  )

  it.instance("checks parsed rules from .vibe/rules.md", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      yield* memory.add({ file: "rules.md", text: "DO NOT EDIT package-lock.json" })
      yield* memory.add({ file: "rules.md", text: "ASK BEFORE EDIT docs/*.md" })
      yield* memory.add({ file: "rules.md", text: "PREFER bun" })
      yield* memory.add({ file: "rules.md", text: "BROKEN RULE" })

      const check = yield* memory.checkRules()
      expect(check.recognized).toBeGreaterThanOrEqual(3)
      expect(check.pathRules.some((rule) => rule.kind === "do_not_edit" && rule.path === "package-lock.json")).toBe(true)
      expect(check.pathRules.some((rule) => rule.kind === "ask_before_edit" && rule.path === "docs/*.md")).toBe(true)
      expect(check.technologyRules.some((rule) => rule.kind === "prefer" && rule.technology === "bun")).toBe(true)
      expect(check.invalid.some((item) => item.raw === "BROKEN RULE")).toBe(true)

      const summary = summarizeRules("DO NOT EDIT src/index.ts\nAVOID legacy-lib\n")
      expect(summary.recognized).toBe(2)
      expect(summary.invalid).toEqual([])
    }),
  )

  it.instance("records and lists recent decisions", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      yield* memory.decide({ text: "Adopt team decision log", author: "ghostcode" })
      yield* memory.decide({ text: "Keep context small" })

      const entries = yield* memory.decisions(2)
      expect(entries).toHaveLength(2)
      expect(entries[0]).toContain("Adopt team decision log")
      expect(entries[0]).toContain("[ghostcode]")
      expect(entries[1]).toContain("Keep context small")
    }),
  )

  it.instance("searches and forgets matching entries", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      yield* memory.add({ text: "Remember alpha detail" })
      yield* memory.add({ text: "Remember beta detail" })

      const matches = yield* memory.search("beta")
      expect(matches.some((item) => item.text.includes("beta"))).toBe(true)

      const removed = yield* memory.forget("alpha")
      expect(removed).toBeGreaterThan(0)

      const remaining = yield* memory.search("alpha")
      expect(remaining).toEqual([])
    }),
  )

  it.instance("builds, caches, and filters a repo map", () =>
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      const fs = yield* AppFileSystem.Service
      const root = yield* memory.root()
      const projectRoot = path.dirname(root)

      yield* fs.writeWithDirs(
        path.join(projectRoot, "package.json"),
        JSON.stringify(
          {
            name: "ghostcode-test",
            main: "dist/index.js",
            exports: {
              ".": "./dist/index.js",
            },
          },
          null,
          2,
        ),
      )
      yield* fs.writeWithDirs(path.join(projectRoot, "bun.lock"), "")
      yield* fs.writeWithDirs(path.join(projectRoot, "src", "index.ts"), "export const ready = true\n")
      yield* fs.writeWithDirs(path.join(projectRoot, "coverage", "skip.txt"), "ignore me\n")

      const generated = yield* memory.repoMap({ refresh: true })
      expect(generated).toContain("# Repo Map")
      expect(generated).toContain("Package manager: bun")
      expect(generated).toContain("file: src/index.ts")
      expect(generated).not.toContain("coverage/")

      const cached = yield* memory.repoMap()
      expect(cached).toContain("# Repo Map")

      const filtered = yield* memory.repoMap({ topic: "src" })
      expect(filtered).toContain("Repo map matches for: src")
      expect(filtered).toContain("src/")
    }),
  )
})
