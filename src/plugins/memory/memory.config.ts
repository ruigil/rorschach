import { defineConfig } from '../../system/index.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'

// ─── Config type ────────────────────────────────────────────────────────────

export type MemoryActorConfig = {
  model:                   string
  consolidationIntervalMs: number
}

export type MemoryConfig = {
  kgraph?: {
    embeddingModel?:            string
    embeddingDimensions?:       number
    cosineSimilarityThreshold?: number
    rerankerModel?:             string
    rerankerTopK?:              number
  }
  system?: MemoryActorConfig
}

// ─── Schema sections ────────────────────────────────────────────────────────

const graphSchema: ConfigSchemaSection = {
  id: 'memory.graph',
  title: 'Knowledge Graph',
  subtitle: 'memory · graph database and embeddings',
  tab: 'memory',
  configKey: 'kgraph',
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

const memorySystemSchema: ConfigSchemaSection = {
  id: 'memory.system',
  title: 'Consolidation',
  subtitle: 'memory · background memory processing',
  tab: 'memory',
  configKey: 'system',
  schema: {
    type: 'object',
    properties: {
      model: { type: 'string', 'x-ui': { widget: 'model-select', label: 'Memory model' } },
      consolidationIntervalMs: { type: 'number', default: 3600000, minimum: 5000 },
    },
  },
}

const memorySchemas: ConfigSchemaSection[] = [graphSchema, memorySystemSchema]

// ─── Defaults + descriptor ──────────────────────────────────────────────────

export const config = defineConfig<MemoryConfig>('memory', {}, {
  schemas: memorySchemas,
})