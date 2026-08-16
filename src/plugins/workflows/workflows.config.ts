import { defineConfig } from '../../system/index.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import type { AgentModelOptions } from '../../types/agents.ts'

// ─── Config type ────────────────────────────────────────────────────────────

export type WorkflowsConfig = {
  agent: AgentModelOptions
}

// ─── Schema sections ────────────────────────────────────────────────────────

const workflowsStorageSchema: ConfigSchemaSection = {
  id: 'workflows.storage',
  title: 'Workflows',
  subtitle: 'workflow storage and agent',
  tab: 'workflows',
  configKey: '',
  schema: {
    type: 'object',
    required: ['agent'],
    properties: {
      agent: {
        type: 'object',
        required: ['model', 'maxToolLoops'],
        properties: {
          model: { type: 'string', default: 'z-ai/glm-5.1', 'x-ui': { widget: 'model-select', label: 'Workflows model' } },
          maxToolLoops: { type: 'number', default: 10, minimum: 1, maximum: 50 },
        },
      },
    },
  },
}

const workflowsSchemas: ConfigSchemaSection[] = [workflowsStorageSchema]

// ─── Defaults + descriptor ──────────────────────────────────────────────────

export const defaultConfig: WorkflowsConfig = {
  agent: {
    model: 'z-ai/glm-5.1',
    maxToolLoops: 10,
  },
}

export const config = defineConfig<WorkflowsConfig>('workflows', defaultConfig, {
  schemas: workflowsSchemas,
})