import type { ActorRef } from '../../system/index.ts'
import { ask } from '../../system/index.ts'
import type { RouteRegistration } from '../../types/routes.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import type { KgraphGraph, KgraphMsg } from './types.ts'

// ─── Config Schema Sections ──────────────────────────────────────────────────

export const workPathSchema: ConfigSchemaSection = {
  id: 'memory.workPath',
  title: 'Database',
  subtitle: 'memory · storage location',
  tab: 'memory',
  configKey: '',
  routeId: 'config.memory',
  schema: {
    type: 'object',
    properties: {
      workPath: { type: 'string', default: './workspace/memory/kgraph', 'x-ui': { label: 'Database path' } },
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
    },
  },
}

export const memorySchemas = [workPathSchema, graphSchema, memorySystemSchema]

const KGRAPH_ROUTE_ID = 'memory.kgraph.api'

export { KGRAPH_ROUTE_ID }

export const buildMemoryRoutes = (
  kgraphRef: ActorRef<KgraphMsg> | null,
): RouteRegistration[] => [
  {
    id: KGRAPH_ROUTE_ID,
    method: 'GET',
    path: '/kgraph',
    handler: async (_req, _url, identity) => {
      if (!identity) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
      }

      if (!kgraphRef) {
        return new Response(JSON.stringify({ nodes: [], edges: [] }), { headers: { 'Content-Type': 'application/json' } })
      }

      const graph: KgraphGraph = await ask(kgraphRef, replyTo => ({ type: 'dump' as const, replyTo, userId: identity.userId }), { timeoutMs: 5_000 })
      return new Response(JSON.stringify(graph), { headers: { 'Content-Type': 'application/json' } })
    },
  },
]
