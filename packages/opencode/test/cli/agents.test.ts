import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir } from "fs/promises"
import { randomUUID } from "crypto"
import { tmpdir } from "os"
import {
  buildAgentPresetPrompt,
  createDefaultAgentPreset,
  deleteAgentPreset,
  ensureDefaultAgentPresets,
  formatAgentModelRef,
  normalizeAgentModelRef,
  parseAgentPresets,
  readAgentPresets,
  serializeAgentPresets,
  upsertAgentPreset,
} from "../../src/cli/cmd/tui/component/prompt/agents"

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = path.join(tmpdir(), `ghostcode-agents-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  return fn(dir)
}

describe("agent preset helpers", () => {
  test("normalizes provider:model and provider/model refs", () => {
    expect(normalizeAgentModelRef("openai:gpt-5")).toEqual({ provider: "openai", model: "gpt-5" })
    expect(normalizeAgentModelRef("openai/gpt-5")).toEqual({ provider: "openai", model: "gpt-5" })
  })

  test("serializes and parses presets with multiline prompts", () => {
    const content = serializeAgentPresets([
      {
        name: "frontend",
        description: "Frontend preset",
        system_prompt: "Line one\nLine two",
        provider: "openai",
        model: "gpt-5",
      },
    ])

    const parsed = parseAgentPresets(content)
    expect(parsed).toEqual([
      {
        name: "frontend",
        description: "Frontend preset",
        system_prompt: "Line one\nLine two",
        provider: "openai",
        model: "gpt-5",
      },
    ])
  })

  test("builds evidence-free preset wrapper prompt", () => {
    const preset = createDefaultAgentPreset("reviewer")
    const prompt = buildAgentPresetPrompt("Check the diff", preset)
    expect(prompt).toContain('The active preset agent is "reviewer"')
    expect(prompt).toContain("Check the diff")
    expect(prompt).toContain(preset.system_prompt)
  })

  test("creates default presets and updates stored presets", async () => {
    await withTempDir(async (dir) => {
      const defaults = await ensureDefaultAgentPresets(dir)
      expect(defaults.map((item) => item.name)).toEqual(["backend", "designer", "devops", "frontend", "reviewer"])

      await upsertAgentPreset(dir, {
        name: "frontend",
        description: "UI preset",
        system_prompt: "Do frontend work",
        provider: "openai",
        model: "gpt-5",
      })

      const presets = await readAgentPresets(dir)
      expect(presets.find((item) => item.name === "frontend")).toEqual({
        name: "frontend",
        description: "UI preset",
        system_prompt: "Do frontend work",
        provider: "openai",
        model: "gpt-5",
      })
      expect(formatAgentModelRef(presets.find((item) => item.name === "frontend")!)).toBe("openai/gpt-5")

      expect(await deleteAgentPreset(dir, "frontend")).toBe(true)
      expect((await readAgentPresets(dir)).some((item) => item.name === "frontend")).toBe(false)
    })
  })
})
