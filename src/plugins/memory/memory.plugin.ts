import type { ActorRef, PluginDef } from '../../system/index.ts'
import { defineConfig, createSlot, stopSlot, publishConfigSurface, deleteConfigSurface, type ActorSlot } from '../../system/index.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import type { KgraphMsg, MemoryConsolidationMsg, MemoryRecordsMsg, MemorySupervisorMsg } from './types.ts'
import { Kgraph } from './kgraph.ts'
import { MemoryConsolidation } from './memory-consolidation.ts'
import { MemorySupervisor } from './memory-supervisor.ts'
import { MemoryRecords } from './memory-records.ts'
import { buildMemoryRoutes, memorySchemas } from './routes.ts'

// ─── Config ───

export type MemoryActorConfig = {
  model:                   string
  consolidationIntervalMs: number
}

export type MemoryConfig = {
  workPath?: string
  kgraph?: {
    embeddingModel?:            string
    embeddingDimensions?:       number
    cosineSimilarityThreshold?: number
    rerankerModel?:             string
    rerankerTopK?:              number
  }
  system?: MemoryActorConfig
}

const config = defineConfig<MemoryConfig>('memory', {
  workPath: './workspace/memory/kgraph',
}, {
  schemas: memorySchemas,
})

// ─── Internal types ───

type MemoryActors = {
  consolidation: ActorRef<MemoryConsolidationMsg>
  memory:        ActorRef<MemorySupervisorMsg>
  records:       ActorRef<MemoryRecordsMsg>
}

type MemoryPluginState = {
  initialized:         boolean
  kgraph:              ActorSlot<Exclude<MemoryConfig['kgraph'], undefined>>
  consolidation:       ActorRef<MemoryConsolidationMsg> | null
  memory:              ActorRef<MemorySupervisorMsg>    | null
  records:             ActorRef<MemoryRecordsMsg>       | null
  memoryGen:           number
}

type MemoryPluginMsg =
  | { type: 'config'; slice: MemoryConfig | undefined }

// ─── Helpers ───

const spawnMemoryActors = (
  ctx: Parameters<NonNullable<PluginDef<MemoryPluginMsg, MemoryPluginState, MemoryConfig>['lifecycle']>>[2],
  config: MemoryActorConfig,
  gen: number,
  kgraphRef: ActorRef<KgraphMsg>,
  workPath: string,
): MemoryActors => {
  
  const records = ctx.spawn(`memory-records-${gen}`, MemoryRecords(workPath))
  const memory = ctx.spawn(
    `memory-supervisor-${gen}`,
    MemorySupervisor({ model: config.model, recordsRef: records, kgraphRef }),
  ) 
  const consolidation = ctx.spawn(
    `memory-consolidation-${gen}`,
    MemoryConsolidation({ model: config.model, intervalMs: config.consolidationIntervalMs, kgraphRef }),
  )
  
  return { consolidation, memory, records }
}

const stopMemoryActors = (
  ctx: Parameters<NonNullable<PluginDef<MemoryPluginMsg, MemoryPluginState, MemoryConfig>['lifecycle']>>[2],
  state: Pick<MemoryPluginState, 'consolidation' | 'memory' | 'records'>,
): void => {
  if (state.consolidation) ctx.stop(state.consolidation)
  if (state.memory)        ctx.stop(state.memory)
  if (state.records)       ctx.stop(state.records)
}

// ─── Plugin definition ───

