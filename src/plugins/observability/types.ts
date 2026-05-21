import { createTopic } from '../../system/types.ts'
import type { LogEvent } from '../../system/types.ts'
import type { CostEvent } from '../../types/llm.ts'

// ─── Trace Span ───
//
// Each span represents one unit of work in a causal chain. Spans arrive in
// pairs: a 'started' event (no durationMs) followed by a 'done' or 'error'
// event (with durationMs). Both share the same spanId so the frontend can
// merge them into a single bar.
//
export type TraceSpan = {
  traceId: string        // one per user request
  spanId: string         // unique per logical operation
  parentSpanId?: string  // nesting — children share the request span as parent
  actor: string          // actor that emitted this span
  operation: string      // e.g. 'request', 'chatbot', 'llm-call', 'tool-invoke', 'llm-response'
  status: 'started' | 'done' | 'error'
  timestamp: number      // ms epoch (start time on 'started', end time on 'done'/'error')
  durationMs?: number    // elapsed — only set on 'done' and 'error'
  data?: Record<string, unknown>
}

export const TraceTopic = createTopic<TraceSpan>('system.trace')

// ─── JSONL logger message protocol ───

export type JsonlLoggerMsg =
  | { type: 'log'; event: LogEvent }
  | { type: 'flush' }

// ─── Trace recorder message protocol ───

export type TraceRecorderMsg =
  | { type: 'span'; span: TraceSpan }
  | { type: 'flush' }

// ─── Cost tracker message protocol ───

export type CostTrackerMsg =
  | { type: 'cost'; event: CostEvent }
  | { type: 'flush' }
