import { defineConfig } from '../../system/index.ts'
import type { PoolRouterOptions } from './pool-router.ts'
import type { WorkerBridgeOptions } from './types.ts'

// ─── Config type ────────────────────────────────────────────────────────────

export type PoolRouterEntry = {
  name: string
  options: PoolRouterOptions<any, any>
}

export type WorkerBridgeEntry = {
  name: string
  options: WorkerBridgeOptions
}

export type ParallelConfig = {
  poolRouters?:   PoolRouterEntry[]
  workerBridges?: WorkerBridgeEntry[]
}

// ─── Defaults + descriptor ──────────────────────────────────────────────────

export const config = defineConfig<ParallelConfig>('parallel', {})