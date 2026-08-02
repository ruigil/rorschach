import { defineConfig } from '../../system/index.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import type {
  JsonlLoggerOptions,
  MetricsActorOptions,
  TraceRecorderOptions,
  CostTrackerOptions,
} from './types.ts'

// ─── Config type ────────────────────────────────────────────────────────────

export type ObservabilityConfig = {
  jsonlLogger?:   JsonlLoggerOptions
  metrics?:       MetricsActorOptions
  traceRecorder?: TraceRecorderOptions
  costTracker?:   CostTrackerOptions
}

// ─── Schema sections ────────────────────────────────────────────────────────

const loggingSchema: ConfigSchemaSection = {
  id: 'observability.logging',
  title: 'Logging',
  subtitle: 'observability · log output and level settings',
  tab: 'observability',
  configKey: 'jsonlLogger',
  schema: {
    type: 'object',
    properties: {
      minLevel: { type: 'string', default: 'debug', enum: ['debug', 'info', 'warn', 'error'] },
      flushIntervalMs: { type: 'number', default: 3000, minimum: 100 },
    },
  },
}

const metricsSchema: ConfigSchemaSection = {
  id: 'observability.metrics',
  title: 'Metrics',
  subtitle: 'observability · actor telemetry collection',
  tab: 'observability',
  configKey: 'metrics',
  schema: {
    type: 'object',
    properties: {
      intervalMs: { type: 'number', default: 5000, minimum: 500 },
    },
  },
}

const tracesSchema: ConfigSchemaSection = {
  id: 'observability.traces',
  title: 'Traces',
  subtitle: 'observability · distributed trace recording',
  tab: 'observability',
  configKey: 'traceRecorder',
  schema: {
    type: 'object',
    properties: {
      flushIntervalMs: { type: 'number', default: 300000, minimum: 1000, 'x-ui': { label: 'Flush interval (ms)' } },
    },
  },
}

const costsSchema: ConfigSchemaSection = {
  id: 'observability.costs',
  title: 'Costs',
  subtitle: 'observability · LLM cost tracking',
  tab: 'observability',
  configKey: 'costTracker',
  schema: {
    type: 'object',
    properties: {
      flushIntervalMs: { type: 'number', default: 300000, minimum: 1000, 'x-ui': { label: 'Flush interval (ms)' } },
    },
  },
}

const observabilitySchemas: ConfigSchemaSection[] = [loggingSchema, metricsSchema, tracesSchema, costsSchema]

// ─── Defaults + descriptor ──────────────────────────────────────────────────

export const config = defineConfig<ObservabilityConfig>('observability', {}, {
  schemas: observabilitySchemas,
})