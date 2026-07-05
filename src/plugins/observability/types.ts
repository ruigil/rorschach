import type { LogEvent, TraceSpan as SystemTraceSpan } from '../../system/index.ts'
import type { CostEvent } from '../../types/llm.ts'

// ─── JSONL logger message protocol ───

export type JsonlLoggerMsg =
  | { type: 'log'; event: LogEvent }
  | { type: 'flush' }
  | { type: '_rotated'; dateStr: string; resolvedPath: string }

// ─── Trace recorder message protocol ───

export type TraceRecorderMsg =
  | { type: 'span'; span: SystemTraceSpan }
  | { type: 'flush' }


// ─── Cost tracker message protocol ───

export type CostTrackerMsg =
  | { type: 'cost'; event: CostEvent }
  | { type: 'flush' }
  | { type: '_rotated'; dateStr: string; resolvedPath: string }

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

