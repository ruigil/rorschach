import type { ActorRef, PluginActorState, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { ask } from '../../system/ask.ts'
import type { ToolCollection, ToolInvokeMsg } from '../../types/tools.ts'
import { RouteRegistrationTopic } from '../../types/routes.ts'
import { IdentityProviderTopic, resolveIdentity } from '../../types/identity.ts'
import type { IdentityProviderMsg } from '../../types/identity.ts'
import type { KgraphGraph, KgraphMsg, MemoryConsolidationMsg, MemoryRecallMsg, MemoryStoreMsg } from './types.ts'
import {
  createKgraphActor,
} from './kgraph.ts'
import {
  createMemoryConsolidationActor,
  INITIAL_CONSOLIDATION_STATE,
} from './memory-consolidation.ts'
import {
  createMemoryRecallActor,
  INITIAL_RECALL_STATE,
} from './memory-recall.ts'
import {
  createMemoryStoreActor,
  INITIAL_STORE_STATE,
} from './memory-store.ts'
import {
  createZettelNotesActor,
  type ZettelNoteMsg,
  ZETTEL_CREATE_TOOL,  ZETTEL_CREATE_SCHEMA,
  ZETTEL_UPDATE_TOOL,  ZETTEL_UPDATE_SCHEMA,
  ZETTEL_READ_TOOL,    ZETTEL_READ_SCHEMA,
  ZETTEL_LIST_TOOL,    ZETTEL_LIST_SCHEMA,
  ZETTEL_SEARCH_TOOL,  ZETTEL_SEARCH_SCHEMA,
  ZETTEL_LINKS_TOOL,   ZETTEL_LINKS_SCHEMA,
  ZETTEL_LINK_TOOL,     ZETTEL_LINK_SCHEMA,
} from './zettel-notes.ts'

// ─── Config ───

export type MemoryActorConfig = {
  model:                   string
  consolidationIntervalMs: number
}

export type MemoryConfig = {
  dbPath?: string
  kgraph?: {
    embeddingModel?:      string
    embeddingDimensions?: number
  }
  system?: MemoryActorConfig
}

// ─── Internal types ───

const EMPTY_TOOL_FILTER = { allow: [] as string[] }

const KGRAPH_ROUTE_ID = 'memory.kgraph.api'

type MemoryActors = {
  consolidation: ActorRef<MemoryConsolidationMsg>
  recall:        ActorRef<MemoryRecallMsg>
  store:         ActorRef<MemoryStoreMsg>
  zettel:        ActorRef<ZettelNoteMsg>
}

type MemoryPluginState = {
  initialized:         boolean
  kgraph:              PluginActorState<Exclude<MemoryConfig['kgraph'], undefined>>
  consolidation:       ActorRef<MemoryConsolidationMsg> | null
  recall:              ActorRef<MemoryRecallMsg>         | null
  store:               ActorRef<MemoryStoreMsg>          | null
  zettel:              ActorRef<ZettelNoteMsg>           | null
  memoryGen:           number
  identityProviderRef: ActorRef<IdentityProviderMsg>     | null
}

type MemoryPluginMsg =
  | { type: 'config'; slice: MemoryConfig | undefined }
  | { type: '_identityProvider'; ref: ActorRef<IdentityProviderMsg> | null }

// ─── Helpers ───

const readCookieToken = (r: Request): string =>
  r.headers.get('cookie')?.split(';').reduce<string>((found, pair) => {
    const [k, v] = pair.trim().split('=')
    return k === 'session' ? (v ?? '') : found
  }, '') ?? ''

const spawnMemoryActors = (
  ctx: Parameters<NonNullable<PluginDef<MemoryPluginMsg, MemoryPluginState, MemoryConfig>['lifecycle']>>[2],
  config: MemoryActorConfig,
  gen: number,
  kgraphRef: ActorRef<KgraphMsg>,
  dbPath: string,
): MemoryActors => {
  const zettel = ctx.spawn(
    `zettel-notes-${gen}`,
    createZettelNotesActor(kgraphRef, dbPath),
    null,
  )

  const ref = zettel as unknown as ActorRef<ToolInvokeMsg>

  const storeTools: ToolCollection = {
    [ZETTEL_SEARCH_TOOL]: { schema: ZETTEL_SEARCH_SCHEMA, ref },
    [ZETTEL_CREATE_TOOL]: { schema: ZETTEL_CREATE_SCHEMA, ref },
    [ZETTEL_UPDATE_TOOL]: { schema: ZETTEL_UPDATE_SCHEMA, ref },
    [ZETTEL_LINK_TOOL]:   { schema: ZETTEL_LINK_SCHEMA,   ref },
  }

  const consolidationTools: ToolCollection = {
    [ZETTEL_SEARCH_TOOL]: { schema: ZETTEL_SEARCH_SCHEMA, ref },
    [ZETTEL_CREATE_TOOL]: { schema: ZETTEL_CREATE_SCHEMA, ref },
    [ZETTEL_UPDATE_TOOL]: { schema: ZETTEL_UPDATE_SCHEMA, ref },
    [ZETTEL_LINK_TOOL]:   { schema: ZETTEL_LINK_SCHEMA,   ref },
  }

  const userContextTools: ToolCollection = {
    [ZETTEL_LIST_TOOL]: { schema: ZETTEL_LIST_SCHEMA, ref },
    [ZETTEL_READ_TOOL]: { schema: ZETTEL_READ_SCHEMA, ref },
  }

  const recallTools: ToolCollection = {
    [ZETTEL_SEARCH_TOOL]: { schema: ZETTEL_SEARCH_SCHEMA, ref },
    [ZETTEL_LINKS_TOOL]:  { schema: ZETTEL_LINKS_SCHEMA,  ref },
  }

  const consolidation = ctx.spawn(
    `memory-consolidation-${gen}`,
    createMemoryConsolidationActor({ model: config.model, intervalMs: config.consolidationIntervalMs, toolFilter: EMPTY_TOOL_FILTER }),
    { ...INITIAL_CONSOLIDATION_STATE, tools: consolidationTools, userContextTools },
  )
  const recall = ctx.spawn(
    `memory-recall-${gen}`,
    createMemoryRecallActor({ model: config.model, toolFilter: EMPTY_TOOL_FILTER }),
    { ...INITIAL_RECALL_STATE, tools: recallTools },
  ) as ActorRef<MemoryRecallMsg>
  const store = ctx.spawn(
    `memory-store-${gen}`,
    createMemoryStoreActor({ model: config.model, toolFilter: EMPTY_TOOL_FILTER }),
    { ...INITIAL_STORE_STATE, tools: storeTools },
  ) as ActorRef<MemoryStoreMsg>
  return { consolidation, recall, store, zettel }
}

const stopMemoryActors = (
  ctx: Parameters<NonNullable<PluginDef<MemoryPluginMsg, MemoryPluginState, MemoryConfig>['lifecycle']>>[2],
  state: Pick<MemoryPluginState, 'consolidation' | 'recall' | 'store' | 'zettel'>,
): void => {
  if (state.consolidation) ctx.stop(state.consolidation)
  if (state.recall)        ctx.stop(state.recall)
  if (state.store)         ctx.stop(state.store)
  if (state.zettel)        ctx.stop(state.zettel)
}

/**
 * Shared references used by the route handler to avoid stale closures.
 */
type SharedRefs = {
  identityProviderRef: ActorRef<IdentityProviderMsg> | null
  kgraphRef:           ActorRef<KgraphMsg>           | null
}

const registerRoutes = (
  ctx: Parameters<NonNullable<PluginDef<MemoryPluginMsg, MemoryPluginState, MemoryConfig>['lifecycle']>>[2],
  refs: SharedRefs,
): void => {
  ctx.publishRetained(RouteRegistrationTopic, KGRAPH_ROUTE_ID, {
    id: KGRAPH_ROUTE_ID,
    method: 'GET',
    path: '/kgraph',
    handler: async (req: Request) => {
      const cookie = readCookieToken(req)
      const session = await resolveIdentity(refs.identityProviderRef,
        r => ({ type: 'resolveCookie', cookie, replyTo: r }))
      
      if (!session) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
      }

      const kgraphRef = refs.kgraphRef
      if (!kgraphRef) {
        return new Response(JSON.stringify({ nodes: [], edges: [] }), { headers: { 'Content-Type': 'application/json' } })
      }

      const graph: KgraphGraph = await ask(kgraphRef, replyTo => ({ type: 'dump' as const, replyTo, userId: session.userId }), { timeoutMs: 5_000 })
      return new Response(JSON.stringify(graph), { headers: { 'Content-Type': 'application/json' } })
    }
  })
}

