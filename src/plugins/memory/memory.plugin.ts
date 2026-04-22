import type { ActorRef, PluginActorState, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type { ToolCollection, ToolInvokeMsg } from '../../types/tools.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'
import type { KgraphMsg, MemoryConsolidationMsg, MemoryRecallMsg, MemoryStoreMsg } from '../../types/memory.ts'
import {
  createKgraphActor,
  KgraphTopic,
  KGRAPH_QUERY_TOOL_NAME,  KGRAPH_QUERY_SCHEMA,
  KGRAPH_WRITE_TOOL_NAME,  KGRAPH_WRITE_SCHEMA,
  KGRAPH_UPSERT_TOOL_NAME, KGRAPH_UPSERT_SCHEMA,
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
  ZETTEL_ACTIVATE_TOOL, ZETTEL_ACTIVATE_SCHEMA,
} from './zettel-notes.ts'

// ─── Config ───

export type MemoryActorConfig = {
  model:                   string
  consolidationIntervalMs: number
}

export type MemoryConfig = {
  kgraph?: {
    dbPath?:              string
    embeddingModel?:      string
    embeddingDimensions?: number
  }
  memory?: MemoryActorConfig
}

// ─── Internal types ───

// Consolidation writes episodic logs directly via bash/write, so it needs those tools
const CONSOLIDATION_TOOL_FILTER = { allow: ['kgraph_query', 'kgraph_write', 'kgraph_upsert', 'bash', 'read', 'write'] }
// Recall and store only use zettel tools (injected as initial state) — no system tools needed
const RECALL_STORE_TOOL_FILTER  = { allow: [] as string[] }

type MemoryActors = {
  consolidation: ActorRef<MemoryConsolidationMsg>
  recall:        ActorRef<MemoryRecallMsg>
  store:         ActorRef<MemoryStoreMsg>
  zettel:        ActorRef<ZettelNoteMsg>
}

type MemoryPluginState = {
  initialized:   boolean
  kgraph:        PluginActorState<MemoryConfig['kgraph']>
  consolidation: ActorRef<MemoryConsolidationMsg> | null
  recall:        ActorRef<MemoryRecallMsg>         | null
  store:         ActorRef<MemoryStoreMsg>          | null
  zettel:        ActorRef<ZettelNoteMsg>           | null
  memoryGen:     number
}

type MemoryPluginMsg =
  | { type: 'config'; slice: MemoryConfig | undefined }

// ─── Helpers ───

const spawnMemoryActors = (
  ctx: Parameters<NonNullable<PluginDef<MemoryPluginMsg, MemoryPluginState, MemoryConfig>['lifecycle']>>[2],
  config: MemoryActorConfig,
  gen: number,
  kgraphRef: ActorRef<KgraphMsg>,
): MemoryActors => {
  const zettel = ctx.spawn(
    `zettel-notes-${gen}`,
    createZettelNotesActor(kgraphRef),
    null,
  )

  const zettelTools: ToolCollection = {
    [ZETTEL_CREATE_TOOL]:   { schema: ZETTEL_CREATE_SCHEMA,   ref: zettel as unknown as ActorRef<ToolInvokeMsg> },
    [ZETTEL_UPDATE_TOOL]:   { schema: ZETTEL_UPDATE_SCHEMA,   ref: zettel as unknown as ActorRef<ToolInvokeMsg> },
    [ZETTEL_READ_TOOL]:     { schema: ZETTEL_READ_SCHEMA,     ref: zettel as unknown as ActorRef<ToolInvokeMsg> },
    [ZETTEL_LIST_TOOL]:     { schema: ZETTEL_LIST_SCHEMA,     ref: zettel as unknown as ActorRef<ToolInvokeMsg> },
    [ZETTEL_SEARCH_TOOL]:   { schema: ZETTEL_SEARCH_SCHEMA,   ref: zettel as unknown as ActorRef<ToolInvokeMsg> },
    [ZETTEL_ACTIVATE_TOOL]: { schema: ZETTEL_ACTIVATE_SCHEMA, ref: zettel as unknown as ActorRef<ToolInvokeMsg> },
  }

  const consolidation = ctx.spawn(
    `memory-consolidation-${gen}`,
    createMemoryConsolidationActor({ model: config.model, intervalMs: config.consolidationIntervalMs, toolFilter: CONSOLIDATION_TOOL_FILTER }),
    { ...INITIAL_CONSOLIDATION_STATE, tools: zettelTools },
  )
  const recall = ctx.spawn(
    `memory-recall-${gen}`,
    createMemoryRecallActor({ model: config.model, toolFilter: RECALL_STORE_TOOL_FILTER }),
    { ...INITIAL_RECALL_STATE, tools: zettelTools },
  ) as ActorRef<MemoryRecallMsg>
  const store = ctx.spawn(
    `memory-store-${gen}`,
    createMemoryStoreActor({ model: config.model, toolFilter: RECALL_STORE_TOOL_FILTER }),
    { ...INITIAL_STORE_STATE, tools: zettelTools },
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

// ─── Plugin definition ───

const memoryPlugin: PluginDef<MemoryPluginMsg, MemoryPluginState, MemoryConfig> = {
  id: 'memory',
  version: '1.0.0',
  description: 'Persistent knowledge graph and user memory tools',

  configDescriptor: {
    defaults: {
      kgraph: {
        dbPath: './workspace/memory/kgraph',
      },
    },
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: {
    initialized:   false,
    kgraph:        { config: null, ref: null, gen: 0 },
    consolidation: null,
    recall:        null,
    store:         null,
    zettel:        null,
    memoryGen:     0,
  },

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      const slice       = ctx.initialConfig() as MemoryConfig | undefined
      const kgraphConfig = slice?.kgraph ?? {}
      const basePath    = kgraphConfig.dbPath ?? '/workspace/memory'

      const embeddingCfg = kgraphConfig.embeddingModel && kgraphConfig.embeddingDimensions
        ? { model: kgraphConfig.embeddingModel, dimensions: kgraphConfig.embeddingDimensions }
        : undefined

      const kgraphRef = ctx.spawn('kgraph-0', createKgraphActor(basePath, embeddingCfg), null) as ActorRef<KgraphMsg>

      ctx.publishRetained(ToolRegistrationTopic, KGRAPH_QUERY_TOOL_NAME, { name: KGRAPH_QUERY_TOOL_NAME, schema: KGRAPH_QUERY_SCHEMA, ref: kgraphRef as ActorRef<ToolInvokeMsg> })
      ctx.publishRetained(ToolRegistrationTopic, KGRAPH_WRITE_TOOL_NAME, { name: KGRAPH_WRITE_TOOL_NAME, schema: KGRAPH_WRITE_SCHEMA, ref: kgraphRef as ActorRef<ToolInvokeMsg> })
      if (embeddingCfg) {
        ctx.publishRetained(ToolRegistrationTopic, KGRAPH_UPSERT_TOOL_NAME, { name: KGRAPH_UPSERT_TOOL_NAME, schema: KGRAPH_UPSERT_SCHEMA, ref: kgraphRef as ActorRef<ToolInvokeMsg> })
      }
      ctx.publishRetained(KgraphTopic, 'ref', { ref: kgraphRef })

      let consolidation: ActorRef<MemoryConsolidationMsg> | null = null
      let recall:        ActorRef<MemoryRecallMsg>         | null = null
      let store:         ActorRef<MemoryStoreMsg>          | null = null
      let zettel:        ActorRef<ZettelNoteMsg>           | null = null

      if (slice?.memory) {
        const actors = spawnMemoryActors(ctx, slice.memory, 0, kgraphRef)
        consolidation = actors.consolidation
        recall        = actors.recall
        store         = actors.store
        zettel        = actors.zettel
        ctx.log.info('memory actors activated', { model: slice.memory.model })
      }

      ctx.log.info('memory plugin activated', { basePath })
      return {
        state: {
          initialized: true,
          kgraph: { config: kgraphConfig, ref: kgraphRef, gen: 0 },
          consolidation,
          recall,
          store,
          zettel,
          memoryGen: 0,
        },
      }
    },

    stopped: (state, ctx) => {
      if (state.kgraph.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, KGRAPH_QUERY_TOOL_NAME,  { name: KGRAPH_QUERY_TOOL_NAME,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, KGRAPH_WRITE_TOOL_NAME,  { name: KGRAPH_WRITE_TOOL_NAME,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, KGRAPH_UPSERT_TOOL_NAME, { name: KGRAPH_UPSERT_TOOL_NAME, ref: null })
        ctx.deleteRetained(KgraphTopic, 'ref', { ref: null })
      }
      stopMemoryActors(ctx, state)
      ctx.log.info('memory plugin deactivating')
      return { state }
    },
  }),

  handler: onMessage<MemoryPluginMsg, MemoryPluginState>({
    config: (state, msg, ctx) => {
      // ─── Reconfigure kgraph ───
      if (state.kgraph.ref) {
        ctx.stop(state.kgraph.ref)
        ctx.deleteRetained(ToolRegistrationTopic, KGRAPH_QUERY_TOOL_NAME,  { name: KGRAPH_QUERY_TOOL_NAME,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, KGRAPH_WRITE_TOOL_NAME,  { name: KGRAPH_WRITE_TOOL_NAME,  ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, KGRAPH_UPSERT_TOOL_NAME, { name: KGRAPH_UPSERT_TOOL_NAME, ref: null })
      }

      const newKgraphConfig = msg.slice?.kgraph ?? {}
      const dbPath          = newKgraphConfig.dbPath ?? './kgraph'
      const kgraphGen       = state.kgraph.gen + 1

      const newEmbeddingCfg = newKgraphConfig.embeddingModel && newKgraphConfig.embeddingDimensions
        ? { model: newKgraphConfig.embeddingModel, dimensions: newKgraphConfig.embeddingDimensions }
        : undefined

      const kgraphRef = ctx.spawn(`kgraph-${kgraphGen}`, createKgraphActor(dbPath, newEmbeddingCfg), null) as ActorRef<KgraphMsg>

      ctx.publishRetained(ToolRegistrationTopic, KGRAPH_QUERY_TOOL_NAME, { name: KGRAPH_QUERY_TOOL_NAME, schema: KGRAPH_QUERY_SCHEMA, ref: kgraphRef as ActorRef<ToolInvokeMsg> })
      ctx.publishRetained(ToolRegistrationTopic, KGRAPH_WRITE_TOOL_NAME, { name: KGRAPH_WRITE_TOOL_NAME, schema: KGRAPH_WRITE_SCHEMA, ref: kgraphRef as ActorRef<ToolInvokeMsg> })
      if (newEmbeddingCfg) {
        ctx.publishRetained(ToolRegistrationTopic, KGRAPH_UPSERT_TOOL_NAME, { name: KGRAPH_UPSERT_TOOL_NAME, schema: KGRAPH_UPSERT_SCHEMA, ref: kgraphRef as ActorRef<ToolInvokeMsg> })
      }
      ctx.publishRetained(KgraphTopic, 'ref', { ref: kgraphRef })

      // ─── Reconfigure memory actors ───
      stopMemoryActors(ctx, state)

      let consolidation: ActorRef<MemoryConsolidationMsg> | null = null
      let recall:        ActorRef<MemoryRecallMsg>         | null = null
      let store:         ActorRef<MemoryStoreMsg>          | null = null
      let zettel:        ActorRef<ZettelNoteMsg>           | null = null
      const memoryGen = state.memoryGen + 1

      if (msg.slice?.memory) {
        const actors = spawnMemoryActors(ctx, msg.slice.memory, memoryGen, kgraphRef)
        consolidation = actors.consolidation
        recall        = actors.recall
        store         = actors.store
        zettel        = actors.zettel
        ctx.log.info('memory actors reconfigured', { gen: memoryGen })
      }

      ctx.log.info('memory plugin reconfigured', { dbPath, kgraphGen })

      return {
        state: {
          ...state,
          kgraph: { config: newKgraphConfig, ref: kgraphRef, gen: kgraphGen },
          consolidation,
          recall,
          store,
          zettel,
          memoryGen,
        },
      }
    },
  }),
}

export default memoryPlugin
