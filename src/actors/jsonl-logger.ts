import { appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ActorDef, LogEvent } from '../system/types.ts'
import { LogTopic } from '../system/types.ts'

// ─── Message protocol ───

export type JsonlLoggerMsg =
  | { type: 'log'; event: LogEvent }
  | { type: 'flush' }

// ─── Actor state ───

export type JsonlLoggerState = {
  /** Absolute path to the JSONL output file */
  filePath: string
  /** Number of log entries written since start */
  written: number
  /** Internal buffer for batched writes */
  buffer: string[]
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
 * The actor subscribes to the system log topic during `setup` and writes
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
    setup: (state, context) => {
      // Ensure the target directory exists
      const dir = dirname(filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      // Touch the file so it exists (append mode — preserves existing content)
      if (!existsSync(filePath)) {
        writeFileSync(filePath, '')
      }

      // Subscribe to system log topic — adapt each event into our message type
      context.subscribe(LogTopic, (event) => {
        return { type: 'log', event: event as LogEvent }
      })

      // Start a periodic flush timer if buffered mode is configured
      if (flushIntervalMs && flushIntervalMs > 0) {
        context.timers.startPeriodicTimer('flush', { type: 'flush' }, flushIntervalMs)
      }

      context.log.info(`persisting logs to ${filePath}`)

      return { ...state, filePath }
    },

    handler: (state, message, context) => {
      switch (message.type) {
        case 'log': {
          const { event } = message

          // Drop events below the minimum level
          if (LOG_LEVEL_ORDER[event.level] < minLevelValue) {
            return { state }
          }

          const line = JSON.stringify(event)

          // Buffered mode: accumulate lines, write on flush
          if (flushIntervalMs && flushIntervalMs > 0) {
            return {
              state: {
                ...state,
                buffer: [...state.buffer, line],
              },
            }
          }

          // Unbuffered mode: append immediately
          appendFileSync(state.filePath, line + '\n')
          return { state: { ...state, written: state.written + 1 } }
        }

        case 'flush': {
          if (state.buffer.length === 0) {
            return { state }
          }

          const chunk = state.buffer.join('\n') + '\n'
          appendFileSync(state.filePath, chunk)

          const written = state.written + state.buffer.length
          context.log.debug(`flushed ${state.buffer.length} log entries (${written} total)`)

          return {
            state: { ...state, buffer: [], written },
          }
        }
      }
    },

    lifecycle: (state, event, context) => {
      if (event.type === 'stopped') {
        // Flush any remaining buffered entries before stopping
        if (state.buffer.length > 0) {
          const chunk = state.buffer.join('\n') + '\n'
          appendFileSync(state.filePath, chunk)
          const written = state.written + state.buffer.length
          context.log.info(`final flush: ${state.buffer.length} entries (${written} total)`)
          return { state: { ...state, buffer: [], written } }
        }

        context.log.info(`stopped — ${state.written} log entries persisted`)
      }

      return { state }
    },
  }
}
