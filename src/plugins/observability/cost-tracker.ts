import { appendFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActorDef, MessageHandler } from '../../system/index.ts'
import { CostTopic } from '../../types/llm.ts'
import type { CostTrackerMsg } from './types.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'

// ─── Actor state ───

export type CostTrackerState = {
  costsDir: string
  dateStr: string
  resolvedPath: string
  written: number
  buffer: string[]
  rotating?: boolean
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

function resolvedFilePath(costsDir: string, dateStr: string): string {
  return join(costsDir, `costs-${dateStr}.jsonl`)
}

async function ensureFile(path: string, costsDir: string): Promise<void> {
  await mkdir(costsDir, { recursive: true })
  try {
    await writeFile(path, '', { flag: 'wx' })
  } catch {}
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
 * every received `CostEvent` as a single JSON line to a daily file at
 * `{costsDir}/costs-{YYYY-MM-DD}.jsonl`.
 *
 * In-memory `dailyTotals` accumulate cost and token counts for the current day,
 * broken down by model. Totals reset automatically when the calendar day rolls over.
 *
 * Supports optional buffered writes via `flushIntervalMs`.
 * On stop, any remaining buffered events are flushed to disk.
 */
export const CostTracker = (
  options: CostTrackerOptions,
): ActorDef<CostTrackerMsg, CostTrackerState> => {
  const { costsDir, flushIntervalMs } = options

  const handler: MessageHandler<CostTrackerMsg, CostTrackerState> = onMessage<CostTrackerMsg, CostTrackerState>({
    cost: (state, message, context) => {
      if (state.rotating) {
        return { state, stash: true }
      }

      const { event } = message

      // Check for day rollover
      const today = currentDateStr()
      if (today !== state.dateStr) {
        context.pipeToSelf(
          (async () => {
            const newPath = resolvedFilePath(costsDir, today)
            await ensureFile(newPath, costsDir)
            return { today, resolvedPath: newPath }
          })(),
          res => ({ type: '_rotated' as const, dateStr: res.today, resolvedPath: res.resolvedPath }),
          err => {
            context.log.error('cost tracker rotation failed', { error: String(err) })
            return { type: '_rotated' as const, dateStr: today, resolvedPath: state.resolvedPath }
          }
        )
        return { state: { ...state, rotating: true }, stash: true }
      }

      const line = JSON.stringify(event)

      // Update in-memory daily totals
      const cost = event.cost ?? 0
      const prev = state.dailyTotals.byModel[event.model] ?? { cost: 0, inputTokens: 0, outputTokens: 0 }
      const dailyTotals: CostTrackerState['dailyTotals'] = {
        totalCost:         state.dailyTotals.totalCost         + cost,
        totalInputTokens:  state.dailyTotals.totalInputTokens  + event.inputTokens,
        totalOutputTokens: state.dailyTotals.totalOutputTokens + event.outputTokens,
        byModel: {
          ...state.dailyTotals.byModel,
          [event.model]: {
            cost:         prev.cost         + cost,
            inputTokens:  prev.inputTokens  + event.inputTokens,
            outputTokens: prev.outputTokens + event.outputTokens,
          },
        },
      }

      if (flushIntervalMs && flushIntervalMs > 0) {
        return { state: { ...state, buffer: [...state.buffer, line], dailyTotals } }
      }

      appendFile(state.resolvedPath, line + '\n').catch(err => {
        context.log.error('Failed to append cost event', { error: String(err) })
      })
      return { state: { ...state, written: state.written + 1, dailyTotals } }
    },

    _rotated: (state, message) => {
      return {
        state: { ...state, dateStr: message.dateStr, resolvedPath: message.resolvedPath, dailyTotals: emptyTotals(), rotating: false },
        become: handler,
        unstashAll: true
      }
    },

    flush: (state, _message, context) => {
      if (state.buffer.length === 0) return { state }

      const chunk = state.buffer.join('\n') + '\n'
      appendFile(state.resolvedPath, chunk).catch(err => {
        context.log.error('Failed to flush cost events', { error: String(err) })
      })

      const written = state.written + state.buffer.length
      return { state: { ...state, buffer: [], written } }
    },
  })

  return {
    initialState: { costsDir, dateStr: '', resolvedPath: '', written: 0, buffer: [], dailyTotals: { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, byModel: {} } },
    handler,

    lifecycle: onLifecycle({
      start: async (state, context) => {
        const dateStr = currentDateStr()
        const resolvedPath = resolvedFilePath(costsDir, dateStr)
        await ensureFile(resolvedPath, costsDir)

        context.subscribe(CostTopic, (event) => ({ type: 'cost', event }))

        if (flushIntervalMs && flushIntervalMs > 0) {
          context.timers.startPeriodicTimer('flush', { type: 'flush' }, flushIntervalMs)
        }

        context.log.info(`persisting costs to ${costsDir}/`)
        return { state: { ...state, costsDir, dateStr, resolvedPath } }
      },

      stopped: async (state, context) => {
        if (state.buffer.length > 0) {
          const chunk = state.buffer.join('\n') + '\n'
          try {
            await appendFile(state.resolvedPath, chunk)
            const written = state.written + state.buffer.length
            context.log.info(`final flush: ${state.buffer.length} cost events (${written} total)`)
            return { state: { ...state, buffer: [], written } }
          } catch (err) {
            context.log.error('Failed to perform final cost flush', { error: String(err) })
          }
        }

        context.log.info(`stopped — ${state.written} cost events persisted`)
        return { state }
      },
    }),
  }
}
