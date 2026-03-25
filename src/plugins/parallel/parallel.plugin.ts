import { createPoolRouter, type PoolRouterOptions } from './pool-router.ts'
import { createWorkerBridge, type WorkerBridgeOptions } from './worker-bridge.ts'
import type { ActorContext, ActorRef, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'

export type PoolRouterEntry = {
  name: string
  options: PoolRouterOptions<any, any>
}

export type WorkerBridgeEntry = {
  name: string
  options: WorkerBridgeOptions
}

export type ParallelConfig = {
  poolRouters?: PoolRouterEntry[]
  workerBridges?: WorkerBridgeEntry[]
}

type PluginMsg = { type: 'config'; slice: ParallelConfig | undefined }
type PluginState = { initialized: boolean; routerRefs: ActorRef<unknown>[]; bridgeRefs: ActorRef<unknown>[] }

const spawnFromSlice = (slice: ParallelConfig, ctx: ActorContext<PluginMsg>) => {
  const routerRefs: ActorRef<unknown>[] = []
  const bridgeRefs: ActorRef<unknown>[] = []

  for (const entry of slice.poolRouters ?? []) {
    const router = createPoolRouter(entry.options)
    routerRefs.push(ctx.spawn(entry.name, router.def, router.initialState) as ActorRef<unknown>)
  }
  for (const entry of slice.workerBridges ?? []) {
    const bridge = createWorkerBridge(entry.options)
    bridgeRefs.push(ctx.spawn(entry.name, bridge.def, bridge.initialState) as ActorRef<unknown>)
  }

  return { routerRefs, bridgeRefs }
}

const parallelPlugin: PluginDef<PluginMsg, PluginState, ParallelConfig> = {
  id: 'parallel',
  version: '1.0.0',
  description: 'Parallel actors: pool routers and worker thread bridges',

  configDescriptor: {
    defaults: {},
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: { initialized: false, routerRefs: [], bridgeRefs: [] },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.config as ParallelConfig | undefined

      if (slice) {
        const { routerRefs, bridgeRefs } = spawnFromSlice(slice, ctx)
        ctx.log.info('parallel plugin activated')
        return { state: { initialized: true, routerRefs, bridgeRefs } }
      }

      ctx.log.info('parallel plugin activated')
      return { state: { initialized: true, routerRefs: [], bridgeRefs: [] } }
    },
    stopped: (state, ctx) => {
      ctx.log.info('parallel plugin deactivating')
      return { state }
    },
  }),

  handler: onMessage({
    config: (state, msg, ctx) => {
      for (const ref of state.routerRefs) ctx.stop(ref)
      for (const ref of state.bridgeRefs) ctx.stop(ref)

      if (!msg.slice) return { state: { ...state, routerRefs: [], bridgeRefs: [] } }

      const { routerRefs, bridgeRefs } = spawnFromSlice(msg.slice, ctx)
      return { state: { ...state, routerRefs, bridgeRefs } }
    }
  })
}

export default parallelPlugin
