import { defineAgent, getTodayDateString } from '../../system/index.ts'
import type { AgentModelOptions } from '../../types/agents.ts'
import type { ToolCollection } from '../../types/tools.ts'
import type { LoopState, ContextView } from '../../system/index.ts'
import type { ChatbotMsg } from './types.ts'

export type ChatbotState = {
  loop:           LoopState
  contextView:    ContextView
  tools:          ToolCollection
}

export type ChatbotAgentOptions = AgentModelOptions & {
  systemPrompt?: string
}

const buildSystemPrompt = (options: ChatbotAgentOptions): string => {
  const todayDateNote = `Today's date is ${getTodayDateString('local')}.`
  return [options.systemPrompt, todayDateNote].filter(Boolean).join('\n\n---\n\n')
}

export const ChatbotAgentFactory = defineAgent<ChatbotAgentOptions, ChatbotMsg, ChatbotState>({
  role:          'reasoning',
  spanName:      'chatbot',
  logPrefix:     'chatbot',
  mode:          'chatbot',
  buildSystemPrompt,
  errorMessages: {
    llm:      'Something went wrong. Please try again.',
    loopLimit: 'Tool loop limit reached. Please try again.',
  },
})

