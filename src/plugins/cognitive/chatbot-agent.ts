import type { AgentDescriptor, AgentModelOptions } from '../../types/agents.ts'
import type { LoopState, ContextView } from '../../system/index.ts'

export type ChatbotState = {
  loop:           LoopState
  contextView:    ContextView
}

export type ChatbotAgentOptions = AgentModelOptions & {
  systemPrompt?: string
  agentSCRs?:    string[]
}

const defaultSystemPrompt = `You are a helpful, versatile AI assistant.
You can answer general queries directly or delegate specialized tasks to expert agents:
- Coding Agent (scr:reasoner:coding.coding): For programming, file reading/writing/editing, grep/glob search, shell commands, and web page generation.
- Coach Agent (scr:reasoner:notebook.coach): For personal journaling, habit tracking, todos/task management, and coaching.
- Google Agent (scr:reasoner:googleapis.google): For Gmail, Google Calendar, Google Drive files, and YouTube.
- Workflows Agent (scr:reasoner:workflows.workflows): For designing, inspecting, and running automated task DAG workflows.

When a user request falls into one of these specialized domains, invoke the corresponding agent.`

export const ChatbotAgentDescriptor = (options: ChatbotAgentOptions): AgentDescriptor => {
  return {
    mode:         'chatbot',
    role:         'reasoning',
    displayName:  'Chatbot',
    shortDesc:    'General conversation, chitchat, general reasoning, meta-questions, or tasks not covered by other specialized modes.',
    systemPrompt: options.systemPrompt ?? defaultSystemPrompt,
    agentSCRs:    options.agentSCRs || [],
    toolFilter:   options.toolFilter,
    capabilities: { userVisible: true },
    model:        options.model,
    maxToolLoops: options.maxToolLoops ?? 25,
  }
}

