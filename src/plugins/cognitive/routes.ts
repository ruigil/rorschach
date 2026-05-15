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
  subtitle: 'cognitive · conversation history',
  tab: 'cognitive',
  configKey: 'session',
  routeId: 'config.cognitive',
  schema: {
    type: 'object',
    properties: {
      historyWindowHours: { type: 'number', default: 4, minimum: 1, description: 'Maximum hours of message history kept in short-term memory' },
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

export const plannerSchema: ConfigSchemaSection = {
  id: 'cognitive.planner',
  title: 'Planner',
  subtitle: 'cognitive · structured planning agent',
  tab: 'cognitive',
  configKey: 'planner',
  routeId: 'config.cognitive',
  schema: {
    type: 'object',
    properties: {
      model: { type: 'string', default: 'z-ai/glm-5.1', 'x-ui': { widget: 'model-select', label: 'Planner model' } },
      plansDir: { type: 'string', default: 'workspace/plans' },
      maxToolLoops: { type: 'number', default: 10, minimum: 1, maximum: 50 },
    },
  },
}

export const cognitiveSchemas = [chatbotSchema, sessionSchema, llmSchema, plannerSchema]
