import type { ActorDef, MessageHandler, ActorRef } from '../../system/index.ts'
import { LogTopic } from '../../system/index.ts'
import { OutboundAdminBroadcastTopic } from '../../types/events.ts'
import type { JsonlLoggerMsg } from './types.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { PersistenceProviderTopic, type PersistenceMsg } from '../../types/persistence.ts'

// ─── Actor state ───

export type JsonlLoggerState = {
  filePath: string
  docIdTemplate: string
  dateStr: string
  written: number
  buffer: string[]
  persistenceRef: ActorRef<PersistenceMsg> | null
}

// ─── Helpers ───

const currentDateStr = (): string => {
  return new Date().toISOString().slice(0, 10)
}



// ─── Options ───

export type JsonlLoggerOptions = {
  filePath: string
  flushIntervalMs?: number
  minLevel?: 'debug' | 'info' | 'warn' | 'error'
}

const LOG_LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const

export const JsonlLogger = (
  options: JsonlLoggerOptions,
): ActorDef<JsonlLoggerMsg, JsonlLoggerState> => {
  const { filePath, flushIntervalMs, minLevel = 'debug' } = options
  const minLevelValue = LOG_LEVEL_ORDER[minLevel]

  const docIdTemplate = filePath.substring(filePath.lastIndexOf('/') + 1)

  const handler: MessageHandler<JsonlLoggerMsg, JsonlLoggerState> = onMessage<JsonlLoggerMsg, JsonlLoggerState>({
    log: (state, message, context) => {
      // Broadcast to admin WS clients
      context.publish(OutboundAdminBroadcastTopic, {
        type: 'log',
        key: 'log',
        payload: JSON.stringify({ type: 'log', ...message.event }),
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
      const docId = state.docIdTemplate.replace('{date}', today)
      state.persistenceRef.send({
        type: 'doc.append',
        collection: 'logs',
        docId,
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
        const docId = nextState.docIdTemplate.replace('{date}', nextState.dateStr)
        message.ref.send({
          type: 'doc.append',
          collection: 'logs',
          docId,
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
      const docId = state.docIdTemplate.replace('{date}', state.dateStr)
      state.persistenceRef.send({
        type: 'doc.append',
        collection: 'logs',
        docId,
        content: chunk,
      })

      const written = state.written + state.buffer.length
      return { state: { ...state, buffer: [], written } }
    },
  })

  return {
    initialState: { filePath, docIdTemplate, dateStr: '', written: 0, buffer: [], persistenceRef: null },
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
          const docId = state.docIdTemplate.replace('{date}', state.dateStr)
          state.persistenceRef.send({
            type: 'doc.append',
            collection: 'logs',
            docId,
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
