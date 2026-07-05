import { createPluginFactory } from '../../system/index.ts'
import { JsonlLogger, type JsonlLoggerOptions } from './jsonl-logger.ts'
import { Metrics, type MetricsActorOptions } from './metrics.ts'
import { TraceRecorder, type TraceRecorderOptions } from './trace-recorder.ts'
import { CostTracker, type CostTrackerOptions } from './cost-tracker.ts'
import { defineConfig } from '../../system/index.ts'
import { observabilitySchemas } from './routes.ts'
import type { UiSurfaceRegistration } from '../../types/ui-surface.ts'
import { GlobalTools } from './global-tools.ts'

export type ObservabilityConfig = {
  jsonlLogger?: JsonlLoggerOptions
  metrics?: MetricsActorOptions
  traceRecorder?: TraceRecorderOptions
  costTracker?: CostTrackerOptions
}

const config = defineConfig<ObservabilityConfig>('observability', {}, {
  schemas: observabilitySchemas,
})

const observabilitySurfaceRegistration: UiSurfaceRegistration = {
  id: 'observe',
  version: '1.0.0',
  view: {
    title: 'Observation',
    icon: 'activity',
    contentTag: 'r-observe-panel',
  },
  moduleUrl: '/js/plugins/observability.js',
  frameTypes: ['log', 'metrics', 'trace', 'usage', 'tool_registered', 'tool_unregistered'],
}

export default createPluginFactory<ObservabilityConfig>({
  id: 'observability',
  version: '1.0.0',
  description: 'Observability actors: JSONL log persistence and metrics publishing',
  configDescriptor: config,
  uiSurface: observabilitySurfaceRegistration,
  slots: {
    logger: {
      factory: (cfg) => cfg ? JsonlLogger(cfg) : null,
      configPath: 'jsonlLogger',
    },
    metrics: {
      factory: (cfg) => cfg ? Metrics(cfg) : null,
      configPath: 'metrics',
    },
    traceRecorder: {
      factory: (cfg) => cfg ? TraceRecorder(cfg) : null,
      configPath: 'traceRecorder',
    },
    costTracker: {
      factory: (cfg) => cfg ? CostTracker(cfg) : null,
      configPath: 'costTracker',
    },
    globalTools: {
      factory: () => GlobalTools(),
    },
  },
})
