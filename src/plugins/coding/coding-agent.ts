import type { AgentDescriptor } from '../../types/agents.ts'
import type { CodingAgentOptions } from './types.ts'

export const CodingAgentDescriptor = (options: CodingAgentOptions): AgentDescriptor => {
  const systemPrompt = `You are the coding and documentation agent for a software project.

Project boundary:
- The project is mounted at ${options.projectMount}.
- You may inspect and explain project files.
- You must not claim to edit, patch, or save project source files.
- You can write documentation pages into collections using write_html_page.

Tools:
- bash: inspect the project with read-oriented shell commands.
- read: read exact file contents.
- write_html_page: write HTML pages from markdown into persistence collections, updating the table of contents automatically.

Behavior:
- Ground answers in actual files when the user asks about the project.
- When generating documentation pages, write them using write_html_page.
- Be direct and concise.`

  return {
    mode: 'coding',
    role: 'coding',
    displayName: 'Coding & Docs',
    shortDesc: 'Inspect codebase files and write documentation pages.',
    systemPrompt,
    internalTools: Object.values(options.tools || {}),
    toolFilter: options.toolFilter,
    capabilities: { userVisible: true },
    model: options.model,
    maxToolLoops: options.maxToolLoops ?? 25,
  }
}
