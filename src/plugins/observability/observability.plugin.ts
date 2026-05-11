import { createJsonlLoggerActor, type JsonlLoggerOptions } from './jsonl-logger.ts'
import { createMetricsActor, type MetricsActorOptions } from './metrics.ts'
import { createTraceRecorderActor, type TraceRecorderOptions } from './trace-recorder.ts'
import { createCostTrackerActor, type CostTrackerOptions } from './cost-tracker.ts'
import type { PluginActorState, PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'

export type ObservabilityConfig = {
  jsonlLogger?: JsonlLoggerOptions
  metrics?: MetricsActorOptions
  traceRecorder?: TraceRecorderOptions
  costTracker?: CostTrackerOptions
}

type PluginMsg = { type: 'config'; slice: ObservabilityConfig | undefined }
type PluginState = {
  initialized: boolean
  logger:         PluginActorState<JsonlLoggerOptions>
  metrics:        PluginActorState<MetricsActorOptions>
  traceRecorder:  PluginActorState<TraceRecorderOptions>
  costTracker:    PluginActorState<CostTrackerOptions>
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
    logger:        { config: null, ref: null, gen: 0 },
    metrics:       { config: null, ref: null, gen: 0 },
    traceRecorder: { config: null, ref: null, gen: 0 },
    costTracker:   { config: null, ref: null, gen: 0 },
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.initialConfig() as ObservabilityConfig | undefined

      const loggerConfig        = slice?.jsonlLogger ?? null
      const metricsConfig       = slice?.metrics ?? null
      const traceRecorderConfig = slice?.traceRecorder ?? null
      const costTrackerConfig   = slice?.costTracker ?? null

      const loggerRef = loggerConfig
        ? ctx.spawn('jsonl-logger-0', createJsonlLoggerActor(loggerConfig))
        : null
      const metricsRef = metricsConfig
        ? ctx.spawn('metrics-0', createMetricsActor(metricsConfig))
        : null
      const traceRecorderRef = traceRecorderConfig
        ? ctx.spawn('trace-recorder-0', createTraceRecorderActor(traceRecorderConfig))
        : null
      const costTrackerRef = costTrackerConfig
        ? ctx.spawn('cost-tracker-0', createCostTrackerActor(costTrackerConfig))
        : null

      ctx.log.info('observability plugin activated')
      return { state: {
        initialized: true,
        logger:        { config: loggerConfig,        ref: loggerRef,        gen: 0 },
        metrics:       { config: metricsConfig,       ref: metricsRef,       gen: 0 },
        traceRecorder: { config: traceRecorderConfig, ref: traceRecorderRef, gen: 0 },
        costTracker:   { config: costTrackerConfig,   ref: costTrackerRef,   gen: 0 },
      } }
    },
    stopped: (state, ctx) => {
      ctx.log.info('observability plugin deactivating')
      return { state }
    },
  }),

  handler: onMessage<PluginMsg, PluginState>({
    config: (state, msg, ctx) => {
      const newLoggerConfig        = msg.slice?.jsonlLogger ?? null
      const newMetricsConfig       = msg.slice?.metrics ?? null
      const newTraceRecorderConfig = msg.slice?.traceRecorder ?? null
      const newCostTrackerConfig   = msg.slice?.costTracker ?? null

      if (state.logger.ref)        ctx.stop(state.logger.ref)
      if (state.metrics.ref)       ctx.stop(state.metrics.ref)
      if (state.traceRecorder.ref) ctx.stop(state.traceRecorder.ref)
      if (state.costTracker.ref)   ctx.stop(state.costTracker.ref)

      const loggerGen        = state.logger.gen        + 1
      const metricsGen       = state.metrics.gen       + 1
      const traceRecorderGen = state.traceRecorder.gen + 1
      const costTrackerGen   = state.costTracker.gen   + 1

      const loggerRef = newLoggerConfig
        ? ctx.spawn(`jsonl-logger-${loggerGen}`, createJsonlLoggerActor(newLoggerConfig))
        : null
      const metricsRef = newMetricsConfig
        ? ctx.spawn(`metrics-${metricsGen}`, createMetricsActor(newMetricsConfig))
        : null
      const traceRecorderRef = newTraceRecorderConfig
        ? ctx.spawn(`trace-recorder-${traceRecorderGen}`, createTraceRecorderActor(newTraceRecorderConfig))
        : null
      const costTrackerRef = newCostTrackerConfig
        ? ctx.spawn(`cost-tracker-${costTrackerGen}`, createCostTrackerActor(newCostTrackerConfig))
        : null

      return { state: {
        ...state,
        logger:        { config: newLoggerConfig,        ref: loggerRef,        gen: loggerGen        },
        metrics:       { config: newMetricsConfig,       ref: metricsRef,       gen: metricsGen       },
        traceRecorder: { config: newTraceRecorderConfig, ref: traceRecorderRef, gen: traceRecorderGen },
        costTracker:   { config: newCostTrackerConfig,   ref: costTrackerRef,   gen: costTrackerGen   },
      } }
    },
  }),
}

export default observabilityPlugin
