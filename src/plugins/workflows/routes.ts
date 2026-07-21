import type { ActorRef } from '../../system/index.ts'
import { ask } from '../../system/index.ts'
import type { RouteRegistration } from '../../types/routes.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import type { Identity } from '../../types/identity.ts'
import type { WorkflowRunnerMsg, WorkflowRunnerReply } from './types.ts'
import { isRunArtifactRef, validArtifactPath } from './validation.ts'

export const workflowsStorageSchema: ConfigSchemaSection = {
  id: 'workflows.storage',
  title: 'Workflows',
  subtitle: 'workflow storage and agent',
  tab: 'workflows',
  configKey: '',
  routeId: 'config.workflows',
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

export const workflowsSchemas = [workflowsStorageSchema]

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const requireSession = (identity: Identity | null): Identity | Response =>
  identity ?? json({ error: 'Unauthorized' }, 401)

const runIdFromPath = (pathname: string, suffix = ''): string | null => {
  if (!pathname.startsWith('/workflow-runs/')) return null
  if (suffix && !pathname.endsWith(suffix)) return null
  const end = suffix ? pathname.length - suffix.length : pathname.length
  const raw = pathname.slice('/workflow-runs/'.length, end)
  if (!raw || raw.includes('/')) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

import type { HttpRequestMsg } from '../../types/routes.ts'

export const buildWorkflowsRoutes = (
  workflowRunnerRef: ActorRef<HttpRequestMsg> | null,
): RouteRegistration[] => {
  if (!workflowRunnerRef) return []
  return [
    {
      id: 'workflow-runs.artifact',
      method: 'GET',
      path: '/artifact',
      match: 'exact',
      target: workflowRunnerRef,
    },
  ]
}