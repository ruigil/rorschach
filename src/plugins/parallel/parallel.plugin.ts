import { createPoolRouter, type PoolRouterOptions } from './pool-router.ts'
import { createWorkerBridge, type WorkerBridgeOptions } from './worker-bridge.ts'
import type { ActorContext, PluginDef } from '../../system/types.ts'
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
type PluginState = { initialized: boolean; routerNames: string[]; bridgeNames: string[] }

const spawnFromSlice = (slice: ParallelConfig, ctx: ActorContext<PluginMsg>) => {
  const routerNames: string[] = []
  const bridgeNames: string[] = []

  for (const entry of slice.poolRouters ?? []) {
    const router = createPoolRouter(entry.options)
    ctx.spawn(entry.name, router.def, router.initialState)
    routerNames.push(entry.name)
  }
  for (const entry of slice.workerBridges ?? []) {
    const bridge = createWorkerBridge(entry.options)
    ctx.spawn(entry.name, bridge.def, bridge.initialState)
    bridgeNames.push(entry.name)
  }

  return { routerNames, bridgeNames }
}

const parallelPlugin: PluginDef<PluginMsg, PluginState, ParallelConfig> = {
  id: 'parallel',
  version: '1.0.0',
  description: 'Parallel actors: pool routers and worker thread bridges',

  configDescriptor: {
    defaults: {},
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: { initialized: false, routerNames: [], bridgeNames: [] },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.config as ParallelConfig | undefined

      if (slice) {
        const { routerNames, bridgeNames } = spawnFromSlice(slice, ctx)
        ctx.log.info('parallel plugin activated')
        return { state: { initialized: true, routerNames, bridgeNames } }
      }

      ctx.log.info('parallel plugin activated')
      return { state: { initialized: true, routerNames: [], bridgeNames: [] } }
    },
    stopped: (state, ctx) => {
      ctx.log.info('parallel plugin deactivating')
      return { state }
    },
  }),

  handler: onMessage({
    config: (state, msg, ctx) => {
      for (const name of state.routerNames) {
        const ref = ctx.lookup(name)
        if (ref) ctx.stop(ref)
      }
      for (const name of state.bridgeNames) {
        const ref = ctx.lookup(name)
        if (ref) ctx.stop(ref)
      }

      if (!msg.slice) return { state: { ...state, routerNames: [], bridgeNames: [] } }

      const { routerNames, bridgeNames } = spawnFromSlice(msg.slice, ctx)
      return { state: { ...state, routerNames, bridgeNames } }
    }
  })
}

export default parallelPlugin
