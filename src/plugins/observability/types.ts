import type { LogEvent, TraceSpan as SystemTraceSpan, ActorRef } from '../../system/index.ts'
import type { CostEvent } from '../../types/llm.ts'

// ─── JSONL logger message protocol ───

export type JsonlLoggerMsg =
  | { type: 'log'; event: LogEvent }
  | { type: 'flush' }
  | { type: '_persistenceRef'; ref: ActorRef<any> | null }

// ─── Trace recorder message protocol ───

export type TraceRecorderMsg =
  | { type: 'span'; span: SystemTraceSpan }
  | { type: 'flush' }
  | { type: '_persistenceRef'; ref: ActorRef<any> | null }


// ─── Cost tracker message protocol ───

export type CostTrackerMsg =
  | { type: 'cost'; event: CostEvent }
  | { type: 'flush' }
  | { type: '_persistenceRef'; ref: ActorRef<any> | null }

// ─── UI / Observability Introspection Types ───

export type Topic = {
  topic: string
  subscribers: string[]
};

export type Actor = {
  name: string
  status: 'running' | 'stopped' | 'error' | null
  messagesProcessed: number
  messagesReceived?: number
  messagesFailed?: number
  mailboxSize?: number
  processingTime?: {
    avg?: number
    min?: number
    max?: number
  }
  state?: unknown
};

export type TraceSpan = {
  traceId: string
  spanId: string
  parentSpanId: string | null
  actor: string
  operation: string
  timestamp: number
  durationMs?: number
  status: string
  data?: Record<string, unknown>
};

export type UsageEntry = {
  role: string
  model: string
  inputTokens: number
  outputTokens: number
  contextWindow: number | null
  cost: number
};

import type { PersistenceMsg } from '../../types/persistence.ts'

// ─── Global Tools Actor Types ───

export type GlobalToolsMsg =
  | { type: '_toolReg'; event: any }
  | { type: '_wsFrame'; event: any }

export type GlobalToolsState = {
  tools: Record<string, any>
}

// ─── JSONL Logger Actor Types ───

export type JsonlLoggerState = {
  dateStr: string
  written: number
  buffer: string[]
  persistenceRef: ActorRef<PersistenceMsg> | null
}

export type JsonlLoggerOptions = {
  flushIntervalMs?: number
  minLevel?: 'debug' | 'info' | 'warn' | 'error'
}

// ─── Trace Recorder Actor Types ───

export type TraceRecorderState = {
  written: number
  buffer: { traceId: string; timestamp: number; line: string }[]
  persistenceRef: ActorRef<PersistenceMsg> | null
}

export type TraceRecorderOptions = {
  /**
   * If set, spans are buffered and flushed every `flushIntervalMs` milliseconds.
   * If omitted, every span is appended immediately (unbuffered).
   */
  flushIntervalMs?: number
}

// ─── Cost Tracker Actor Types ───

export type CostTrackerState = {
  dateStr: string
  written: number
  buffer: string[]
  persistenceRef: ActorRef<PersistenceMsg> | null
  dailyTotals: {
    totalCost: number
    totalInputTokens: number
    totalOutputTokens: number
    byModel: Record<string, { cost: number; inputTokens: number; outputTokens: number }>
  }
}

export type CostTrackerOptions = {
  /**
   * If set, events are buffered and flushed every `flushIntervalMs` milliseconds.
   * If omitted, every event is appended immediately (unbuffered).
   */
  flushIntervalMs?: number
}

// ─── Metrics Actor Types ───

export type MetricsActorOptions = {
  intervalMs: number
}

// ─── Observability Plugin Config ───

export type ObservabilityConfig = {
  jsonlLogger?: JsonlLoggerOptions
  metrics?: MetricsActorOptions
  traceRecorder?: TraceRecorderOptions
  costTracker?: CostTrackerOptions
}


