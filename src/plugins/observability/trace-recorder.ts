import { TraceTopic, type ActorDef, type ActorRef } from '../../system/index.ts'
import { OutboundAdminBroadcastTopic } from '../../types/events.ts'
import type { TraceRecorderMsg, TraceRecorderState, TraceRecorderOptions } from './types.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { PersistenceProviderTopic, type PersistenceMsg } from '../../types/persistence.ts'

// ─── Helpers ───

const dayFolder = (timestamp: number): string =>
  new Date(timestamp).toISOString().slice(0, 10) // "YYYY-MM-DD"

// ─── Actor state ───



// ─── Options ───



/**
 * Creates a trace recorder actor definition.
 *
 * The actor subscribes to the system trace topic on the `start` lifecycle event
 * and persists every received `TraceSpan` as a single JSON line to
 * `traces/{date}/{traceId}.jsonl` via the persistence plugin's document store,
 * grouping all spans of a logical request in one file.
 *
 * Supports optional buffered writes via `flushIntervalMs`.
 * On stop, any remaining buffered spans are flushed.
 */
export const TraceRecorder = (
  options: TraceRecorderOptions,
): ActorDef<TraceRecorderMsg, TraceRecorderState> => {
  const { tracesDir, flushIntervalMs } = options

  const flushBuffer = (ref: ActorRef<PersistenceMsg>, buffer: TraceRecorderState['buffer']): void => {
    if (buffer.length === 0) return
    const byTrace = new Map<string, { timestamp: number; lines: string[] }>()
    for (const { traceId, timestamp, line } of buffer) {
      const entry = byTrace.get(traceId) ?? { timestamp, lines: [] }
      entry.lines.push(line)
      byTrace.set(traceId, entry)
    }
    for (const [traceId, { timestamp, lines }] of byTrace) {
      const docId = `${dayFolder(timestamp)}/${traceId}.jsonl`
      ref.send({
        type: 'doc.append',
        collection: 'traces',
        docId,
        content: lines.join('\n') + '\n',
      })
    }
  }

  return {
    initialState: { tracesDir, written: 0, buffer: [], persistenceRef: null },
    handler: onMessage({
      span(state, message, context) {
        // Broadcast to admin WS clients
        context.publish(OutboundAdminBroadcastTopic, {
          type: 'trace',
          key: message.span.spanId,
          payload: JSON.stringify({ type: 'trace', ...message.span }),
        })

        const line = JSON.stringify(message.span)

        if (!state.persistenceRef || (flushIntervalMs && flushIntervalMs > 0)) {
          return { state: { ...state, buffer: [...state.buffer, { traceId: message.span.traceId, timestamp: message.span.timestamp, line }] } }
        }

        const docId = `${dayFolder(message.span.timestamp)}/${message.span.traceId}.jsonl`
        state.persistenceRef.send({
          type: 'doc.append',
          collection: 'traces',
          docId,
          content: line + '\n',
        })
        return { state: { ...state, written: state.written + 1 } }
      },

      _persistenceRef: (state, message) => {
        if (!message.ref) {
          return { state: { ...state, persistenceRef: null } }
        }
        let nextState = { ...state, persistenceRef: message.ref }
        flushBuffer(message.ref, nextState.buffer)
        nextState.written += nextState.buffer.length
        nextState.buffer = []
        return { state: nextState }
      },

      flush(state, _message, context) {
        if (state.buffer.length === 0 || !state.persistenceRef) return { state }

        flushBuffer(state.persistenceRef, state.buffer)

        const written = state.written + state.buffer.length
        context.log.debug(`flushed ${state.buffer.length} spans across ${new Set(state.buffer.map(b => b.traceId)).size} traces (${written} total)`)
        return { state: { ...state, buffer: [], written } }
      },
    }),

    lifecycle: onLifecycle({
      start: (state, context) => {
        // Subscribe to Persistence provider
        context.subscribe(PersistenceProviderTopic, (event) => ({
          type: '_persistenceRef' as const,
          ref: event.ref,
        }))

        context.subscribe(TraceTopic, (span) => ({ type: 'span', span }))

        if (flushIntervalMs && flushIntervalMs > 0) {
          context.timers.startPeriodicTimer('flush', { type: 'flush' }, flushIntervalMs)
        }

        context.log.info(`persisting traces via persistence plugin`)
        return { state }
      },

      stopped: async (state, context) => {
        if (state.buffer.length > 0 && state.persistenceRef) {
          flushBuffer(state.persistenceRef, state.buffer)
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
