import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { TraceTopic, type ActorDef } from '../../system/index.ts'
import { OutboundAdminBroadcastTopic } from '../../types/events.ts'
import type { TraceRecorderMsg } from './types.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'

// ─── Helpers ───

const dayFolder = (timestamp: number): string =>
  new Date(timestamp).toISOString().slice(0, 10) // "YYYY-MM-DD"

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
export const TraceRecorder = (
  options: TraceRecorderOptions,
): ActorDef<TraceRecorderMsg, TraceRecorderState> => {
  const { tracesDir, flushIntervalMs } = options

  return {
    initialState: { tracesDir, written: 0, buffer: [] },
    handler: onMessage({
      span(state, message, context) {
        // Broadcast to admin WS clients
        context.publish(OutboundAdminBroadcastTopic, {
          text: JSON.stringify({ type: 'trace', ...message.span }),
        })

        const line = JSON.stringify(message.span)

        if (flushIntervalMs && flushIntervalMs > 0) {
          return { state: { ...state, buffer: [...state.buffer, { traceId: message.span.traceId, timestamp: message.span.timestamp, line }] } }
        }

        const dir = join(state.tracesDir, dayFolder(message.span.timestamp));
        const path = join(dir, message.span.traceId + '.jsonl');

        // Asynchronous non-blocking directory creation and write
        void (async () => {
          await mkdir(dir, { recursive: true });
          await appendFile(path, line + '\n');
        })().catch((err: unknown) => {
          context.log.error('Failed to append trace span', { error: String(err) });
        });

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

        // Asynchronous non-blocking write of all trace logs grouped by trace
        void (async () => {
          for (const [traceId, { timestamp, lines }] of byTrace) {
            const dir = join(state.tracesDir, dayFolder(timestamp));
            const path = join(dir, traceId + '.jsonl');
            await mkdir(dir, { recursive: true });
            await appendFile(path, lines.join('\n') + '\n');
          }
        })().catch((err: unknown) => {
          context.log.error('Failed to flush trace spans', { error: String(err) });
        });

        const written = state.written + state.buffer.length
        context.log.debug(`flushed ${state.buffer.length} spans across ${byTrace.size} traces (${written} total)`)
        return { state: { ...state, buffer: [], written } }
      },
    }),

    lifecycle: onLifecycle({
      start: async (state, context) => {
        await mkdir(tracesDir, { recursive: true })

        context.subscribe(TraceTopic, (span) => ({ type: 'span', span }))

        if (flushIntervalMs && flushIntervalMs > 0) {
          context.timers.startPeriodicTimer('flush', { type: 'flush' }, flushIntervalMs)
        }

        context.log.info(`persisting traces to ${tracesDir}/`)
        return { state: { ...state, tracesDir } }
      },

      stopped: async (state, context) => {
        if (state.buffer.length > 0) {
          const byTrace = new Map<string, { timestamp: number; lines: string[] }>()
          for (const { traceId, timestamp, line } of state.buffer) {
            const entry = byTrace.get(traceId) ?? { timestamp, lines: [] }
            entry.lines.push(line)
            byTrace.set(traceId, entry)
          }
          try {
            for (const [traceId, { timestamp, lines }] of byTrace) {
              const dir = join(state.tracesDir, dayFolder(timestamp))
              const path = join(dir, traceId + '.jsonl')
              await mkdir(dir, { recursive: true })
              await appendFile(path, lines.join('\n') + '\n')
            }
            const written = state.written + state.buffer.length
            context.log.info(`final flush: ${state.buffer.length} spans (${written} total)`)
            return { state: { ...state, buffer: [], written } }
          } catch (err) {
            context.log.error('Failed to perform final trace flush', { error: String(err) })
          }
        }

        context.log.info(`stopped — ${state.written} spans persisted`)
        return { state }
      },
    }),
  }
}