const memoryPlugin: PluginDef<MemoryPluginMsg, MemoryPluginState, MemoryConfig> = {
  id: 'memory',
  version: '1.0.0',
  description: 'Persistent knowledge graph and user memory tools',

  configDescriptor: config,

  initialState: {
    initialized:         false,
    kgraph:              createSlot(),
    consolidation:       null,
    memory:              null,
    records:             null,
    memoryGen:           0,
  },

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      const slice       = ctx.initialConfig() as MemoryConfig | undefined
      const workPath    = slice?.workPath ?? './workspace/memory'
      const kgraphConfig = slice?.kgraph ?? {}

      publishConfigSurface(ctx, config, () => slice)

      const embeddingCfg = kgraphConfig.embeddingModel && kgraphConfig.embeddingDimensions
        ? { model: kgraphConfig.embeddingModel, dimensions: kgraphConfig.embeddingDimensions }
        : undefined

      const rerankerCfg = kgraphConfig.rerankerModel
        ? { model: kgraphConfig.rerankerModel, topK: kgraphConfig.rerankerTopK }
        : undefined

      const kgraphRef = ctx.spawn('kgraph-0', Kgraph(workPath, embeddingCfg, kgraphConfig.cosineSimilarityThreshold, rerankerCfg)) as ActorRef<KgraphMsg>

      let consolidation: ActorRef<MemoryConsolidationMsg> | null = null
      let memory:        ActorRef<MemorySupervisorMsg>    | null = null
      let records:       ActorRef<MemoryRecordsMsg>       | null = null

      if (slice?.system) {
        const actors = spawnMemoryActors(ctx, slice.system, 0, kgraphRef, workPath)
        consolidation = actors.consolidation
        memory        = actors.memory
        records       = actors.records
        ctx.log.info('memory actors activated', { model: slice.system.model })
      }

      for (const reg of buildMemoryRoutes(kgraphRef)) {
        ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
      }

      ctx.log.info('memory plugin activated', { workPath })
      return { state: {
        initialized: true,
        kgraph: { config: kgraphConfig, ref: kgraphRef, gen: 0 },
        consolidation,
        memory,
        records,
        memoryGen: 0,
      } }
    },

    stopped: (state, ctx) => {
      for (const reg of buildMemoryRoutes(state.kgraph.ref as ActorRef<KgraphMsg> | null)) {
        ctx.deleteRetained(RouteRegistrationTopic, reg.id, { id: reg.id, method: reg.method, path: reg.path, handler: null })
      }
      stopMemoryActors(ctx, state)
      if (state.kgraph.ref) ctx.stop(state.kgraph.ref)

      deleteConfigSurface(ctx, config)

      ctx.log.info('memory plugin deactivating')
      return { state }
    },
  }),

  handler: onMessage<MemoryPluginMsg, MemoryPluginState>({
    config: (state, msg, ctx) => {
      // Tombstone old routes
      for (const reg of buildMemoryRoutes(state.kgraph.ref as ActorRef<KgraphMsg> | null)) {
        ctx.deleteRetained(RouteRegistrationTopic, reg.id, { id: reg.id, method: reg.method, path: reg.path, handler: null })
      }

      // ─── Reconfigure kgraph ───
      if (state.kgraph.ref) {
        ctx.stop(state.kgraph.ref)
      }

      const workPath        = msg.slice?.workPath ?? './workspace/memory'
      const newKgraphConfig = msg.slice?.kgraph ?? {}
      const kgraphGen       = state.kgraph.gen + 1

      const newEmbeddingCfg = newKgraphConfig.embeddingModel && newKgraphConfig.embeddingDimensions
        ? { model: newKgraphConfig.embeddingModel, dimensions: newKgraphConfig.embeddingDimensions }
        : undefined

      const newRerankerCfg = newKgraphConfig.rerankerModel
        ? { model: newKgraphConfig.rerankerModel, topK: newKgraphConfig.rerankerTopK }
        : undefined

      const kgraphRef = ctx.spawn(`kgraph-${kgraphGen}`, Kgraph(workPath, newEmbeddingCfg, newKgraphConfig.cosineSimilarityThreshold, newRerankerCfg)) as ActorRef<KgraphMsg>

      // ─── Reconfigure memory actors ───
      stopMemoryActors(ctx, state)

      let consolidation: ActorRef<MemoryConsolidationMsg> | null = null
      let memory:        ActorRef<MemorySupervisorMsg>    | null = null
      let records:       ActorRef<MemoryRecordsMsg>       | null = null
      const memoryGen = state.memoryGen + 1

      if (msg.slice?.system) {
        const actors = spawnMemoryActors(ctx, msg.slice.system, memoryGen, kgraphRef, workPath)
        consolidation = actors.consolidation
        memory        = actors.memory
        records       = actors.records
        ctx.log.info('memory actors reconfigured', { gen: memoryGen })
      }

      // Re-register routes with new refs
      for (const reg of buildMemoryRoutes(kgraphRef)) {
        ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
      }

      ctx.log.info('memory plugin reconfigured', { workPath, kgraphGen })

      return { state: {
        ...state,
        kgraph: { config: newKgraphConfig, ref: kgraphRef, gen: kgraphGen },
        consolidation,
        memory,
        records,
        memoryGen,
      } }
    },
  }),
}

export default memoryPlugin
