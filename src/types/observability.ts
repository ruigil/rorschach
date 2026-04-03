import type { LogEvent } from '../system/types.ts'
import type { TraceSpan } from './trace.ts'
import type { CostEvent } from './llm.ts'

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
