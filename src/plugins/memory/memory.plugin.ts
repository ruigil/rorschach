import type { ActorRef, PluginActorState, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type { ToolInvokeMsg } from '../../types/tools.ts'
import { ToolRegistrationTopic } from '../../types/tools.ts'
import type { KgraphMsg } from '../../types/memory.ts'
import type { MemoryConsolidationMsg, MemoryReflectionMsg } from '../../types/memory.ts'
import type { UserMemoryMsg } from '../../types/memory.ts'
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
  createMemoryReflectionActor,
  INITIAL_REFLECTION_STATE,
} from './memory-reflection.ts'
import {
  createUserMemoryActor,
  INITIAL_USER_MEMORY_STATE,
  RECALL_MEMORY_TOOL_NAME,
} from './user-memory.ts'

// ─── Config ───

export type MemoryActorConfig = {
  model:                   string
  consolidationIntervalMs: number
  reflectionIntervalMs?:   number
}

export type MemoryConfig = {
  kgraph?: {
    dbPath?:             string
    embeddingModel?:     string
    embeddingDimensions?: number
  }
  memory?: MemoryActorConfig
}

// ─── Internal types ───

type MemoryPluginState = {
  initialized:   boolean
  kgraph:        PluginActorState<MemoryConfig['kgraph']>
  consolidation: ActorRef<MemoryConsolidationMsg> | null
  reflection:    ActorRef<MemoryReflectionMsg> | null
  userMemory:    ActorRef<UserMemoryMsg> | null
  memoryGen:     number
}

type MemoryPluginMsg =
  | { type: 'config'; slice: MemoryConfig | undefined }

// ─── Helpers ───

const REFLECTION_DEFAULT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000 // 1 week

const spawnMemoryActors = (
  ctx: Parameters<NonNullable<PluginDef<MemoryPluginMsg, MemoryPluginState, MemoryConfig>['lifecycle']>>[2],
  config: MemoryActorConfig,
  gen: number,
): { consolidation: ActorRef<MemoryConsolidationMsg>; reflection: ActorRef<MemoryReflectionMsg>; userMemory: ActorRef<UserMemoryMsg> } => {
  const consolidation = ctx.spawn(
    `memory-consolidation-${gen}`,
    createMemoryConsolidationActor({ model: config.model, intervalMs: config.consolidationIntervalMs, toolFilter: { allow: ['kgraph_query', 'kgraph_write', 'kgraph_upsert', 'bash', 'write', 'read', 'cron_create'] } }),
    INITIAL_CONSOLIDATION_STATE,
  )
  const reflection = ctx.spawn(
    `memory-reflection-${gen}`,
    createMemoryReflectionActor({ model: config.model, intervalMs: config.reflectionIntervalMs ?? REFLECTION_DEFAULT_INTERVAL_MS, toolFilter: { allow: ['kgraph_query', 'kgraph_write', 'kgraph_upsert', 'bash', 'write', 'read', 'cron_create'] } }),
    INITIAL_REFLECTION_STATE,
  )
  const userMemory = ctx.spawn(
    `user-memory-${gen}`,
    createUserMemoryActor({ model: config.model, toolFilter: { allow: ['kgraph_query', 'read'] } }),
    INITIAL_USER_MEMORY_STATE,
  )
  return { consolidation, reflection, userMemory }
}

const stopMemoryActors = (
  ctx: Parameters<NonNullable<PluginDef<MemoryPluginMsg, MemoryPluginState, MemoryConfig>['lifecycle']>>[2],
  consolidation: ActorRef<MemoryConsolidationMsg> | null,
  reflection: ActorRef<MemoryReflectionMsg> | null,
  userMemory: ActorRef<UserMemoryMsg> | null,
): void => {
  if (consolidation) ctx.stop(consolidation)
  if (reflection) ctx.stop(reflection)
  if (userMemory) {
    ctx.stop(userMemory)
    ctx.deleteRetained(ToolRegistrationTopic, RECALL_MEMORY_TOOL_NAME, { name: RECALL_MEMORY_TOOL_NAME, ref: null })
  }
}

// ─── Plugin definition ───

