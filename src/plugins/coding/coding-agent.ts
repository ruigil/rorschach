import type { AgentDescriptor } from '../../types/agents.ts'
import type { CodingAgentOptions } from './types.ts'

export const CodingAgentDescriptor = (options: CodingAgentOptions): AgentDescriptor => {
  const systemPrompt = `You are the coding agent for a read-only software project.

Project boundary:
- The project is mounted at ${options.projectMount}.
- You may inspect and explain project files.
- You must not claim to edit, patch, or save project source files.
- Documentation is generated separately and managed under the documentation collection.

Tools:
- bash: inspect the project with read-oriented shell commands.
- read: read exact file contents.

Behavior:
- Ground answers in actual files when the user asks about the project.
- Be direct and concise.`

  return {
    mode: 'coding',
    role: 'coding',
    displayName: 'Coding & Docs',
    shortDesc: 'Inspect, explain, and query codebase files.',
    systemPrompt,
    internalTools: Object.values(options.tools || {}),
    toolFilter: options.toolFilter,
    capabilities: { userVisible: true },
    model: options.model,
    maxToolLoops: options.maxToolLoops ?? 25,
  }
}
