import { createPluginFactory, onLifecycle } from '../../system/index.ts'
import type { ActorRef, ActorDef } from '../../system/index.ts'
import { PoolRouter, type PoolRouterOptions } from './pool-router.ts'
import { GenericWorkerBridge } from './worker-bridge.ts'
import type { WorkerBridgeOptions } from './types.ts'
import { config, type ParallelConfig } from './parallel.config.ts'

type ManagerState = {
  routerRefs: ActorRef<unknown>[]
  bridgeRefs: ActorRef<unknown>[]
}

const ParallelManager = (cfg: ParallelConfig): ActorDef<any, ManagerState> => {
  const spawnFromSlice = (slice: ParallelConfig, ctx: any) => {
    const routerRefs: ActorRef<unknown>[] = []
    const bridgeRefs: ActorRef<unknown>[] = []

    for (const entry of slice.poolRouters ?? []) {
      const router = PoolRouter(entry.options)
      routerRefs.push(ctx.spawn(entry.name, router.def) as ActorRef<unknown>)
    }
    for (const entry of slice.workerBridges ?? []) {
      const bridge = GenericWorkerBridge(entry.options)
      bridgeRefs.push(ctx.spawn(entry.name, bridge.def) as ActorRef<unknown>)
    }

    return { routerRefs, bridgeRefs }
  }

  return {
    initialState: () => ({ routerRefs: [], bridgeRefs: [] }),
    handler: (state) => ({ state }),
    lifecycle: onLifecycle({
      start: (state, ctx) => {
        const { routerRefs, bridgeRefs } = spawnFromSlice(cfg, ctx)
        return { state: { routerRefs, bridgeRefs } }
      },
      stopped: (state, ctx) => {
        for (const ref of state.routerRefs) ctx.stop(ref)
        for (const ref of state.bridgeRefs) ctx.stop(ref)
        return { state }
      },
    }),
  }
}

export default createPluginFactory<ParallelConfig>({
  id: 'parallel',
  version: '1.0.0',
  description: 'Parallel actors: pool routers and worker thread bridges',
  configDescriptor: config,
  slots: {
    manager: {
      factory: (cfg) => ParallelManager(cfg),
    },
  },
})
