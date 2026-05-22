import type { ConfigSchemaSection } from '../../types/config.ts'

// ─── Config Schema Sections ──────────────────────────────────────────────────

export const chatbotSchema: ConfigSchemaSection = {
  id: 'cognitive.chatbot',
  title: 'Chat',
  subtitle: 'cognitive · language model and reasoning',
  tab: 'cognitive',
  configKey: 'chatbot',
  routeId: 'config.cognitive',
  schema: {
    type: 'object',
    properties: {
      model: { type: 'string', default: 'deepseek/deepseek-v4-flash', 'x-ui': { widget: 'model-select' } },
      systemPrompt: { type: 'string', 'x-ui': { widget: 'textarea', rows: 4, label: 'System prompt' } },
    },
  },
}

export const sessionSchema: ConfigSchemaSection = {
  id: 'cognitive.session',
  title: 'Session',
  subtitle: 'cognitive · conversation context',
  tab: 'cognitive',
  configKey: 'session',
  routeId: 'config.cognitive',
  schema: {
    type: 'object',
    properties: {
      contextWindowHours: { type: 'number', default: 4, minimum: 1, description: 'Maximum hours of context records kept in short-term memory' },
      contextPath: { type: 'string', default: 'workspace/context', description: 'Base path for storing conversation context and user context' },
    },
  },
}

export const llmSchema: ConfigSchemaSection = {
  id: 'cognitive.llm',
  title: 'Reasoning',
  subtitle: 'cognitive · LLM provider settings',
  tab: 'cognitive',
  configKey: 'llmProvider.reasoning',
  routeId: 'config.cognitive',
  schema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: false, 'x-ui': { widget: 'toggle', label: 'Enable reasoning' } },
      effort: { type: 'string', default: 'medium', enum: ['minimal', 'low', 'medium', 'high'] },
    },
  },
}
export const userContextSchema: ConfigSchemaSection = {
  id: 'cognitive.userContext',
  title: 'User Context',
  subtitle: 'cognitive · periodic context summary',
  tab: 'cognitive',
  configKey: 'userContext',
  routeId: 'config.cognitive',
  schema: {
    type: 'object',
    properties: {
      model: { type: 'string', default: 'deepseek/deepseek-v4-flash', 'x-ui': { widget: 'model-select' } },
      intervalMs: { type: 'number', default: 60_000, minimum: 60_000, description: 'Interval for updating the user context summary' },
    },
  },
}

export const cognitiveSchemas = [chatbotSchema, sessionSchema, llmSchema, userContextSchema]
