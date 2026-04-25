import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ActorDef } from '../../system/types.ts'
import { TraceTopic } from '../../types/trace.ts'
import type { TraceRecorderMsg } from './types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'

// ─── Helpers ───

const dayFolder = (timestamp: number): string =>
  new Date(timestamp).toISOString().slice(0, 10) // "YYYY-MM-DD"

const tracePath = (tracesDir: string, timestamp: number, traceId: string): string => {
  const dir = join(tracesDir, dayFolder(timestamp))
  mkdirSync(dir, { recursive: true })
  return join(dir, traceId + '.jsonl')
}

// ─── Actor state ───

export type TraceRecorderState = {
  tracesDir: string
  written: number
  buffer: { traceId: string; timestamp: number; line: string }[]
}

// ─── Options ───

export type TraceRecorderOptions = {
  /** Directory where per-trace JSONL files are written. Created automatically. */
  tracesDir: string
  /**
   * If set, spans are buffered and flushed every `flushIntervalMs` milliseconds.
   * If omitted, every span is appended immediately (unbuffered).
   */
  flushIntervalMs?: number
}

/**
 * Creates a trace recorder actor definition.
 *
 * The actor subscribes to the system trace topic on the `start` lifecycle event
 * and writes every received `TraceSpan` as a single JSON line to
 * `{tracesDir}/{traceId}.jsonl`, grouping all spans of a logical request in one file.
 *
 * Supports optional buffered writes via `flushIntervalMs`.
 * On stop, any remaining buffered spans are flushed to disk.
 */
export const createTraceRecorderActor = (
  options: TraceRecorderOptions,
): ActorDef<TraceRecorderMsg, TraceRecorderState> => {
  const { tracesDir, flushIntervalMs } = options

  return {
    handler: onMessage({
      span(state, message) {
        const line = JSON.stringify(message.span)

        if (flushIntervalMs && flushIntervalMs > 0) {
          return { state: { ...state, buffer: [...state.buffer, { traceId: message.span.traceId, timestamp: message.span.timestamp, line }] } }
        }

        appendFileSync(tracePath(state.tracesDir, message.span.timestamp, message.span.traceId), line + '\n')
        return { state: { ...state, written: state.written + 1 } }
      },

      flush(state, _message, context) {
        if (state.buffer.length === 0) return { state }

        const byTrace = new Map<string, { timestamp: number; lines: string[] }>()
        for (const { traceId, timestamp, line } of state.buffer) {
          const entry = byTrace.get(traceId) ?? { timestamp, lines: [] }
          entry.lines.push(line)
          byTrace.set(traceId, entry)
        }

        for (const [traceId, { timestamp, lines }] of byTrace) {
          appendFileSync(tracePath(state.tracesDir, timestamp, traceId), lines.join('\n') + '\n')
        }

        const written = state.written + state.buffer.length
        context.log.debug(`flushed ${state.buffer.length} spans across ${byTrace.size} traces (${written} total)`)
        return { state: { ...state, buffer: [], written } }
      },
    }),

    lifecycle: onLifecycle({
      start: (state, context) => {
        if (!existsSync(tracesDir)) mkdirSync(tracesDir, { recursive: true })

        context.subscribe(TraceTopic, (span) => ({ type: 'span', span }))

        if (flushIntervalMs && flushIntervalMs > 0) {
          context.timers.startPeriodicTimer('flush', { type: 'flush' }, flushIntervalMs)
        }

        context.log.info(`persisting traces to ${tracesDir}/`)
        return { state: { ...state, tracesDir } }
      },

      stopped: (state, context) => {
        if (state.buffer.length > 0) {
          const byTrace = new Map<string, { timestamp: number; lines: string[] }>()
          for (const { traceId, timestamp, line } of state.buffer) {
            const entry = byTrace.get(traceId) ?? { timestamp, lines: [] }
            entry.lines.push(line)
            byTrace.set(traceId, entry)
          }
          for (const [traceId, { timestamp, lines }] of byTrace) {
            appendFileSync(tracePath(state.tracesDir, timestamp, traceId), lines.join('\n') + '\n')
          }
          const written = state.written + state.buffer.length
          context.log.info(`final flush: ${state.buffer.length} spans (${written} total)`)
          return { state: { ...state, buffer: [], written } }
        }

        context.log.info(`stopped — ${state.written} spans persisted`)
        return { state }
      },
    }),
  }
}
