import type { ActorDef, MessageHandler, ActorRef } from '../../system/index.ts'
import { CostTopic } from '../../types/llm.ts'
import type { CostTrackerMsg } from './types.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'
import { PersistenceProviderTopic, type PersistenceMsg } from '../../types/persistence.ts'

// ─── Actor state ───

export type CostTrackerState = {
  dateStr: string
  written: number
  buffer: string[]
  persistenceRef: ActorRef<PersistenceMsg> | null
  dailyTotals: {
    totalCost: number
    totalInputTokens: number
    totalOutputTokens: number
    byModel: Record<string, { cost: number; inputTokens: number; outputTokens: number }>
  }
}

// ─── Options ───

export type CostTrackerOptions = {
  /** Directory where daily cost JSONL files are written. Created automatically. */
  costsDir: string
  /**
   * If set, events are buffered and flushed every `flushIntervalMs` milliseconds.
   * If omitted, every event is appended immediately (unbuffered).
   */
  flushIntervalMs?: number
}

// ─── Helpers ───

function currentDateStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function docId(dateStr: string): string {
  return `costs-${dateStr}.jsonl`
}

const emptyTotals = (): CostTrackerState['dailyTotals'] => ({
  totalCost: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  byModel: {},
})

/**
 * Creates a cost tracker actor definition.
 *
 * The actor subscribes to `CostTopic` on the `start` lifecycle event and writes
 * every received `CostEvent` as a single JSON line to `costs/costs-{YYYY-MM-DD}.jsonl`
 * via the persistence plugin's document store.
 *
 * In-memory `dailyTotals` accumulate cost and token counts for the current day,
 * broken down by model. Totals reset automatically when the calendar day rolls over.
 *
 * Supports optional buffered writes via `flushIntervalMs`.
 * On stop, any remaining buffered events are flushed.
 */
export const CostTracker = (
  options: CostTrackerOptions,
): ActorDef<CostTrackerMsg, CostTrackerState> => {
  const { flushIntervalMs } = options

  const handler: MessageHandler<CostTrackerMsg, CostTrackerState> = onMessage<CostTrackerMsg, CostTrackerState>({
    cost: (state, message, context) => {
      const { event } = message

      // Check for day rollover (synchronous — persistence actor handles storage)
      const today = currentDateStr()
      const isNewDay = today !== state.dateStr
      const dateStr = isNewDay ? today : state.dateStr
      const totals = isNewDay ? emptyTotals() : state.dailyTotals

      // Update in-memory daily totals
      const cost = event.cost ?? 0
      const prev = totals.byModel[event.model] ?? { cost: 0, inputTokens: 0, outputTokens: 0 }
      const dailyTotals: CostTrackerState['dailyTotals'] = {
        totalCost:         totals.totalCost         + cost,
        totalInputTokens:  totals.totalInputTokens  + event.inputTokens,
        totalOutputTokens: totals.totalOutputTokens + event.outputTokens,
        byModel: {
          ...totals.byModel,
          [event.model]: {
            cost:         prev.cost         + cost,
            inputTokens:  prev.inputTokens  + event.inputTokens,
            outputTokens: prev.outputTokens + event.outputTokens,
          },
        },
      }

      const line = JSON.stringify(event)

      if (!state.persistenceRef || (flushIntervalMs && flushIntervalMs > 0)) {
        return { state: { ...state, dateStr, buffer: [...state.buffer, line], dailyTotals } }
      }

      state.persistenceRef.send({
        type: 'doc.append',
        collection: 'costs',
        docId: docId(dateStr),
        content: line + '\n',
      })
      return { state: { ...state, dateStr, written: state.written + 1, dailyTotals } }
    },

    _persistenceRef: (state, message) => {
      if (!message.ref) {
        return { state: { ...state, persistenceRef: null } }
      }
      let nextState = { ...state, persistenceRef: message.ref }
      if (nextState.buffer.length > 0) {
        const chunk = nextState.buffer.join('\n') + '\n'
        message.ref.send({
          type: 'doc.append',
          collection: 'costs',
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
        collection: 'costs',
        docId: docId(state.dateStr),
        content: chunk,
      })

      const written = state.written + state.buffer.length
      return { state: { ...state, buffer: [], written } }
    },
  })

  return {
    initialState: { dateStr: '', written: 0, buffer: [], persistenceRef: null, dailyTotals: { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, byModel: {} } },
    handler,

    lifecycle: onLifecycle({
      start: (state, context) => {
        const dateStr = currentDateStr()

        // Subscribe to Persistence provider
        context.subscribe(PersistenceProviderTopic, (event) => ({
          type: '_persistenceRef' as const,
          ref: event.ref,
        }))

        context.subscribe(CostTopic, (event) => ({ type: 'cost', event }))

        if (flushIntervalMs && flushIntervalMs > 0) {
          context.timers.startPeriodicTimer('flush', { type: 'flush' }, flushIntervalMs)
        }

        context.log.info(`persisting costs via persistence plugin`)
        return { state: { ...state, dateStr } }
      },

      stopped: async (state, context) => {
        if (state.buffer.length > 0 && state.persistenceRef) {
          const chunk = state.buffer.join('\n') + '\n'
          state.persistenceRef.send({
            type: 'doc.append',
            collection: 'costs',
            docId: docId(state.dateStr),
            content: chunk,
          })
          const written = state.written + state.buffer.length
          context.log.info(`final flush: ${state.buffer.length} cost events (${written} total)`)
          return { state: { ...state, buffer: [], written } }
        }

        context.log.info(`stopped — ${state.written} cost events persisted`)
        return { state }
      },
    }),
  }
}
