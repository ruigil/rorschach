import type { ActorRef } from '../../system/index.ts'
import { ask } from '../../system/index.ts'
import type { RouteRegistration } from '../../types/routes.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import type { KgraphGraph, KgraphMsg } from './types.ts'

// ─── Config Schema Sections ──────────────────────────────────────────────────

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

export const memorySchemas = [graphSchema, memorySystemSchema]

export const buildMemoryRoutes = (
  kgraphRef: ActorRef<KgraphMsg> | null,
): RouteRegistration[] => []

