import { join, resolve, relative } from 'node:path'
import type { ConfigSchemaSection } from '../../types/config.ts'
import type { Identity } from '../../types/identity.ts'
import type { RouteRegistration } from '../../types/routes.ts'

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
      artifactsDir: { type: 'string', default: 'workspace/artifacts', 'x-ui': { label: 'Artifacts directory' } },
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

export const docsAgentSchema: ConfigSchemaSection = {
  id: 'coding.docs',
  title: 'Docs Agent',
  subtitle: 'coding · documentation generation',
  tab: 'coding',
  configKey: 'docs',
  routeId: 'config.coding',
  schema: {
    type: 'object',
    required: ['model', 'maxToolLoops'],
    properties: {
      model: { type: 'string', default: 'google/gemini-3.5-flash', 'x-ui': { widget: 'model-select', label: 'Docs model' } },
      maxToolLoops: { type: 'number', default: 30, minimum: 1, maximum: 100 },
    },
  },
}

export const codingSchemas = [codingProjectSchema, codingAgentSchema, docsAgentSchema]

const mimeType = (path: string): string => {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.json')) return 'application/json; charset=utf-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  return 'application/octet-stream'
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

import type { ActorRef } from '../../system/index.ts'
import type { HttpRequestMsg } from '../../types/routes.ts'

export const buildCodingRoutes = (artifactToolsRef: ActorRef<HttpRequestMsg>): RouteRegistration[] => [
  {
    id: 'coding.artifacts',
    method: 'GET',
    path: '/artifacts/',
    match: 'prefix',
    target: artifactToolsRef,
  },
]
