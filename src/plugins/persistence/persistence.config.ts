import { defineConfig } from '../../system/index.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'

// ─── Config type ────────────────────────────────────────────────────────────

export type PersistenceConfig = {
  storageRoot?: string
  kvDir?: string
  docDir?: string
  objDir?: string
  graphDir?: string
}

// ─── Schema sections ────────────────────────────────────────────────────────

const persistenceSchema: ConfigSchemaSection = {
  id: 'persistence.config',
  title: 'Persistence',
  subtitle: 'persistence · Centralized multi-model data storage and persistence engine',
  tab: 'persistence',
  configKey: '',
  schema: {
    type: 'object',
    properties: {
      storageRoot: { type: 'string', default: 'workspace/persistence', 'x-ui': { label: 'Storage Root' } },
      kvDir: { type: 'string', default: 'kv', 'x-ui': { label: 'KV directory' } },
      docDir: { type: 'string', default: 'doc', 'x-ui': { label: 'Document directory' } },
      objDir: { type: 'string', default: 'obj', 'x-ui': { label: 'Object directory' } },
      graphDir: { type: 'string', default: 'graph', 'x-ui': { label: 'Graph directory' } },
    },
  },
}

// ─── Defaults + descriptor ──────────────────────────────────────────────────

export const config = defineConfig<PersistenceConfig>('persistence', {
  storageRoot: 'workspace/persistence',
  kvDir: 'kv',
  docDir: 'doc',
  objDir: 'obj',
  graphDir: 'graph',
}, {
  schemas: [persistenceSchema],
})