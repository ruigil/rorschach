import { appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ActorDef } from '../../system/types.ts'
import { CostTopic } from '../../types/llm.ts'
import type { CostTrackerMsg } from './types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'

// ─── Actor state ───

export type CostTrackerState = {
  costsDir: string
  dateStr: string
  resolvedPath: string
  written: number
  buffer: string[]
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

function ensureFile(path: string, costsDir: string): void {
  if (!existsSync(costsDir)) mkdirSync(costsDir, { recursive: true })
  if (!existsSync(path)) writeFileSync(path, '')
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
export const createCostTrackerActor = (
  options: CostTrackerOptions,
): ActorDef<CostTrackerMsg, CostTrackerState> => {
  const { costsDir, flushIntervalMs } = options

  return {
    handler: onMessage({
      cost(state, message) {
        const { event } = message

        // Check for day rollover
        const today = currentDateStr()
        let rotated = state
        if (today !== state.dateStr) {
          const newPath = resolvedFilePath(costsDir, today)
          ensureFile(newPath, costsDir)
          rotated = { ...state, dateStr: today, resolvedPath: newPath, dailyTotals: emptyTotals() }
        }

        const line = JSON.stringify(event)

        // Update in-memory daily totals
        const cost = event.cost ?? 0
        const prev = rotated.dailyTotals.byModel[event.model] ?? { cost: 0, inputTokens: 0, outputTokens: 0 }
        const dailyTotals: CostTrackerState['dailyTotals'] = {
          totalCost:         rotated.dailyTotals.totalCost         + cost,
          totalInputTokens:  rotated.dailyTotals.totalInputTokens  + event.inputTokens,
          totalOutputTokens: rotated.dailyTotals.totalOutputTokens + event.outputTokens,
          byModel: {
            ...rotated.dailyTotals.byModel,
            [event.model]: {
              cost:         prev.cost         + cost,
              inputTokens:  prev.inputTokens  + event.inputTokens,
              outputTokens: prev.outputTokens + event.outputTokens,
            },
          },
        }

        if (flushIntervalMs && flushIntervalMs > 0) {
          return { state: { ...rotated, buffer: [...rotated.buffer, line], dailyTotals } }
        }

        appendFileSync(rotated.resolvedPath, line + '\n')
        return { state: { ...rotated, written: rotated.written + 1, dailyTotals } }
      },

      flush(state) {
        if (state.buffer.length === 0) return { state }

        const chunk = state.buffer.join('\n') + '\n'
        appendFileSync(state.resolvedPath, chunk)

        const written = state.written + state.buffer.length
        return { state: { ...state, buffer: [], written } }
      },
    }),

    lifecycle: onLifecycle({
      start: (state, context) => {
        const dateStr = currentDateStr()
        const resolvedPath = resolvedFilePath(costsDir, dateStr)
        ensureFile(resolvedPath, costsDir)

        context.subscribe(CostTopic, (event) => ({ type: 'cost', event }))

        if (flushIntervalMs && flushIntervalMs > 0) {
          context.timers.startPeriodicTimer('flush', { type: 'flush' }, flushIntervalMs)
        }

        context.log.info(`persisting costs to ${costsDir}/`)
        return { state: { ...state, costsDir, dateStr, resolvedPath } }
      },

      stopped: (state, context) => {
        if (state.buffer.length > 0) {
          const chunk = state.buffer.join('\n') + '\n'
          appendFileSync(state.resolvedPath, chunk)
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
