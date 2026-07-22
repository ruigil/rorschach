import type { ConfigSchemaSection } from '../../types/config.ts'
import type { RouteRegistration } from '../../types/routes.ts'
import type { ActorRef } from '../../system/index.ts'
import type { HttpRequestMsg } from '../../types/routes.ts'

export const codingProjectSchema: ConfigSchemaSection = {
  id: 'coding.project',
  title: 'Coding',
  subtitle: 'coding · project and artifact paths',
  tab: 'coding',
  configKey: '',
  routeId: 'config.coding',
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

export const codingAgentSchema: ConfigSchemaSection = {
  id: 'coding.agent',
  title: 'Coding Agent',
  subtitle: 'coding · user-facing project assistant',
  tab: 'coding',
  configKey: 'coding',
  routeId: 'config.coding',
  schema: {
    type: 'object',
    required: ['model', 'maxToolLoops'],
    properties: {
      model: { type: 'string', default: 'google/gemini-3.5-flash', 'x-ui': { widget: 'model-select', label: 'Coding model' } },
      maxToolLoops: { type: 'number', default: 25, minimum: 1, maximum: 80 },
    },
  },
}

export const codingSchemas = [codingProjectSchema, codingAgentSchema]

export const buildCodingRoutes = (pageToolsRef: ActorRef<HttpRequestMsg>): RouteRegistration[] => [
  {
    id: 'coding.documentation',
    method: 'GET',
    path: '/documentation/',
    match: 'prefix',
    target: pageToolsRef,
  },
]
