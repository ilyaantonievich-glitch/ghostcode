import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { randomUUID } from "crypto"
import { buildAskPrompt, collectAskContext, extractRepoMapPaths, tokenizeAskQuestion } from "../../src/cli/cmd/tui/component/prompt/ask"

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = path.join(tmpdir(), `ghostcode-ask-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  return fn(dir)
}

describe("ask helpers", () => {
  test("tokenizes question into useful search terms", () => {
    expect(tokenizeAskQuestion("Where does auth work in the repository?")).toEqual(["auth"])
  })

  test("extracts repo map paths from cached map text", () => {
    const paths = extractRepoMapPaths([
      "# Repo Map",
      "file: src/auth/index.ts",
      "file: src/billing/index.ts",
      "Path: C:/repo",
    ].join("\n"))

    expect(paths).toContain("src/auth/index.ts")
    expect(paths).toContain("src/billing/index.ts")
  })

  test("collects repo evidence and builds ask prompt", async () => {
    await withTempDir(async (dir) => {
      await mkdir(path.join(dir, "src", "auth"), { recursive: true })
      await mkdir(path.join(dir, "src", "billing"), { recursive: true })
      await writeFile(
        path.join(dir, "src", "auth", "index.ts"),
        [
          "export function requireAuth() {",
          "  return { enabled: true }",
          "}",
        ].join("\n"),
      )
      await writeFile(path.join(dir, "src", "billing", "index.ts"), "export const billing = true\n")

      const repoMap = [
        "# Repo Map",
        "file: src/auth/index.ts",
        "file: src/billing/index.ts",
        "Top-level structure:",
        "src/",
        "  auth/",
        "    index.ts",
        "  billing/",
        "    index.ts",
      ].join("\n")

      const context = await collectAskContext({
        projectRoot: dir,
        question: "Where is auth?",
        repoMap,
      })

      expect(context.files.some((file) => file.path === "src/auth/index.ts")).toBe(true)
      expect(context.files.flatMap((file) => file.snippets).some((snippet) => snippet.text.includes("requireAuth"))).toBe(true)

      const prompt = buildAskPrompt("Where is auth?", context)
      expect(prompt).toContain("User question: Where is auth?")
      expect(prompt).toContain("File: src/auth/index.ts")
      expect(prompt).toContain("line 1")
      expect(prompt).toContain("confidence")
    })
  })
})
