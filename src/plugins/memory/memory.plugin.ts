import type { ActorRef, PluginDef } from '../../system/types.ts'
import { defineConfig, createSlot, stopSlot, publishConfigSurface, deleteConfigSurface, type ActorSlot } from '../../system/plugin-config.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type { ToolCollection, ToolMsg } from '../../types/tools.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import type { KgraphMsg, MemoryConsolidationMsg, MemorySupervisorMsg, UserContextMsg } from './types.ts'
import { Kgraph } from './kgraph.ts'
import { MemoryConsolidation } from './memory-consolidation.ts'
import { MemorySupervisor } from './memory-supervisor.ts'
import { UserContextSupervisor } from './user-context.ts'
import {
  ZettelNotes,
  type ZettelNoteMsg,
  zettelCreateTool, zettelUpdateTool, zettelSearchTool, zettelLinksTool, zettelUnlinkedTool, zettelLinkTool,
} from './zettel-notes.ts'
import { buildMemoryRoutes, memorySchemas, KGRAPH_ROUTE_ID } from './routes.ts'

// ─── Config ───

export type MemoryActorConfig = {
  model:                   string
  consolidationIntervalMs: number
  contextIntervalMs:       number
}

export type MemoryConfig = {
  dbPath?: string
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
  dbPath: './workspace/memory/kgraph',
}, {
  schemas: memorySchemas,
})

// ─── Internal types ───

type MemoryActors = {
  consolidation: ActorRef<MemoryConsolidationMsg>
  memory:        ActorRef<MemorySupervisorMsg>
  zettel:        ActorRef<ZettelNoteMsg>
  userContext:   ActorRef<UserContextMsg>
}

type MemoryPluginState = {
  initialized:         boolean
  kgraph:              ActorSlot<Exclude<MemoryConfig['kgraph'], undefined>>
  consolidation:       ActorRef<MemoryConsolidationMsg> | null
  memory:              ActorRef<MemorySupervisorMsg>    | null
  zettel:              ActorRef<ZettelNoteMsg>          | null
  userContext:         ActorRef<UserContextMsg>         | null
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
  dbPath: string,
): MemoryActors => {
  
  const zettel = ctx.spawn(`zettel-notes-${gen}`, ZettelNotes(kgraphRef, dbPath) )

  const ref = zettel as unknown as ActorRef<ToolMsg>

  const storeTools: ToolCollection = {
    [zettelSearchTool.name]: { ...zettelSearchTool, ref },
    [zettelCreateTool.name]: { ...zettelCreateTool, ref },
    [zettelUpdateTool.name]: { ...zettelUpdateTool, ref },
    [zettelLinkTool.name]:   { ...zettelLinkTool,   ref },
  }

  const consolidationTools: ToolCollection = {
    [zettelSearchTool.name]:   { ...zettelSearchTool, ref },
    [zettelUnlinkedTool.name]: { ...zettelUnlinkedTool, ref },
    [zettelLinkTool.name]:     { ...zettelLinkTool,   ref },
  }

  const recallTools: ToolCollection = {
    [zettelSearchTool.name]: { ...zettelSearchTool, ref },
    [zettelLinksTool.name]:  { ...zettelLinksTool,  ref },
  }

  const consolidation = ctx.spawn(
    `memory-consolidation-${gen}`,
    MemoryConsolidation({ model: config.model, intervalMs: config.consolidationIntervalMs, tools: consolidationTools }),
  )
  const userContext = ctx.spawn(
    `user-context-${gen}`,
    UserContextSupervisor({ model: config.model, intervalMs: config.contextIntervalMs }),
  )
  const memory = ctx.spawn(
    `memory-supervisor-${gen}`,
    MemorySupervisor({ model: config.model, recallTools, storeTools }),
  ) 
  
  return { consolidation, memory, zettel, userContext }
}

