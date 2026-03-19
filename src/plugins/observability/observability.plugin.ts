import { createJsonlLoggerActor, type JsonlLoggerOptions } from './jsonl-logger.ts'
import { createMetricsActor, type MetricsActorOptions } from './metrics.ts'
import type { ActorIdentity, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'

export type ObservabilityConfig = {
  jsonlLogger?: JsonlLoggerOptions
  metrics?: MetricsActorOptions
}

type PluginMsg = { type: 'config'; slice: ObservabilityConfig | undefined }
type PluginState = {
  initialized: boolean
  loggerConfig: JsonlLoggerOptions | null
  loggerRef: ActorIdentity | null
  loggerGen: number
  metricsConfig: MetricsActorOptions | null
  metricsRef: ActorIdentity | null
  metricsGen: number
}

const observabilityPlugin: PluginDef<PluginMsg, PluginState, ObservabilityConfig> = {
  id: 'observability',
  version: '1.0.0',
  description: 'Observability actors: JSONL log persistence and metrics publishing',

  configDescriptor: {
    defaults: {},
    onConfigChange: (config) => ({ type: 'config' as const, slice: config }),
  },

  initialState: { initialized: false, loggerConfig: null, loggerRef: null, loggerGen: 0, metricsConfig: null, metricsRef: null, metricsGen: 0 },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.config as ObservabilityConfig | undefined

      const loggerConfig = slice?.jsonlLogger ?? null
      const metricsConfig = slice?.metrics ?? null

      const loggerRef = loggerConfig
        ? ctx.spawn('jsonl-logger-0', createJsonlLoggerActor(loggerConfig), { filePath: loggerConfig.filePath, written: 0, buffer: [] })
        : null
      const metricsRef = metricsConfig
        ? ctx.spawn('metrics-0', createMetricsActor(metricsConfig), null)
        : null

      ctx.log.info('observability plugin activated')
      return { state: { initialized: true, loggerConfig, loggerRef, loggerGen: 0, metricsConfig, metricsRef, metricsGen: 0 } }
    },
    stopped: (state, ctx) => {
      ctx.log.info('observability plugin deactivating')
      return { state }
    },
  }),

  handler: onMessage({
    config: (state, msg, ctx) => {
      let { loggerConfig, loggerRef, loggerGen, metricsConfig, metricsRef, metricsGen } = state

      const newLogger = msg.slice?.jsonlLogger ?? null
      if (newLogger && JSON.stringify(newLogger) !== JSON.stringify(loggerConfig)) {
        if (loggerRef) ctx.stop(loggerRef)
        loggerGen++
        loggerRef = ctx.spawn(`jsonl-logger-${loggerGen}`, createJsonlLoggerActor(newLogger), { filePath: newLogger.filePath, written: 0, buffer: [] })
        loggerConfig = newLogger
      }

      const newMetrics = msg.slice?.metrics ?? null
      if (newMetrics && JSON.stringify(newMetrics) !== JSON.stringify(metricsConfig)) {
        if (metricsRef) ctx.stop(metricsRef)
        metricsGen++
        metricsRef = ctx.spawn(`metrics-${metricsGen}`, createMetricsActor(newMetrics), null)
        metricsConfig = newMetrics
      }

      return { state: { ...state, loggerConfig, loggerRef, loggerGen, metricsConfig, metricsRef, metricsGen } }
    }
  })
}

export default observabilityPlugin
