import { JsonlLogger, type JsonlLoggerOptions } from './jsonl-logger.ts'
import { Metrics, type MetricsActorOptions } from './metrics.ts'
import { TraceRecorder, type TraceRecorderOptions } from './trace-recorder.ts'
import { CostTracker, type CostTrackerOptions } from './cost-tracker.ts'
import { defineConfig, createSlot, stopSlot, type ActorSlot } from '../../system/config.ts'
import type { PluginDef } from '../../system/types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'

export type ObservabilityConfig = {
  jsonlLogger?: JsonlLoggerOptions
  metrics?: MetricsActorOptions
  traceRecorder?: TraceRecorderOptions
  costTracker?: CostTrackerOptions
}

const config = defineConfig<ObservabilityConfig>('observability', {})

type PluginMsg = { type: 'config'; slice: ObservabilityConfig | undefined }
type PluginState = {
  initialized: boolean
  logger:        ActorSlot<JsonlLoggerOptions>
  metrics:       ActorSlot<MetricsActorOptions>
  traceRecorder: ActorSlot<TraceRecorderOptions>
  costTracker:   ActorSlot<CostTrackerOptions>
}

const observabilityPlugin: PluginDef<PluginMsg, PluginState, ObservabilityConfig> = {
  id: 'observability',
  version: '1.0.0',
  description: 'Observability actors: JSONL log persistence and metrics publishing',

  configDescriptor: config,

  initialState: {
    initialized: false,
    logger:        createSlot(),
    metrics:       createSlot(),
    traceRecorder: createSlot(),
    costTracker:   createSlot(),
  },

  lifecycle: onLifecycle({
    start: (_state, ctx) => {
      const slice = ctx.initialConfig() as ObservabilityConfig | undefined

      const loggerRef = slice?.jsonlLogger
        ? ctx.spawn('jsonl-logger-0', JsonlLogger(slice.jsonlLogger))
        : null
      const metricsRef = slice?.metrics
        ? ctx.spawn('metrics-0', Metrics(slice.metrics))
        : null
      const traceRecorderRef = slice?.traceRecorder
        ? ctx.spawn('trace-recorder-0', TraceRecorder(slice.traceRecorder))
        : null
      const costTrackerRef = slice?.costTracker
        ? ctx.spawn('cost-tracker-0', CostTracker(slice.costTracker))
        : null

      ctx.log.info('observability plugin activated')
      return { state: {
        initialized: true,
        logger:        { config: slice?.jsonlLogger ?? null, ref: loggerRef,        gen: 0 },
        metrics:       { config: slice?.metrics      ?? null, ref: metricsRef,       gen: 0 },
        traceRecorder: { config: slice?.traceRecorder ?? null, ref: traceRecorderRef, gen: 0 },
        costTracker:   { config: slice?.costTracker   ?? null, ref: costTrackerRef,   gen: 0 },
      } }
    },
    stopped: (state, ctx) => {
      stopSlot(ctx, state.logger)
      stopSlot(ctx, state.metrics)
      stopSlot(ctx, state.traceRecorder)
      stopSlot(ctx, state.costTracker)
      ctx.log.info('observability plugin deactivating')
      return { state }
    },
  }),

  handler: onMessage<PluginMsg, PluginState>({
    config: (state, msg, ctx) => {
      stopSlot(ctx, state.logger)
      stopSlot(ctx, state.metrics)
      stopSlot(ctx, state.traceRecorder)
      stopSlot(ctx, state.costTracker)

      const newLoggerConfig = msg.slice?.jsonlLogger ?? null
      const newMetricsConfig = msg.slice?.metrics ?? null
      const newTraceRecorderConfig = msg.slice?.traceRecorder ?? null
      const newCostTrackerConfig = msg.slice?.costTracker ?? null

      const loggerRef = newLoggerConfig
        ? ctx.spawn(`jsonl-logger-${state.logger.gen + 1}`, JsonlLogger(newLoggerConfig))
        : null
      const metricsRef = newMetricsConfig
        ? ctx.spawn(`metrics-${state.metrics.gen + 1}`, Metrics(newMetricsConfig))
        : null
      const traceRecorderRef = newTraceRecorderConfig
        ? ctx.spawn(`trace-recorder-${state.traceRecorder.gen + 1}`, TraceRecorder(newTraceRecorderConfig))
        : null
      const costTrackerRef = newCostTrackerConfig
        ? ctx.spawn(`cost-tracker-${state.costTracker.gen + 1}`, CostTracker(newCostTrackerConfig))
        : null

      return { state: {
        ...state,
        logger:        { config: newLoggerConfig,        ref: loggerRef,        gen: state.logger.gen + 1        },
        metrics:       { config: newMetricsConfig,       ref: metricsRef,       gen: state.metrics.gen + 1       },
        traceRecorder: { config: newTraceRecorderConfig, ref: traceRecorderRef, gen: state.traceRecorder.gen + 1 },
        costTracker:   { config: newCostTrackerConfig,   ref: costTrackerRef,   gen: state.costTracker.gen + 1   },
      } }
    },
  }),
}

export default observabilityPlugin
