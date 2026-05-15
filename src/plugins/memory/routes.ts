import type { ActorRef } from '../../system/types.ts'
import { ask } from '../../system/ask.ts'
import type { RouteRegistration } from '../../types/routes.ts'
import { resolveCookieIdentity } from '../../types/identity.ts'
import type { IdentityProviderMsg } from '../../types/identity.ts'
import type { KgraphGraph, KgraphMsg } from './types.ts'

const KGRAPH_ROUTE_ID = 'memory.kgraph.api'

export { KGRAPH_ROUTE_ID }

export const buildMemoryRoutes = (
  identityProviderRef: ActorRef<IdentityProviderMsg> | null,
  kgraphRef: ActorRef<KgraphMsg> | null,
): RouteRegistration[] => [
  {
    id: KGRAPH_ROUTE_ID,
    method: 'GET',
    path: '/kgraph',
    handler: async (req: Request) => {
      const session = await resolveCookieIdentity(identityProviderRef, req)

      if (!session) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
      }

      if (!kgraphRef) {
        return new Response(JSON.stringify({ nodes: [], edges: [] }), { headers: { 'Content-Type': 'application/json' } })
      }

      const graph: KgraphGraph = await ask(kgraphRef, replyTo => ({ type: 'dump' as const, replyTo, userId: session.userId }), { timeoutMs: 5_000 })
      return new Response(JSON.stringify(graph), { headers: { 'Content-Type': 'application/json' } })
    },
  },
]
