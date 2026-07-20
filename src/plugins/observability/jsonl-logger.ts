import type { ActorDef, MessageHandler, ActorRef } from '../../system/index.ts'
import { LogTopic } from '../../system/index.ts'
import { OutboundAdminBroadcastTopic } from '../../types/events.ts'
import type { JsonlLoggerMsg, JsonlLoggerState, JsonlLoggerOptions } from './types.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { PersistenceProviderTopic, type PersistenceMsg } from '../../types/persistence.ts'

// ─── Actor state ───



// ─── Helpers ───

const currentDateStr = (): string => {
  return new Date().toISOString().slice(0, 10)
}

const docId = (dateStr: string): string => {
  return `logs-${dateStr}.jsonl`
}

// ─── Options ───

const LOG_LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const

export const JsonlLogger = (
  options: JsonlLoggerOptions = {},
): ActorDef<JsonlLoggerMsg, JsonlLoggerState> => {
  const { flushIntervalMs, minLevel = 'debug' } = options
  const minLevelValue = LOG_LEVEL_ORDER[minLevel]

  const handler: MessageHandler<JsonlLoggerMsg, JsonlLoggerState> = onMessage<JsonlLoggerMsg, JsonlLoggerState>({
    log: (state, message, context) => {
      // Broadcast to admin WS clients
      context.publish(OutboundAdminBroadcastTopic, {
        type: 'observability.log.entry',
        key: 'log',
        payload: JSON.stringify({ type: 'observability.log.entry', ...message.event }),
      })

      // Drop events below the minimum level for file storage
      if (LOG_LEVEL_ORDER[message.event.level] < minLevelValue) return { state }

      const line = JSON.stringify(message.event)
      const today = currentDateStr()

      // If not resolved yet or in buffered mode
      if (!state.persistenceRef || (flushIntervalMs && flushIntervalMs > 0)) {
        return {
          state: {
            ...state,
            dateStr: today,
            buffer: [...state.buffer, line],
          },
        }
      }

      // Unbuffered mode with resolved persistence: append immediately via fire-and-forget send
      state.persistenceRef.send({
        type: 'doc.append',
        collection: 'logs',
        docId: docId(today),
        content: line + '\n',
      })

      return { state: { ...state, dateStr: today, written: state.written + 1 } }
    },

    _persistenceRef: (state, message) => {
      if (!message.ref) {
        return { state: { ...state, persistenceRef: null } }
      }
      // Flush any pre-resolution buffered entries immediately
      let nextState = { ...state, persistenceRef: message.ref }
      if (nextState.buffer.length > 0) {
        const chunk = nextState.buffer.join('\n') + '\n'
        message.ref.send({
          type: 'doc.append',
          collection: 'logs',
          docId: docId(nextState.dateStr),
          content: chunk,
        })
        nextState.written += nextState.buffer.length
        nextState.buffer = []
      }
      return { state: nextState }
    },

    flush: (state, _message, context) => {
      if (state.buffer.length === 0 || !state.persistenceRef) return { state }

      const chunk = state.buffer.join('\n') + '\n'
      state.persistenceRef.send({
        type: 'doc.append',
        collection: 'logs',
        docId: docId(state.dateStr),
        content: chunk,
      })

      const written = state.written + state.buffer.length
      return { state: { ...state, buffer: [], written } }
    },
  })

  return {
    initialState: { dateStr: '', written: 0, buffer: [], persistenceRef: null },
    handler,

    lifecycle: onLifecycle({
      start: (state, context) => {
        const dateStr = currentDateStr()

        // Subscribe to Persistence provider
        context.subscribe(PersistenceProviderTopic, (event) => ({
          type: '_persistenceRef' as const,
          ref: event.ref,
        }))

        // Subscribe to system log topic
        context.subscribe(LogTopic, (event) => ({ type: 'log', event }))

        // Start periodic flush if configured
        if (flushIntervalMs && flushIntervalMs > 0) {
          context.timers.startPeriodicTimer('flush', { type: 'flush' }, flushIntervalMs)
        }

        return { state: { ...state, dateStr } }
      },

      stopped: async (state, context) => {
        if (state.buffer.length > 0 && state.persistenceRef) {
          const chunk = state.buffer.join('\n') + '\n'
          state.persistenceRef.send({
            type: 'doc.append',
            collection: 'logs',
            docId: docId(state.dateStr),
            content: chunk,
          })
          const written = state.written + state.buffer.length
          context.log.info(`final flush: ${state.buffer.length} entries (${written} total)`)
          return { state: { ...state, buffer: [], written } }
        }
        return { state }
      },
    }),
  }
}
