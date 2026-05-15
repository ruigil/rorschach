import type { ActorRef, PluginDef } from '../../system/types.ts'
import { defineConfig, createSlot, stopSlot, createSharedRefs, type ActorSlot, type SharedRefs } from '../../system/config.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { ask } from '../../system/ask.ts'
import type { ToolCollection, ToolMsg } from '../../types/tools.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { IdentityProviderTopic, resolveCookieIdentity } from '../../types/identity.ts'
import type { IdentityProviderMsg } from '../../types/identity.ts'
import type { KgraphGraph, KgraphMsg, MemoryConsolidationMsg, MemorySupervisorMsg, UserContextMsg } from './types.ts'
import { Kgraph } from './kgraph.ts'
import { MemoryConsolidation } from './memory-consolidation.ts'
import { MemorySupervisor } from './memory-supervisor.ts'
import { UserContextSupervisor } from './user-context.ts'
import {
  ZettelNotes,
  type ZettelNoteMsg,
  zettelCreateTool, zettelUpdateTool, zettelSearchTool, zettelLinksTool, zettelUnlinkedTool, zettelLinkTool,
} from './zettel-notes.ts'

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
})

// ─── Internal types ───

const KGRAPH_ROUTE_ID = 'memory.kgraph.api'

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
  identityProviderRef: ActorRef<IdentityProviderMsg>    | null
}

type MemoryPluginMsg =
  | { type: 'config'; slice: MemoryConfig | undefined }
  | { type: '_identityProvider'; ref: ActorRef<IdentityProviderMsg> | null }

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

/**
 * The memory plugin manages persistent knowledge graph (KGraph) and Zettelkasten tools.
 * It dynamically registers the /kgraph HTTP route to expose the graph visualization.
 */
const memoryPlugin: PluginDef<MemoryPluginMsg, MemoryPluginState, MemoryConfig> = (() => {
  const refs = createSharedRefs<{
    identityProviderRef: ActorRef<IdentityProviderMsg> | null
    kgraphRef:           ActorRef<KgraphMsg>           | null
  }>({ identityProviderRef: null, kgraphRef: null })

  const registerRoutes = (
    ctx: Parameters<NonNullable<PluginDef<MemoryPluginMsg, MemoryPluginState, MemoryConfig>['lifecycle']>>[2],
  ): void => {
    ctx.publishRetained(RouteRegistrationTopic, KGRAPH_ROUTE_ID, {
      id: KGRAPH_ROUTE_ID,
      method: 'GET',
      path: '/kgraph',
      handler: async (req: Request) => {
        const session = await resolveCookieIdentity(refs.current.identityProviderRef, req)
        
        if (!session) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
        }

        const kgraphRef = refs.current.kgraphRef
        if (!kgraphRef) {
          return new Response(JSON.stringify({ nodes: [], edges: [] }), { headers: { 'Content-Type': 'application/json' } })
        }

        const graph: KgraphGraph = await ask(kgraphRef, replyTo => ({ type: 'dump' as const, replyTo, userId: session.userId }), { timeoutMs: 5_000 })
        return new Response(JSON.stringify(graph), { headers: { 'Content-Type': 'application/json' } })
      }
    })
  }

  return {
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
      identityProviderRef: null,
    },

    lifecycle: onLifecycle({
      start: (state, ctx) => {
        const slice       = ctx.initialConfig() as MemoryConfig | undefined
        const dbPath      = slice?.dbPath ?? './workspace/memory'
        const kgraphConfig = slice?.kgraph ?? {}

        const embeddingCfg = kgraphConfig.embeddingModel && kgraphConfig.embeddingDimensions
          ? { model: kgraphConfig.embeddingModel, dimensions: kgraphConfig.embeddingDimensions }
          : undefined

        const rerankerCfg = kgraphConfig.rerankerModel
          ? { model: kgraphConfig.rerankerModel, topK: kgraphConfig.rerankerTopK }
          : undefined

        const kgraphRef = ctx.spawn('kgraph-0', Kgraph(dbPath, embeddingCfg, kgraphConfig.cosineSimilarityThreshold, rerankerCfg)) as ActorRef<KgraphMsg>
        refs.update({ kgraphRef })

        ctx.subscribe(IdentityProviderTopic, (e) => ({ type: '_identityProvider' as const, ref: e.ref }))

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

        const nextState: MemoryPluginState = {
          initialized: true,
          kgraph: { config: kgraphConfig, ref: kgraphRef, gen: 0 },
          consolidation,
          memory,
          zettel,
          userContext,
          memoryGen: 0,
          identityProviderRef: null,
        }

        registerRoutes(ctx)

        ctx.log.info('memory plugin activated', { dbPath })
        return { state: nextState }
      },

      stopped: (state, ctx) => {
        ctx.deleteRetained(RouteRegistrationTopic, KGRAPH_ROUTE_ID, { id: KGRAPH_ROUTE_ID, method: 'GET', path: '/kgraph', handler: null })
        stopMemoryActors(ctx, state)
        if (state.kgraph.ref) ctx.stop(state.kgraph.ref)
        refs.update({ kgraphRef: null, identityProviderRef: null })
        ctx.log.info('memory plugin deactivating')
        return { state }
      },
    }),

    handler: onMessage<MemoryPluginMsg, MemoryPluginState>({
      _identityProvider: (state, msg) => {
        refs.update({ identityProviderRef: msg.ref })
        return {
          state: { ...state, identityProviderRef: msg.ref }
        }
      },

      config: (state, msg, ctx) => {
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
        refs.update({ kgraphRef })

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

        const nextState: MemoryPluginState = {
          ...state,
          kgraph: { config: newKgraphConfig, ref: kgraphRef, gen: kgraphGen },
          consolidation,
          memory,
          zettel,
          userContext,
          memoryGen,
        }

        // Re-registration isn't strictly necessary as the path and refs object are stable,
        // but it doesn't hurt and ensures the handler captures the intent.
        registerRoutes(ctx)

        ctx.log.info('memory plugin reconfigured', { dbPath, kgraphGen })

        return { state: nextState }
      },
    }),
  }
})()

export default memoryPlugin
