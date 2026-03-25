import { createJsonlLoggerActor, type JsonlLoggerOptions } from './jsonl-logger.ts'
import { createMetricsActor, type MetricsActorOptions } from './metrics.ts'
import type { PluginActorState, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'

export type ObservabilityConfig = {
  jsonlLogger?: JsonlLoggerOptions
  metrics?: MetricsActorOptions
}

type PluginMsg = { type: 'config'; slice: ObservabilityConfig | undefined }
type PluginState = {
  initialized: boolean
  logger:  PluginActorState<JsonlLoggerOptions>
  metrics: PluginActorState<MetricsActorOptions>
}

const observabilityPlugin: PluginDef<PluginMsg, PluginState, ObservabilityConfig> = {
  id: 'observability',
  version: '1.0.0',
  description: 'Observability actors: JSONL log persistence and metrics publishing',

  configDescriptor: {
    defaults: {},
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: {
    initialized: false,
    logger:  { config: null, ref: null, gen: 0 },
    metrics: { config: null, ref: null, gen: 0 },
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.config as ObservabilityConfig | undefined

      const loggerConfig  = slice?.jsonlLogger ?? null
      const metricsConfig = slice?.metrics ?? null

      const loggerRef = loggerConfig
        ? ctx.spawn('jsonl-logger-0', createJsonlLoggerActor(loggerConfig), { filePath: loggerConfig.filePath, written: 0, buffer: [] })
        : null
      const metricsRef = metricsConfig
        ? ctx.spawn('metrics-0', createMetricsActor(metricsConfig), null)
        : null

      ctx.log.info('observability plugin activated')
      return { state: {
        initialized: true,
        logger:  { config: loggerConfig,  ref: loggerRef,  gen: 0 },
        metrics: { config: metricsConfig, ref: metricsRef, gen: 0 },
      } }
    },
    stopped: (state, ctx) => {
      ctx.log.info('observability plugin deactivating')
      return { state }
    },
  }),

  handler: onMessage<PluginMsg, PluginState>({
    config: (state, msg, ctx) => {
      const newLoggerConfig  = msg.slice?.jsonlLogger ?? null
      const newMetricsConfig = msg.slice?.metrics ?? null

      if (state.logger.ref)  ctx.stop(state.logger.ref)
      if (state.metrics.ref) ctx.stop(state.metrics.ref)

      const loggerGen  = state.logger.gen  + 1
      const metricsGen = state.metrics.gen + 1

      const loggerRef = newLoggerConfig
        ? ctx.spawn(`jsonl-logger-${loggerGen}`, createJsonlLoggerActor(newLoggerConfig), { filePath: newLoggerConfig.filePath, written: 0, buffer: [] })
        : null
      const metricsRef = newMetricsConfig
        ? ctx.spawn(`metrics-${metricsGen}`, createMetricsActor(newMetricsConfig), null)
        : null

      return { state: {
        ...state,
        logger:  { config: newLoggerConfig,  ref: loggerRef,  gen: loggerGen  },
        metrics: { config: newMetricsConfig, ref: metricsRef, gen: metricsGen },
      } }
    },
  }),
}

export default observabilityPlugin
