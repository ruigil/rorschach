import { createPluginFactory } from '../../system/index.ts'
import { JsonlLogger } from './jsonl-logger.ts'
import { Metrics } from './metrics.ts'
import { TraceRecorder } from './trace-recorder.ts'
import { CostTracker } from './cost-tracker.ts'
import { config, type ObservabilityConfig } from './observability.config.ts'
import type { UiSurfaceRegistration } from '../../types/ui-surface.ts'
import { GlobalTools } from './global-tools.ts'
import { UserBudgetSupervisor } from './user-budget.ts'
import { Scramblers } from './scramblers.ts'

const observabilitySurfaceRegistration: UiSurfaceRegistration = {
  id: 'observe',
  version: '1.0.0',
  view: {
    title: 'Observation',
    icon: 'activity',
    contentTag: 'r-observe-panel',
  },
  moduleUrl: '/js/plugins/observability.js',
  frameTypes: ['observability.log.entry', 'observability.metrics.updated', 'observability.trace.span', 'observability.usage.entry', 'tools.registered', 'tools.unregistered', 'scramblers.registered', 'scramblers.unregistered', 'memory.kgraph.updated', 'memory.kgraph.changed'],
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
    scramblers: {
      factory: () => Scramblers(),
    },
    userBudget: {
      factory: () => UserBudgetSupervisor(),
    },
  },
})

