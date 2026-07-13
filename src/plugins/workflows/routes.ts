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

export const buildWorkflowsRoutes = (
  workflowRunnerRef: ActorRef<WorkflowRunnerMsg> | null,
): RouteRegistration[] => [
  {
    id: 'workflow-runs.artifact',
    method: 'GET',
    path: '/workflow-runs/',
    match: 'prefix',
    handler: async (_req, url, identity) => {
      const session = requireSession(identity)
      if (session instanceof Response) return session
      if (!workflowRunnerRef) return json({ error: 'Workflow runner unavailable' }, 503)
      const runId = runIdFromPath(url.pathname, '/artifact')
      if (!runId) return json({ error: 'Not found' }, 404)
      const artifactPath = url.searchParams.get('path')
      if (!artifactPath || !validArtifactPath(artifactPath)) return json({ error: 'Invalid artifact path' }, 400)

      const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(workflowRunnerRef, replyTo => ({ type: 'get', userId: session.userId, runId, replyTo }), { timeoutMs: 5_000 })
      if (!reply.ok) return json({ error: reply.error }, reply.status ?? 500)
      if (!('run' in reply)) return json({ error: 'Unexpected workflow runner response' }, 500)

      const refs = [
        ...Object.values(reply.run.outputs ?? {}),
        ...Object.values(reply.run.taskStates)
          .filter(task => task.status === 'completed')
          .flatMap(task => Object.values(task.outputs ?? {})),
      ].filter(isRunArtifactRef)
      const ref = refs.find(item => item.path === artifactPath)
      if (!ref) return json({ error: 'Artifact is not referenced by completed workflow outputs' }, 404)

      const artifactReply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(
        workflowRunnerRef,
        replyTo => ({ type: 'getArtifact', userId: session.userId, runId, path: ref.path, replyTo }),
        { timeoutMs: 10_000 }
      )
      if (!artifactReply.ok) return json({ error: artifactReply.error }, 500)
      if (!('stream' in artifactReply)) return json({ error: 'Unexpected workflow runner response' }, 500)

      return new Response(artifactReply.stream, {
        headers: { 'Content-Type': ref.mimeType ?? artifactReply.mimeType ?? 'application/octet-stream' },
      })
    },
  },
]