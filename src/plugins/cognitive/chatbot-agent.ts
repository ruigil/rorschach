import type { AgentDescriptor, AgentModelOptions } from '../../types/agents.ts'
import type { ToolCollection } from '../../types/tools.ts'
import type { LoopState, ContextView } from '../../system/index.ts'

export type ChatbotState = {
  loop:           LoopState
  contextView:    ContextView
  tools:          ToolCollection
}

export type ChatbotAgentOptions = AgentModelOptions & {
  systemPrompt?: string
}

export const ChatbotAgentDescriptor = (options: ChatbotAgentOptions): AgentDescriptor => {
  return {
    mode:         'chatbot',
    role:         'reasoning',
    displayName:  'Chatbot',
    shortDesc:    'General-purpose conversational assistant. Use this mode if you cannot find a tool in your set of specialized tools to handle the user\'s request.',
    systemPrompt: options.systemPrompt || '',
    internalTools: [],
    toolFilter:   options.toolFilter,
    capabilities: { userVisible: true },
    model:        options.model,
    maxToolLoops: options.maxToolLoops ?? 25,
  }
}

