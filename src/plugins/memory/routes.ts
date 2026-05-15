import type { ActorRef } from '../../system/types.ts'
import { ask } from '../../system/ask.ts'
import type { RouteRegistration } from '../../types/routes.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import { resolveCookieIdentity } from '../../types/identity.ts'
import type { IdentityProviderMsg } from '../../types/identity.ts'
import type { KgraphGraph, KgraphMsg } from './types.ts'

// ─── Config Schema Sections ──────────────────────────────────────────────────

export const dbPathSchema: ConfigSchemaSection = {
  id: 'memory.dbPath',
  title: 'Database',
  subtitle: 'memory · storage location',
  tab: 'memory',
  configKey: '',
  routeId: 'config.memory',
  schema: {
    type: 'object',
    properties: {
      dbPath: { type: 'string', default: './workspace/memory/kgraph', 'x-ui': { label: 'Database path' } },
    },
  },
}

export const graphSchema: ConfigSchemaSection = {
  id: 'memory.graph',
  title: 'Knowledge Graph',
  subtitle: 'memory · graph database and embeddings',
  tab: 'memory',
  configKey: 'kgraph',
  routeId: 'config.memory',
  schema: {
    type: 'object',
    properties: {
      embeddingModel: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Embedding model' } },
      embeddingDimensions: { type: 'number', default: 1536, minimum: 64 },
      cosineSimilarityThreshold: { type: 'number', default: 0.6, minimum: 0, maximum: 1 },
      rerankerModel: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Reranker model' } },
    },
  },
}

export const memorySystemSchema: ConfigSchemaSection = {
  id: 'memory.system',
  title: 'Consolidation',
  subtitle: 'memory · background memory processing',
  tab: 'memory',
  configKey: 'system',
  routeId: 'config.memory',
  schema: {
    type: 'object',
    properties: {
      model: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Memory model' } },
      consolidationIntervalMs: { type: 'number', default: 3600000, minimum: 5000 },
      contextIntervalMs: { type: 'number', default: 3600000, minimum: 5000 },
    },
  },
}

export const memorySchemas = [dbPathSchema, graphSchema, memorySystemSchema]

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