const stopMemoryActors = (
  ctx: Parameters<NonNullable<PluginDef<MemoryPluginMsg, MemoryPluginState, MemoryConfig>['lifecycle']>>[2],
  state: Pick<MemoryPluginState, 'consolidation' | 'memory' | 'zettel' | 'userContext'>,
): void => {
  if (state.consolidation) ctx.stop(state.consolidation)
  if (state.memory)        ctx.stop(state.memory)
  if (state.zettel)        ctx.stop(state.zettel)
  if (state.userContext)   ctx.stop(state.userContext)
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
    zettel:              null,
    userContext:         null,
    memoryGen:           0,
  },

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      const slice       = ctx.initialConfig() as MemoryConfig | undefined
      const dbPath      = slice?.dbPath ?? './workspace/memory'
      const kgraphConfig = slice?.kgraph ?? {}

      publishConfigSurface(ctx, config, () => slice)

      const embeddingCfg = kgraphConfig.embeddingModel && kgraphConfig.embeddingDimensions
        ? { model: kgraphConfig.embeddingModel, dimensions: kgraphConfig.embeddingDimensions }
        : undefined

      const rerankerCfg = kgraphConfig.rerankerModel
        ? { model: kgraphConfig.rerankerModel, topK: kgraphConfig.rerankerTopK }
        : undefined

      const kgraphRef = ctx.spawn('kgraph-0', Kgraph(dbPath, embeddingCfg, kgraphConfig.cosineSimilarityThreshold, rerankerCfg)) as ActorRef<KgraphMsg>

      let consolidation: ActorRef<MemoryConsolidationMsg> | null = null
      let memory:        ActorRef<MemorySupervisorMsg>    | null = null
      let zettel:        ActorRef<ZettelNoteMsg>          | null = null
      let userContext:   ActorRef<UserContextMsg>         | null = null

      if (slice?.system) {
        const actors = spawnMemoryActors(ctx, slice.system, 0, kgraphRef, dbPath)
        consolidation = actors.consolidation
        memory        = actors.memory
        zettel        = actors.zettel
        userContext   = actors.userContext
        ctx.log.info('memory actors activated', { model: slice.system.model })
      }

      for (const reg of buildMemoryRoutes(kgraphRef)) {
        ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
      }

      ctx.log.info('memory plugin activated', { dbPath })
      return { state: {
        initialized: true,
        kgraph: { config: kgraphConfig, ref: kgraphRef, gen: 0 },
        consolidation,
        memory,
        zettel,
        userContext,
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

      const dbPath          = msg.slice?.dbPath ?? './workspace/memory'
      const newKgraphConfig = msg.slice?.kgraph ?? {}
      const kgraphGen       = state.kgraph.gen + 1

      const newEmbeddingCfg = newKgraphConfig.embeddingModel && newKgraphConfig.embeddingDimensions
        ? { model: newKgraphConfig.embeddingModel, dimensions: newKgraphConfig.embeddingDimensions }
        : undefined

      const newRerankerCfg = newKgraphConfig.rerankerModel
        ? { model: newKgraphConfig.rerankerModel, topK: newKgraphConfig.rerankerTopK }
        : undefined

      const kgraphRef = ctx.spawn(`kgraph-${kgraphGen}`, Kgraph(dbPath, newEmbeddingCfg, newKgraphConfig.cosineSimilarityThreshold, newRerankerCfg)) as ActorRef<KgraphMsg>

      // ─── Reconfigure memory actors ───
      stopMemoryActors(ctx, state)

      let consolidation: ActorRef<MemoryConsolidationMsg> | null = null
      let memory:        ActorRef<MemorySupervisorMsg>    | null = null
      let zettel:        ActorRef<ZettelNoteMsg>          | null = null
      let userContext:   ActorRef<UserContextMsg>         | null = null
      const memoryGen = state.memoryGen + 1

      if (msg.slice?.system) {
        const actors = spawnMemoryActors(ctx, msg.slice.system, memoryGen, kgraphRef, dbPath)
        consolidation = actors.consolidation
        memory        = actors.memory
        zettel        = actors.zettel
        userContext   = actors.userContext
        ctx.log.info('memory actors reconfigured', { gen: memoryGen })
      }

      // Re-register routes with new refs
      for (const reg of buildMemoryRoutes(kgraphRef)) {
        ctx.publishRetained(RouteRegistrationTopic, reg.id, reg)
      }

      ctx.log.info('memory plugin reconfigured', { dbPath, kgraphGen })

      return { state: {
        ...state,
        kgraph: { config: newKgraphConfig, ref: kgraphRef, gen: kgraphGen },
        consolidation,
        memory,
        zettel,
        userContext,
        memoryGen,
      } }
    },
  }),
}

export default memoryPlugin