// ─── Plugin definition ───

/**
 * The memory plugin manages persistent knowledge graph (KGraph) and Zettelkasten tools.
 * It dynamically registers the /kgraph HTTP route to expose the graph visualization.
 */
const memoryPlugin: PluginDef<MemoryPluginMsg, MemoryPluginState, MemoryConfig> = (() => {
  const refs: SharedRefs = { identityProviderRef: null, kgraphRef: null }

  return {
    id: 'memory',
    version: '1.0.0',
    description: 'Persistent knowledge graph and user memory tools',

    configDescriptor: {
      defaults: {
        dbPath: './workspace/memory/kgraph',
      },
      onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
    },

    initialState: {
      initialized:         false,
      kgraph:              { config: null, ref: null, gen: 0 },
      consolidation:       null,
      recall:              null,
      store:               null,
      zettel:              null,
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

        const kgraphRef = ctx.spawn('kgraph-0', createKgraphActor(dbPath, embeddingCfg), null) as ActorRef<KgraphMsg>
        refs.kgraphRef = kgraphRef

        ctx.subscribe(IdentityProviderTopic, (e) => ({ type: '_identityProvider' as const, ref: e.ref }))

        let consolidation: ActorRef<MemoryConsolidationMsg> | null = null
        let recall:        ActorRef<MemoryRecallMsg>         | null = null
        let store:         ActorRef<MemoryStoreMsg>          | null = null
        let zettel:        ActorRef<ZettelNoteMsg>           | null = null

        if (slice?.system) {
          const actors = spawnMemoryActors(ctx, slice.system, 0, kgraphRef, dbPath)
          consolidation = actors.consolidation
          recall        = actors.recall
          store         = actors.store
          zettel        = actors.zettel
          ctx.log.info('memory actors activated', { model: slice.system.model })
        }

        const nextState: MemoryPluginState = {
          initialized: true,
          kgraph: { config: kgraphConfig, ref: kgraphRef, gen: 0 },
          consolidation,
          recall,
          store,
          zettel,
          memoryGen: 0,
          identityProviderRef: null,
        }

        registerRoutes(ctx, refs)

        ctx.log.info('memory plugin activated', { dbPath })
        return { state: nextState }
      },

      stopped: (state, ctx) => {
        ctx.deleteRetained(RouteRegistrationTopic, KGRAPH_ROUTE_ID, { id: KGRAPH_ROUTE_ID, method: 'GET', path: '/kgraph', handler: null })
        stopMemoryActors(ctx, state)
        refs.kgraphRef = null
        refs.identityProviderRef = null
        ctx.log.info('memory plugin deactivating')
        return { state }
      },
    }),

    handler: onMessage<MemoryPluginMsg, MemoryPluginState>({
      _identityProvider: (state, msg) => {
        refs.identityProviderRef = msg.ref
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

        const kgraphRef = ctx.spawn(`kgraph-${kgraphGen}`, createKgraphActor(dbPath, newEmbeddingCfg), null) as ActorRef<KgraphMsg>
        refs.kgraphRef = kgraphRef

        // ─── Reconfigure memory actors ───
        stopMemoryActors(ctx, state)

        let consolidation: ActorRef<MemoryConsolidationMsg> | null = null
        let recall:        ActorRef<MemoryRecallMsg>         | null = null
        let store:         ActorRef<MemoryStoreMsg>          | null = null
        let zettel:        ActorRef<ZettelNoteMsg>           | null = null
        const memoryGen = state.memoryGen + 1

        if (msg.slice?.system) {
          const actors = spawnMemoryActors(ctx, msg.slice.system, memoryGen, kgraphRef, dbPath)
          consolidation = actors.consolidation
          recall        = actors.recall
          store         = actors.store
          zettel        = actors.zettel
          ctx.log.info('memory actors reconfigured', { gen: memoryGen })
        }

        const nextState: MemoryPluginState = {
          ...state,
          kgraph: { config: newKgraphConfig, ref: kgraphRef, gen: kgraphGen },
          consolidation,
          recall,
          store,
          zettel,
          memoryGen,
        }

        // Re-registration isn't strictly necessary as the path and refs object are stable,
        // but it doesn't hurt and ensures the handler captures the intent.
        registerRoutes(ctx, refs)

        ctx.log.info('memory plugin reconfigured', { dbPath, kgraphGen })

        return { state: nextState }
      },
    }),
  }
})()

export default memoryPlugin
