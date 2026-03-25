import type { ActorRef, PluginActorState, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import type { ToolInvokeMsg } from '../../system/tools.ts'
import { ToolRegistrationTopic } from '../../system/tools.ts'
import {
  createKgraphActor,
  KGRAPH_QUERY_TOOL_NAME, KGRAPH_QUERY_SCHEMA,
  KGRAPH_WRITE_TOOL_NAME, KGRAPH_WRITE_SCHEMA,
} from './kgraph.ts'

// ─── Config ───

export type MemoryConfig = {
  kgraph?: {
    dbPath?: string
  }
}

// ─── Internal types ───

type MemoryPluginState = {
  initialized: boolean
  kgraph: PluginActorState<MemoryConfig['kgraph']>
}

type MemoryPluginMsg =
  | { type: 'config'; slice: MemoryConfig | undefined }

// ─── Plugin definition ───

const memoryPlugin: PluginDef<MemoryPluginMsg, MemoryPluginState, MemoryConfig> = {
  id: 'memory',
  version: '1.0.0',
  description: 'Persistent knowledge graph tools via GrafeoDB Cypher',

  configDescriptor: {
    defaults: {
      kgraph: {
        dbPath: './kgraph',
      },
    },
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: {
    initialized: false,
    kgraph: { config: null, ref: null, gen: 0 },
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.initialConfig() as MemoryConfig | undefined
      const kgraphConfig = slice?.kgraph ?? {}
      const dbPath = kgraphConfig.dbPath ?? './kgraph'

      const kgraphRef = ctx.spawn('kgraph-0', createKgraphActor(dbPath), null) as ActorRef<ToolInvokeMsg>

      ctx.publishRetained(ToolRegistrationTopic, KGRAPH_QUERY_TOOL_NAME, { name: KGRAPH_QUERY_TOOL_NAME, schema: KGRAPH_QUERY_SCHEMA, ref: kgraphRef })
      ctx.publishRetained(ToolRegistrationTopic, KGRAPH_WRITE_TOOL_NAME, { name: KGRAPH_WRITE_TOOL_NAME, schema: KGRAPH_WRITE_SCHEMA, ref: kgraphRef })

      ctx.log.info('memory plugin activated', { dbPath })
      return { state: {
        initialized: true,
        kgraph: { config: kgraphConfig, ref: kgraphRef, gen: 0 },
      } }
    },

    stopped: (state, ctx) => {
      if (state.kgraph.ref) {
        ctx.deleteRetained(ToolRegistrationTopic, KGRAPH_QUERY_TOOL_NAME, { name: KGRAPH_QUERY_TOOL_NAME, ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, KGRAPH_WRITE_TOOL_NAME, { name: KGRAPH_WRITE_TOOL_NAME, ref: null })
      }
      ctx.log.info('memory plugin deactivating')
      return { state }
    },
  }),

  handler: onMessage<MemoryPluginMsg, MemoryPluginState>({
    config: (state, msg, ctx) => {
      if (state.kgraph.ref) {
        ctx.stop(state.kgraph.ref)
        ctx.deleteRetained(ToolRegistrationTopic, KGRAPH_QUERY_TOOL_NAME, { name: KGRAPH_QUERY_TOOL_NAME, ref: null })
        ctx.deleteRetained(ToolRegistrationTopic, KGRAPH_WRITE_TOOL_NAME, { name: KGRAPH_WRITE_TOOL_NAME, ref: null })
      }

      const newKgraphConfig = msg.slice?.kgraph ?? {}
      const dbPath = newKgraphConfig.dbPath ?? './kgraph'
      const gen = state.kgraph.gen + 1

      const kgraphRef = ctx.spawn(`kgraph-${gen}`, createKgraphActor(dbPath), null) as ActorRef<ToolInvokeMsg>

      ctx.publishRetained(ToolRegistrationTopic, KGRAPH_QUERY_TOOL_NAME, { name: KGRAPH_QUERY_TOOL_NAME, schema: KGRAPH_QUERY_SCHEMA, ref: kgraphRef })
      ctx.publishRetained(ToolRegistrationTopic, KGRAPH_WRITE_TOOL_NAME, { name: KGRAPH_WRITE_TOOL_NAME, schema: KGRAPH_WRITE_SCHEMA, ref: kgraphRef })

      ctx.log.info('memory plugin reconfigured', { dbPath, gen })

      return { state: {
        ...state,
        kgraph: { config: newKgraphConfig, ref: kgraphRef, gen },
      } }
    },
  }),
}

export default memoryPlugin
