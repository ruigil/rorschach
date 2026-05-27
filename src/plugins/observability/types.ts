import type { LogEvent, TraceSpan } from '../../system/index.ts'
import type { CostEvent } from '../../types/llm.ts'

// ─── JSONL logger message protocol ───

export type JsonlLoggerMsg =
  | { type: 'log'; event: LogEvent }
  | { type: 'flush' }
  | { type: '_rotated'; dateStr: string; resolvedPath: string }

// ─── Trace recorder message protocol ───

export type TraceRecorderMsg =
  | { type: 'span'; span: TraceSpan }
  | { type: 'flush' }

// ─── Cost tracker message protocol ───

export type CostTrackerMsg =
  | { type: 'cost'; event: CostEvent }
  | { type: 'flush' }
  | { type: '_rotated'; dateStr: string; resolvedPath: string }
