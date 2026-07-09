import { createPluginFactory, defineConfig } from '../../system/index.ts'
import { PersistenceActor } from './persistence-actor.ts'
import type { PersistenceConfig } from './types.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'

export const persistenceSchema: ConfigSchemaSection = {
  id: 'persistence.config',
  title: 'Persistence',
  subtitle: 'persistence · Centralized multi-model data storage and persistence engine',
  tab: 'persistence',
  configKey: '',
  routeId: 'config.persistence',
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

const configDescriptor = defineConfig<PersistenceConfig>('persistence', {
  storageRoot: 'workspace/persistence',
  kvDir: 'kv',
  docDir: 'doc',
  objDir: 'obj',
  graphDir: 'graph',
}, {
  schemas: [persistenceSchema],
})

export default createPluginFactory<PersistenceConfig>({
  id: 'persistence',
  version: '0.1.0',
  description: 'Centralized multi-model data storage and persistence engine',
  configDescriptor,
  slots: {
    persistence: {
      factory: (cfg: PersistenceConfig) => PersistenceActor(cfg),
      surviveConfigChange: true,
    },
  },
})
