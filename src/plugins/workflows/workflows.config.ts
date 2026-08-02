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
          toolFilter: {
            type: 'object',
            oneOf: [
              {
                type: 'object',
                required: ['allow'],
                properties: { allow: { type: 'array', items: { type: 'string' } } },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['deny'],
                properties: { deny: { type: 'array', items: { type: 'string' } } },
                additionalProperties: false,
              },
            ],
          },
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