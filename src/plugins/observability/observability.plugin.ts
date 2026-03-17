import { createJsonlLoggerActor, type JsonlLoggerOptions } from './jsonl-logger.ts'
import { createMetricsActor, type MetricsActorOptions } from './metrics.ts'
import type { PluginDef } from '../../system/types.ts'
import { ConfigTopic, type SystemConfig, type ConfigMsg } from '../config/types.ts'
import { ask } from '../../system/ask.ts'

export type ObservabilityConfig = {
  jsonlLogger?: JsonlLoggerOptions
  metrics?: MetricsActorOptions
}

type PluginMsg = { type: 'config'; slice: ObservabilityConfig | undefined }
type PluginState = { initialized: boolean }

// Subscribes to ConfigTopic and spawns/respawns observability actors when the
// config changes. On start, uses ask() to fetch the current config snapshot
// from the config store, avoiding the race where the initial publish already
// happened before this actor subscribed.

const observabilityPlugin: PluginDef<PluginMsg, PluginState> = {
  id: 'observability',
  version: '1.0.0',
  description: 'Observability actors: JSONL log persistence and metrics publishing',
  dependencies: ['config'],
  initialState: { initialized: false },

  lifecycle: async (state, event, ctx) => {
    if (event.type === 'start') {
      ctx.subscribe(ConfigTopic, (cfg) => ({ type: 'config' as const, slice: cfg.observability }))

      const storeRef = ctx.lookup<ConfigMsg>('system/$plugin-config/store')!
      const current = await ask<ConfigMsg, SystemConfig>(storeRef, (replyTo) => ({ type: 'get', replyTo }))

      if (current.observability?.jsonlLogger) {
        const opts = current.observability.jsonlLogger
        ctx.spawn('jsonl-logger', createJsonlLoggerActor(opts), { filePath: opts.filePath, written: 0, buffer: [] })
      }
      if (current.observability?.metrics) {
        ctx.spawn('metrics', createMetricsActor(current.observability.metrics), null)
      }

      ctx.log.info('observability plugin activated')
      return { state: { initialized: true } }
    }
    if (event.type === 'stopped') {
      ctx.log.info('observability plugin deactivating')
    }
    return { state }
  },

  handler(state, msg, ctx) {
    const logger = ctx.lookup('jsonl-logger')
    const metrics = ctx.lookup('metrics')
    if (logger) ctx.stop(logger)
    if (metrics) ctx.stop(metrics)

    if (msg.slice?.jsonlLogger) {
      const opts = msg.slice.jsonlLogger
      ctx.spawn('jsonl-logger', createJsonlLoggerActor(opts), { filePath: opts.filePath, written: 0, buffer: [] })
    }
    if (msg.slice?.metrics) {
      ctx.spawn('metrics', createMetricsActor(msg.slice.metrics), null)
    }

    return { state }
  },
}

export default observabilityPlugin
