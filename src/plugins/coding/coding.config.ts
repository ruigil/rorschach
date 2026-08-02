import { defineConfig } from '../../system/index.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import type { AgentModelOptions } from '../../types/agents.ts'

// ─── Config type ────────────────────────────────────────────────────────────

export type CodingConfig = {
  projectRoot:    string
  projectMount:   string
  workspaceDir?:  string
  coding:         AgentModelOptions
}

// ─── Schema sections ────────────────────────────────────────────────────────

const codingProjectSchema: ConfigSchemaSection = {
  id: 'coding.project',
  title: 'Coding',
  subtitle: 'coding · project and artifact paths',
  tab: 'coding',
  configKey: '',
  schema: {
    type: 'object',
    required: ['projectRoot', 'projectMount'],
    properties: {
      projectRoot: { type: 'string', default: '/home/user/project', 'x-ui': { label: 'Project root' } },
      projectMount: { type: 'string', default: '/rorschach/home/user/project', 'x-ui': { label: 'Project mount' } },
      workspaceDir: { type: 'string', default: 'workspace', 'x-ui': { label: 'Workspace directory' } },
    },
  },
}

const codingAgentSchema: ConfigSchemaSection = {
  id: 'coding.agent',
  title: 'Coding Agent',
  subtitle: 'coding · user-facing project assistant',
  tab: 'coding',
  configKey: 'coding',
  schema: {
    type: 'object',
    required: ['model', 'maxToolLoops'],
    properties: {
      model: { type: 'string', default: 'google/gemini-3.5-flash', 'x-ui': { widget: 'model-select', label: 'Coding model' } },
      maxToolLoops: { type: 'number', default: 25, minimum: 1, maximum: 80 },
    },
  },
}

const codingSchemas: ConfigSchemaSection[] = [codingProjectSchema, codingAgentSchema]

// ─── Defaults + descriptor ──────────────────────────────────────────────────

export const defaultConfig: CodingConfig = {
  projectRoot:   '/home/rigel/rorschach/src',
  projectMount:  '/rorschach',
  workspaceDir:  '/home/rigel/rorschach/workspace',
  coding: {
    model:        'google/gemini-3.5-flash',
    maxToolLoops: 25,
  },
}

export const config = defineConfig<CodingConfig>('coding', defaultConfig, {
  schemas: codingSchemas,
})