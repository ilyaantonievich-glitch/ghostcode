import { readAgentPresets, type AgentPreset } from "./agents"

export type DebateAgent = {
  preset: AgentPreset
  relevanceScore: number
}

const DEBATE_WARNING =
  "<system-reminder>This is an AI Agents Debate session. This command may consume more tokens than a regular query because multiple agent perspectives are gathered before summarization.</system-reminder>\n\n"

const DEBATE_SYSTEM_PROMPT = `You are moderating an architectural debate between multiple AI agent perspectives.

Your task:
1. Present the question to each agent perspective below
2. Gather their individual viewpoints
3. Synthesize into a structured summary with:
   - Options/Approaches considered
   - Pros of each
   - Cons/Risks of each
   - Recommendations
   - Next steps

Be objective - represent each agent's view fairly.`

export function selectRelevantAgents(presets: AgentPreset[], question: string): DebateAgent[] {
  const keywords = question.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
  if (keywords.length === 0) return presets.slice(0, 3).map((p) => ({ preset: p, relevanceScore: 1 }))

  return presets
    .map((preset) => {
      let score = 0
      const name = preset.name.toLowerCase()
      const desc = preset.description.toLowerCase()
      const prompt = preset.system_prompt.toLowerCase()

      for (const kw of keywords) {
        if (name.includes(kw)) score += 3
        if (desc.includes(kw)) score += 2
        if (prompt.includes(kw)) score += 1
      }

      return { preset, relevanceScore: score }
    })
    .filter((item) => item.relevanceScore > 0)
    .toSorted((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 3)
}

export function buildDebatePrompt(question: string, agents: DebateAgent[]) {
  const agentList = agents
    .map((item, i) => `${i + 1}. **${item.preset.name}** - ${item.preset.description}`)
    .join("\n")

  const agentSections = agents
    .map(
      (item, i) =>
        `--- Agent ${i + 1}: ${item.preset.name} ---\n${item.preset.system_prompt}\n\n[Your answer as ${item.preset.name}]`,
    )
    .join("\n\n")

  return (
    DEBATE_WARNING +
    `${DEBATE_SYSTEM_PROMPT}

## Question
${question}

## Participating Agents
${agentList}

## Agent Perspectives

For each agent below, imagine you are that agent type and answer the question from their perspective:

${agentSections}

## Output Format
After each agent answers, provide a synthesis:
- **Options considered**: ...
- **Pros**: ...
- **Cons/Risks**: ...
- **Recommendation**: ...
- **Next steps**: ...`
  )
}

export async function loadDebateAgents(root: string, question: string) {
  const presets = await readAgentPresets(root)
  if (presets.length === 0) return []
  return selectRelevantAgents(presets, question)
}