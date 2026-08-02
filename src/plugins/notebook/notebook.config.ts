import { defineConfig } from '../../system/index.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import type { AgentModelOptions } from '../../types/agents.ts'

// ─── Config type ────────────────────────────────────────────────────────────

export type NotebookConfig = {
  agent?: AgentModelOptions
}

// ─── Schema sections ────────────────────────────────────────────────────────

const notebookSchema: ConfigSchemaSection = {
  id: 'notebook.config',
  title: 'Notebook',
  subtitle: 'notebook · journal, todos, and tracker',
  tab: 'notebook',
  configKey: '',
  schema: {
    type: 'object',
    properties: {
      agent: {
        type: 'object',
        properties: {
          model: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Agent model' } },
          maxToolLoops: { type: 'number', default: 10, minimum: 1, maximum: 50 },
        },
      },
    },
  },
}

const notebookSchemas: ConfigSchemaSection[] = [notebookSchema]

// ─── Defaults + descriptor ──────────────────────────────────────────────────

export const config = defineConfig<NotebookConfig>('notebook', {
  agent: {
    model: 'google/gemini-3.1-pro-preview',
    maxToolLoops: 10,
  },
}, {
  schemas: notebookSchemas,
})