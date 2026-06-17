import type { ActorRef } from '../../system/index.ts'
import { ask } from '../../system/index.ts'
import type { RouteRegistration } from '../../types/routes.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import type { Identity } from '../../types/identity.ts'
import type { WorkflowRunnerMsg, WorkflowRunnerReply } from './types.ts'
import { getWorkflow, getWorkflowGraph, listWorkflows, type StoreResult } from './workflow-store.ts'
import { isRunArtifactRef, validArtifactPath } from './validation.ts'
import { join, relative, resolve } from 'node:path'

export const workflowsStorageSchema: ConfigSchemaSection = {
  id: 'workflows.storage',
  title: 'Workflows',
  subtitle: 'workflow storage',
  tab: 'workflows',
  configKey: '',
  routeId: 'config.workflows',
  schema: {
    type: 'object',
    required: ['workflowsDir'],
    properties: {
      workflowsDir: { type: 'string', default: 'workspace/workflows', 'x-ui': { label: 'Workflows directory' } },
    },
  },
}

export const workflowsAgentSchema: ConfigSchemaSection = {
  id: 'workflows.agent',
  title: 'Workflows',
  subtitle: 'workflow model',
  tab: 'workflows',
  configKey: 'agent',
  routeId: 'config.workflows',
  schema: {
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
}

export const workflowsSchemas = [workflowsStorageSchema, workflowsAgentSchema]

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const requireSession = (identity: Identity | null): Identity | Response =>
  identity ?? json({ error: 'Unauthorized' }, 401)

const workflowIdFromPath = (pathname: string, suffix = ''): string | null => {
  if (!pathname.startsWith('/workflows/')) return null
  if (suffix && !pathname.endsWith(suffix)) return null
  const end = suffix ? pathname.length - suffix.length : pathname.length
  const raw = pathname.slice('/workflows/'.length, end)
  if (!raw || raw.includes('/')) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

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
  workflowsDir: string,
  workflowRunnerRef: ActorRef<WorkflowRunnerMsg> | null,
  workflowRunsDir = 'workspace/workflows/runs',
): RouteRegistration[] => [
  {
    id: 'workflows.list',
    method: 'GET',
    path: '/workflows',
    handler: async (_req, _url, identity) => {
      const session = requireSession(identity)
      if (session instanceof Response) return session
      const workflows = await listWorkflows(workflowsDir, session.userId)
      return json(workflows)
    },
  },
  {
    id: 'workflows.item',
    method: 'GET',
    path: '/workflows/',
    match: 'prefix',
    handler: async (_req, url, identity) => {
      const session = requireSession(identity)
      if (session instanceof Response) return session

      const graphWorkflowId = workflowIdFromPath(url.pathname, '/graph')
      if (graphWorkflowId) {
        let run = undefined
        const runId = url.searchParams.get('runId')
        if (runId && workflowRunnerRef) {
          const runReply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(workflowRunnerRef, replyTo => ({ type: 'get', userId: session.userId, runId, replyTo }), { timeoutMs: 5_000 })
          if (runReply.ok && 'run' in runReply) run = runReply.run
        }
        const result = await getWorkflowGraph(workflowsDir, session.userId, graphWorkflowId, run)
        if (!result.ok) return json({ error: result.error }, result.status)
        return json(result.data.graph)
      }

      const workflowId = workflowIdFromPath(url.pathname)
      if (!workflowId) return json({ error: 'Not found' }, 404)
      const result = await getWorkflow(workflowsDir, session.userId, workflowId)
      if (!result.ok) return json({ error: result.error }, result.status)
      return json(result.data.workflow)
    },
  },
  {
    id: 'workflows.runs.start',
    method: 'POST',
    path: '/workflows/',
    match: 'prefix',
    handler: async (_req, url, identity) => {
      const session = requireSession(identity)
      if (session instanceof Response) return session
      if (!workflowRunnerRef) return json({ error: 'Workflow runner unavailable' }, 503)
      const workflowId = workflowIdFromPath(url.pathname, '/runs')
      if (!workflowId) return json({ error: 'Not found' }, 404)
      const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(workflowRunnerRef, replyTo => ({ type: 'start', userId: session.userId, workflowId, replyTo }), { timeoutMs: 10_000 })
      if (!reply.ok) return json({ error: reply.error }, reply.status ?? 500)
      if (!('run' in reply)) return json({ error: 'Unexpected workflow runner response' }, 500)
      return json(reply.run, 202)
    },
  },
  {
    id: 'workflow-runs.list',
    method: 'GET',
    path: '/workflow-runs',
    handler: async (_req, _url, identity) => {
      const session = requireSession(identity)
      if (session instanceof Response) return session
      if (!workflowRunnerRef) return json([])
      const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(workflowRunnerRef, replyTo => ({ type: 'list', userId: session.userId, replyTo }), { timeoutMs: 5_000 })
      if (!reply.ok) return json({ error: reply.error }, reply.status ?? 500)
      if (!('runs' in reply)) return json({ error: 'Unexpected workflow runner response' }, 500)
      return json(reply.runs)
    },
  },
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

      const root = resolve(workflowRunsDir, runId)
      const filePath = resolve(root, ref.path)
      const rel = relative(root, filePath)
      if (rel.startsWith('..') || rel === '..') return json({ error: 'Invalid artifact path' }, 400)

      const file = Bun.file(join(root, ref.path))
      if (!(await file.exists())) return json({ error: 'Artifact file not found' }, 404)
      return new Response(file, {
        headers: { 'Content-Type': ref.mimeType ?? 'application/octet-stream' },
      })
    },
  },
  {
    id: 'workflow-runs.item',
    method: 'GET',
    path: '/workflow-runs/',
    match: 'prefix',
    handler: async (_req, url, identity) => {
      const session = requireSession(identity)
      if (session instanceof Response) return session
      if (!workflowRunnerRef) return json({ error: 'Workflow runner unavailable' }, 503)
      const runId = runIdFromPath(url.pathname)
      if (!runId) return json({ error: 'Not found' }, 404)
      const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(workflowRunnerRef, replyTo => ({ type: 'get', userId: session.userId, runId, replyTo }), { timeoutMs: 5_000 })
      if (!reply.ok) return json({ error: reply.error }, reply.status ?? 500)
      if (!('run' in reply)) return json({ error: 'Unexpected workflow runner response' }, 500)
      return json(reply.run)
    },
  },
  {
    id: 'workflow-runs.resume',
    method: 'POST',
    path: '/workflow-runs/',
    match: 'prefix',
    handler: async (_req, url, identity) => {
      const session = requireSession(identity)
      if (session instanceof Response) return session
      if (!workflowRunnerRef) return json({ error: 'Workflow runner unavailable' }, 503)
      const runId = runIdFromPath(url.pathname, '/resume')
      if (!runId) return json({ error: 'Not found' }, 404)
      const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(workflowRunnerRef, replyTo => ({ type: 'resume', userId: session.userId, runId, replyTo }), { timeoutMs: 10_000 })
      if (!reply.ok) return json({ error: reply.error }, reply.status ?? 500)
      if (!('run' in reply)) return json({ error: 'Unexpected workflow runner response' }, 500)
      return json(reply.run)
    },
  },
]