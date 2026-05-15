import type { RouteRegistration } from '../../types/routes.ts'
import type { ConfigSchemaSection } from '../../types/config.ts'
import type { ObservabilityConfig } from './observability.plugin.ts'

// ─── Config Schema Sections ──────────────────────────────────────────────────

export const loggingSchema: ConfigSchemaSection = {
  id: 'observability.logging',
  title: 'Logging',
  subtitle: 'observability · log output and level settings',
  tab: 'observability',
  configKey: 'jsonlLogger',
  routeId: 'config.observability',
  schema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', default: 'logs/app.jsonl', 'x-ui': { label: 'Log file path' } },
      minLevel: { type: 'string', default: 'debug', enum: ['debug', 'info', 'warn', 'error'] },
      flushIntervalMs: { type: 'number', default: 3000, minimum: 100 },
    },
  },
}

export const metricsSchema: ConfigSchemaSection = {
  id: 'observability.metrics',
  title: 'Metrics',
  subtitle: 'observability · actor telemetry collection',
  tab: 'observability',
  configKey: 'metrics',
  routeId: 'config.observability',
  schema: {
    type: 'object',
    properties: {
      intervalMs: { type: 'number', default: 5000, minimum: 500 },
    },
  },
}

export const tracesSchema: ConfigSchemaSection = {
  id: 'observability.traces',
  title: 'Traces',
  subtitle: 'observability · distributed trace recording',
  tab: 'observability',
  configKey: 'traceRecorder',
  routeId: 'config.observability',
  schema: {
    type: 'object',
    properties: {
      tracesDir: { type: 'string', default: 'workspace/observability/traces', 'x-ui': { label: 'Traces directory' } },
    },
  },
}

export const costsSchema: ConfigSchemaSection = {
  id: 'observability.costs',
  title: 'Costs',
  subtitle: 'observability · LLM cost tracking',
  tab: 'observability',
  configKey: 'costTracker',
  routeId: 'config.observability',
  schema: {
    type: 'object',
    properties: {
      costsDir: { type: 'string', default: 'workspace/observability/costs', 'x-ui': { label: 'Costs directory' } },
      flushIntervalMs: { type: 'number', default: 300000, minimum: 1000, 'x-ui': { label: 'Flush interval (ms)' } },
    },
  },
}

export const observabilitySchemas = [loggingSchema, metricsSchema, tracesSchema, costsSchema]

// ─── Config Route ────────────────────────────────────────────────────────────

export const buildObservabilityConfigRoute = (getConfig: () => ObservabilityConfig | undefined): RouteRegistration[] => [{
  id: 'config.observability',
  method: 'GET',
  path: '/config/observability',
  handler: () => {
    const slice = getConfig()
    return new Response(JSON.stringify(slice ?? {}), { headers: { 'Content-Type': 'application/json' } })
  },
}]
