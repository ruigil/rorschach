import { defineConfig } from '../../system/index.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import type { SessionConfig } from './types.ts'
import type { ChatbotAgentOptions } from './chatbot-agent.ts'

// ─── Config type ────────────────────────────────────────────────────────────

type LlmProviderConfig = {
  provider?: 'openrouter' | 'venice'
  apiKey: string
  baseUrl?: string
  reasoning?: { enabled?: boolean; effort?: 'high' | 'medium' | 'low' | 'minimal' }
}

export type UserContextConfig = {
  model:      string
  intervalMs: number
}

export type CognitiveConfig = {
  llmProvider?: LlmProviderConfig
  chatbot?:     ChatbotAgentOptions
  session?:     SessionConfig
  userContext?: UserContextConfig
}

// ─── Schema sections ────────────────────────────────────────────────────────

const chatbotSchema: ConfigSchemaSection = {
  id: 'cognitive.chatbot',
  title: 'Chat',
  subtitle: 'cognitive · language model and reasoning',
  tab: 'cognitive',
  configKey: 'chatbot',
  schema: {
    type: 'object',
    properties: {
      model: { type: 'string', default: 'deepseek/deepseek-v4-flash', 'x-ui': { widget: 'model-select' } },
      systemPrompt: { type: 'string', 'x-ui': { widget: 'textarea', rows: 4, label: 'System prompt' } },
    },
  },
}

const sessionSchema: ConfigSchemaSection = {
  id: 'cognitive.session',
  title: 'Session',
  subtitle: 'cognitive · conversation context',
  tab: 'cognitive',
  configKey: 'session',
  schema: {
    type: 'object',
    properties: {
      contextWindowHours: { type: 'number', default: 4, minimum: 1, description: 'Maximum hours of context records kept in short-term memory' },
      persistContext: {
        type: 'boolean',
        default: false,
        description: 'Persist short-term conversation context across restarts. When false, ContextStore is pure in-memory.',
        'x-ui': { widget: 'toggle', label: 'Persist context' },
      },
    },
  },
}

const llmSchema: ConfigSchemaSection = {
  id: 'cognitive.llm',
  title: 'LLM Provider',
  subtitle: 'cognitive · LLM provider settings',
  tab: 'cognitive',
  configKey: 'llmProvider',
  schema: {
    type: 'object',
    properties: {
      provider: { type: 'string', default: 'openrouter', enum: ['openrouter', 'venice'], 'x-ui': { label: 'Provider' } },
      apiKey: { type: 'string', 'x-ui': { secret: true, label: 'API Key' } },
      baseUrl: { type: 'string', description: 'Custom API base URL (e.g. Venice)', 'x-ui': { label: 'Base URL' } },
      reasoning: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', default: false, 'x-ui': { widget: 'toggle', label: 'Enable reasoning' } },
          effort: { type: 'string', default: 'medium', enum: ['minimal', 'low', 'medium', 'high'] },
        },
      },
    },
  },
}

const userContextSchema: ConfigSchemaSection = {
  id: 'cognitive.userContext',
  title: 'User Context',
  subtitle: 'cognitive · periodic context summary',
  tab: 'cognitive',
  configKey: 'userContext',
  schema: {
    type: 'object',
    properties: {
      model: { type: 'string', default: 'deepseek/deepseek-v4-flash', 'x-ui': { widget: 'model-select' } },
      intervalMs: { type: 'number', default: 60_000, minimum: 60_000, description: 'Interval for updating the user context summary' },
    },
  },
}

const cognitiveSchemas: ConfigSchemaSection[] = [chatbotSchema, sessionSchema, llmSchema, userContextSchema]

// ─── Defaults + descriptor ──────────────────────────────────────────────────

export const defaultConfig: CognitiveConfig = {
  chatbot: {
    model: 'deepseek/deepseek-v4-flash',
  },
  session: {
    defaultMode:        'chatbot',
    contextWindowHours: 4,
    persistContext:     false,
  },
  userContext: {
    model:      'deepseek/deepseek-v4-flash',
    intervalMs: 60_000,
  },
}

export const config = defineConfig<CognitiveConfig>('cognitive', defaultConfig, {
  schemas: cognitiveSchemas,
})