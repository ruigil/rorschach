import type { ActorRef } from '../../system/types.ts'
import { ask } from '../../system/ask.ts'
import type { RouteRegistration } from '../../types/routes.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import { resolveCookieIdentity } from '../../types/identity.ts'
import type { IdentityProviderMsg } from '../../types/identity.ts'
import type { PlanStoreMsg, PlanStoreReply } from './types.ts'

export const executorStorageSchema: ConfigSchemaSection = {
  id: 'executor.storage',
  title: 'Plans',
  subtitle: 'executor · planner artifacts',
  tab: 'executor',
  configKey: '',
  routeId: 'config.executor',
  schema: {
    type: 'object',
    required: ['plansDir'],
    properties: {
      plansDir: { type: 'string', default: 'workspace/plans', 'x-ui': { label: 'Plans directory' } },
    },
  },
}

export const executorAgentSchema: ConfigSchemaSection = {
  id: 'executor.agent',
  title: 'Agent',
  subtitle: 'executor · plan discussion model',
  tab: 'executor',
  configKey: '',
  routeId: 'config.executor',
  schema: {
    type: 'object',
    required: ['model', 'maxToolLoops'],
    properties: {
      model: { type: 'string', default: 'z-ai/glm-5.1', 'x-ui': { widget: 'model-select', label: 'Executor model' } },
      maxToolLoops: { type: 'number', default: 10, minimum: 1, maximum: 50 },
    },
  },
}

export const executorSchemas = [executorStorageSchema, executorAgentSchema]

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const planIdFromPath = (pathname: string, suffix = ''): string | null => {
  if (!pathname.startsWith('/plans/')) return null
  if (suffix && !pathname.endsWith(suffix)) return null
  const end = suffix ? pathname.length - suffix.length : pathname.length
  const raw = pathname.slice('/plans/'.length, end)
  if (!raw || raw.includes('/')) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

const requireSession = async (
  identityProviderRef: ActorRef<IdentityProviderMsg> | null,
  req: Request,
): Promise<Response | null> => {
  const session = await resolveCookieIdentity(identityProviderRef, req)
  return session ? null : json({ error: 'Unauthorized' }, 401)
}

export const buildExecutorRoutes = (
  identityProviderRef: ActorRef<IdentityProviderMsg> | null,
  planStoreRef: ActorRef<PlanStoreMsg> | null,
): RouteRegistration[] => [
  {
    id:     'executor.plans.list',
    method: 'GET',
    path:   '/plans',
    handler: async (req) => {
      const unauthorized = await requireSession(identityProviderRef, req)
      if (unauthorized) return unauthorized
      if (!planStoreRef) return json([])
      const reply = await ask<PlanStoreMsg, PlanStoreReply>(planStoreRef, replyTo => ({ type: 'list', replyTo }), { timeoutMs: 5_000 })
      if (!reply.ok) return json({ error: reply.error }, reply.status ?? 500)
      if (!('plans' in reply)) return json({ error: 'Unexpected plan store response' }, 500)
      return json(reply.plans)
    },
  },
  {
    id:     'executor.plans.item',
    method: 'GET',
    path:   '/plans/',
    match:  'prefix',
    handler: async (req, url) => {
      const unauthorized = await requireSession(identityProviderRef, req)
      if (unauthorized) return unauthorized
      if (!planStoreRef) return json({ error: 'Plan store unavailable' }, 503)

      const graphPlanId = planIdFromPath(url.pathname, '/graph')
      if (graphPlanId) {
        const reply = await ask<PlanStoreMsg, PlanStoreReply>(planStoreRef, replyTo => ({ type: 'graph', planId: graphPlanId, replyTo }), { timeoutMs: 5_000 })
        if (!reply.ok) return json({ error: reply.error }, reply.status ?? 500)
        if (!('graph' in reply)) return json({ error: 'Unexpected plan store response' }, 500)
        return json(reply.graph)
      }

      const planId = planIdFromPath(url.pathname)
      if (!planId) return json({ error: 'Not found' }, 404)
      const reply = await ask<PlanStoreMsg, PlanStoreReply>(planStoreRef, replyTo => ({ type: 'get', planId, replyTo }), { timeoutMs: 5_000 })
      if (!reply.ok) return json({ error: reply.error }, reply.status ?? 500)
      if (!('plan' in reply)) return json({ error: 'Unexpected plan store response' }, 500)
      return json(reply.plan)
    },
  },
]
