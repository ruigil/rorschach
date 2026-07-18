import { createPluginFactory } from '../../system/index.ts'
import { JsonlLogger } from './jsonl-logger.ts'
import { Metrics } from './metrics.ts'
import { TraceRecorder } from './trace-recorder.ts'
import { CostTracker } from './cost-tracker.ts'
import { defineConfig } from '../../system/index.ts'
import { observabilitySchemas } from './routes.ts'
import type { UiSurfaceRegistration } from '../../types/ui-surface.ts'
import { GlobalTools } from './global-tools.ts'
import type { ObservabilityConfig, JsonlLoggerOptions, MetricsActorOptions, TraceRecorderOptions, CostTrackerOptions } from './types.ts'

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
  frameTypes: ['log', 'metrics', 'trace', 'usage', 'tool_registered', 'tool_unregistered', 'observe.kgraph.updated', 'observe.kgraph.changed'],
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
