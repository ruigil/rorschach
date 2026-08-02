import { createPluginFactory } from '../../system/index.ts'
import { PersistenceActor } from './persistence-actor.ts'
import type { PersistenceConfig } from './types.ts'
import { config } from './persistence.config.ts'

export default createPluginFactory<PersistenceConfig>({
  id: 'persistence',
  version: '0.1.0',
  description: 'Centralized multi-model data storage and persistence engine',
  configDescriptor: config,
  slots: {
    persistence: {
      factory: (cfg: PersistenceConfig) => PersistenceActor(cfg),
      surviveConfigChange: true,
    },
  },
})