const memoryPlugin: PluginDef<MemoryPluginMsg, MemoryPluginState, MemoryConfig> = {
  id: 'memory',
  version: '1.0.0',
  description: 'Persistent knowledge graph tools via GrafeoDB Cypher',

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
    reflection:    null,
    userMemory:    null,
    memoryGen:     0,
  },

  lifecycle: onLifecycle({
    start: (state, ctx) => {
      const slice = ctx.initialConfig() as MemoryConfig | undefined
      const kgraphConfig = slice?.kgraph ?? {}
      const dbPath = kgraphConfig.dbPath ?? './kgraph'

      const embeddingCfg = kgraphConfig.embeddingModel && kgraphConfig.embeddingDimensions
        ? { model: kgraphConfig.embeddingModel, dimensions: kgraphConfig.embeddingDimensions }
        : undefined

      const kgraphRef = ctx.spawn('kgraph-0', createKgraphActor(dbPath, embeddingCfg), null) as ActorRef<KgraphMsg>

      ctx.publishRetained(ToolRegistrationTopic, KGRAPH_QUERY_TOOL_NAME, { name: KGRAPH_QUERY_TOOL_NAME, schema: KGRAPH_QUERY_SCHEMA, ref: kgraphRef as ActorRef<ToolInvokeMsg> })
      ctx.publishRetained(ToolRegistrationTopic, KGRAPH_WRITE_TOOL_NAME, { name: KGRAPH_WRITE_TOOL_NAME, schema: KGRAPH_WRITE_SCHEMA, ref: kgraphRef as ActorRef<ToolInvokeMsg> })
      if (embeddingCfg) {
        ctx.publishRetained(ToolRegistrationTopic, KGRAPH_UPSERT_TOOL_NAME, { name: KGRAPH_UPSERT_TOOL_NAME, schema: KGRAPH_UPSERT_SCHEMA, ref: kgraphRef as ActorRef<ToolInvokeMsg> })
      }
      ctx.publishRetained(KgraphTopic, 'ref', { ref: kgraphRef })

      let consolidation: ActorRef<MemoryConsolidationMsg> | null = null
      let reflection:    ActorRef<MemoryReflectionMsg> | null = null
      let userMemory:    ActorRef<UserMemoryMsg> | null = null

      if (slice?.memory) {
        const actors = spawnMemoryActors(ctx, slice.memory, 0)
        consolidation = actors.consolidation
        reflection    = actors.reflection
        userMemory    = actors.userMemory
        ctx.log.info('memory actors activated', { model: slice.memory.model })
      }

      ctx.log.info('memory plugin activated', { dbPath })
      return {
        state: {
          initialized: true,
          kgraph: { config: kgraphConfig, ref: kgraphRef, gen: 0 },
          consolidation,
          reflection,
          userMemory,
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
      if (state.reflection) ctx.stop(state.reflection)
      if (state.userMemory) {
        ctx.deleteRetained(ToolRegistrationTopic, RECALL_MEMORY_TOOL_NAME, { name: RECALL_MEMORY_TOOL_NAME, ref: null })
      }
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
      const dbPath = newKgraphConfig.dbPath ?? './kgraph'
      const kgraphGen = state.kgraph.gen + 1

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
      stopMemoryActors(ctx, state.consolidation, state.reflection, state.userMemory)

      let consolidation: ActorRef<MemoryConsolidationMsg> | null = null
      let reflection:    ActorRef<MemoryReflectionMsg> | null = null
      let userMemory:    ActorRef<UserMemoryMsg> | null = null
      const memoryGen = state.memoryGen + 1

      if (msg.slice?.memory) {
        const actors = spawnMemoryActors(ctx, msg.slice.memory, memoryGen)
        consolidation = actors.consolidation
        reflection    = actors.reflection
        userMemory    = actors.userMemory
        ctx.log.info('memory actors reconfigured', { gen: memoryGen })
      }

      ctx.log.info('memory plugin reconfigured', { dbPath, kgraphGen })

      return {
        state: {
          ...state,
          kgraph: { config: newKgraphConfig, ref: kgraphRef, gen: kgraphGen },
          consolidation,
          reflection,
          userMemory,
          memoryGen,
        },
      }
    },
  }),
}

export default memoryPlugin
