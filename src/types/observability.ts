import type { LogEvent } from '../system/types.ts'
import type { TraceSpan } from './trace.ts'

// ─── JSONL logger message protocol ───

export type JsonlLoggerMsg =
  | { type: 'log'; event: LogEvent }
  | { type: 'flush' }

// ─── Trace recorder message protocol ───

export type TraceRecorderMsg =
  | { type: 'span'; span: TraceSpan }
  | { type: 'flush' }
