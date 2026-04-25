import { appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ActorDef, LogEvent } from '../../system/types.ts'
import { LogTopic } from '../../system/types.ts'
import type { JsonlLoggerMsg } from './types.ts'
import { onLifecycle, onMessage } from '../../system/match.ts'

// ─── Actor state ───

export type JsonlLoggerState = {
  /** Path template (may contain `{date}`) or resolved absolute path */
  filePath: string
  /** Resolved path for the current day (equals filePath when no rotation) */
  resolvedPath: string
  /** Current date string YYYY-MM-DD used for daily rotation */
  dateStr: string
  /** Number of log entries written since start */
  written: number
  /** Internal buffer for batched writes */
  buffer: string[]
}

// ─── Helpers ───

function currentDateStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function resolvePath(template: string, dateStr: string): string {
  return template.replace('{date}', dateStr)
}

function ensureFile(path: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (!existsSync(path)) writeFileSync(path, '')
}

/** If the calendar day has rolled over, return new {resolvedPath, dateStr}; else null. */
function checkRotation(state: JsonlLoggerState): { resolvedPath: string; dateStr: string } | null {
  const today = currentDateStr()
  if (today === state.dateStr) return null
  const resolvedPath = resolvePath(state.filePath, today)
  ensureFile(resolvedPath)
  return { resolvedPath, dateStr: today }
}

// ─── Options ───

export type JsonlLoggerOptions = {
  /** Path to the output `.jsonl` file. Directories are created automatically. */
  filePath: string
  /**
   * If set, log entries are buffered and flushed every `flushIntervalMs` milliseconds.
   * If omitted, every log entry is appended immediately (unbuffered).
   */
  flushIntervalMs?: number
  /**
   * Minimum log level to persist.
   * Entries below this level are silently dropped.
   * Order: debug < info < warn < error.
   * Default: 'debug' (persist everything).
   */
  minLevel?: 'debug' | 'info' | 'warn' | 'error'
}

// ─── Log level ordering ───

const LOG_LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const

/**
 * Creates a JSONL log persistence actor definition.
 *
 * The actor subscribes to the system log topic on the `start` lifecycle event and writes
 * every received `LogEvent` as a single JSON line to the configured file.
 *
 * It supports optional buffered writes (via `flushIntervalMs`) and minimum
 * log level filtering (via `minLevel`).
 *
 * On stop, any remaining buffered entries are flushed to disk.
 */
export const createJsonlLoggerActor = (
  options: JsonlLoggerOptions,
): ActorDef<JsonlLoggerMsg, JsonlLoggerState> => {
  const { filePath, flushIntervalMs, minLevel = 'debug' } = options
  const minLevelValue = LOG_LEVEL_ORDER[minLevel]

  return {
    handler: onMessage({
      log(state, message) {
        // Drop events below the minimum level
        if (LOG_LEVEL_ORDER[message.event.level] < minLevelValue) return { state }

        const line = JSON.stringify(message.event)
        const rotation = checkRotation(state)
        const rotated = rotation ? { ...state, ...rotation } : state

        // Buffered mode: accumulate lines, write on flush
        if (flushIntervalMs && flushIntervalMs > 0) {
          return { state: { ...rotated, buffer: [...rotated.buffer, line] } }
        }

        // Unbuffered mode: append immediately
        appendFileSync(rotated.resolvedPath, line + '\n')
        return { state: { ...rotated, written: rotated.written + 1 } }
      },

      flush(state, _message, _context) {
        const rotation = checkRotation(state)
        const rotated = rotation ? { ...state, ...rotation } : state

        if (rotated.buffer.length === 0) return { state: rotated }

        const chunk = rotated.buffer.join('\n') + '\n'
        appendFileSync(rotated.resolvedPath, chunk)

        const written = rotated.written + rotated.buffer.length
        return { state: { ...rotated, buffer: [], written } }
      },
    }),

    lifecycle: onLifecycle({
      start: (state, context) => {
        const dateStr = currentDateStr()
        const resolvedPath = resolvePath(filePath, dateStr)
        ensureFile(resolvedPath)

        // Subscribe to system log topic — adapter receives LogEvent directly (type-safe)
        context.subscribe(LogTopic, (event) => ({ type: 'log', event }))

        // Start a periodic flush timer if buffered mode is configured
        if (flushIntervalMs && flushIntervalMs > 0) {
          context.timers.startPeriodicTimer('flush', { type: 'flush' }, flushIntervalMs)
        }

        context.log.info(`persisting logs to ${resolvedPath}`)
        return { state: { ...state, filePath, resolvedPath, dateStr } }
      },

      stopped: (state, context) => {
        // Flush any remaining buffered entries before stopping
        if (state.buffer.length > 0) {
          const chunk = state.buffer.join('\n') + '\n'
          appendFileSync(state.resolvedPath, chunk)
          const written = state.written + state.buffer.length
          context.log.info(`final flush: ${state.buffer.length} entries (${written} total)`)
          return { state: { ...state, buffer: [], written } }
        }

        context.log.info(`stopped — ${state.written} log entries persisted`)
        return { state }
      },
    }),
  }
}
