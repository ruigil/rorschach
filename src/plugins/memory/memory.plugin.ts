import { createPluginFactory } from '../../system/index.ts'
import type { ActorRef } from '../../system/index.ts'
import { Kgraph } from './kgraph.ts'
import { MemoryConsolidation } from './memory-consolidation.ts'
import { MemorySupervisor } from './memory-supervisor.ts'
import { MemoryRecords } from './memory-records.ts'
import { config, type MemoryConfig } from './memory.config.ts'

export default createPluginFactory<MemoryConfig>({
  id: 'memory',
  version: '1.0.0',
  description: 'Persistent knowledge graph and user memory tools',
  configDescriptor: config,
  slots: {
    kgraph: {
      factory: (cfg) => {
        const kgraphConfig = cfg.kgraph ?? {}
        const embeddingCfg = kgraphConfig.embeddingModel && kgraphConfig.embeddingDimensions
          ? { model: kgraphConfig.embeddingModel, dimensions: kgraphConfig.embeddingDimensions }
          : undefined
        const rerankerCfg = kgraphConfig.rerankerModel
          ? { model: kgraphConfig.rerankerModel, topK: kgraphConfig.rerankerTopK }
          : undefined
        return Kgraph(embeddingCfg, kgraphConfig.cosineSimilarityThreshold, rerankerCfg)
      },
    },
    records: {
      factory: () => {
        return MemoryRecords()
      },
    },
    memory: {
      factory: (cfg, deps) => {
        if (!cfg.system) return null
        return MemorySupervisor({
          model: cfg.system.model,
          recordsRef: deps.records as ActorRef<any>,
          kgraphRef: deps.kgraph as ActorRef<any>,
        })
      },
      dependsOn: ['records', 'kgraph'],
    },
    consolidation: {
      factory: (cfg, deps) => {
        if (!cfg.system) return null
        return MemoryConsolidation({
          model: cfg.system.model,
          intervalMs: cfg.system.consolidationIntervalMs,
          kgraphRef: deps.kgraph as ActorRef<any>,
        })
      },
      dependsOn: ['kgraph'],
    },
  },
})
