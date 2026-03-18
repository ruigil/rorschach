import { createPoolRouter, type PoolRouterOptions } from './pool-router.ts'
import { createWorkerBridge, type WorkerBridgeOptions } from './worker-bridge.ts'
import type { ActorContext, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'
import { ConfigTopic, type SystemConfig, type ConfigMsg } from '../config/types.ts'
import { ask } from '../../system/ask.ts'

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

const parallelPlugin: PluginDef<PluginMsg, PluginState> = {
  id: 'parallel',
  version: '1.0.0',
  description: 'Parallel actors: pool routers and worker thread bridges',
  dependencies: ['config'],
  initialState: { initialized: false, routerNames: [], bridgeNames: [] },

  lifecycle: onLifecycle({
    start: async (_state, ctx) => {
      ctx.subscribe(ConfigTopic, (cfg) => ({ type: 'config' as const, slice: cfg.parallel }))

      const storeRef = ctx.lookup<ConfigMsg>('system/config/store')!
      const current = await ask<ConfigMsg, SystemConfig>(storeRef, (replyTo) => ({ type: 'get', replyTo }))

      if (current.parallel) {
        const { routerNames, bridgeNames } = spawnFromSlice(current.parallel, ctx)
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
