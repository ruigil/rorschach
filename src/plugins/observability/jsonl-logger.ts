import { appendFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ActorDef, MessageHandler } from '../../system/index.ts'
import { LogTopic } from '../../system/index.ts'
import { OutboundAdminBroadcastTopic } from '../../types/events.ts'
import type { JsonlLoggerMsg } from './types.ts'
import { onLifecycle, onMessage } from '../../system/index.ts'

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
  /** True when currently awaiting a file rollover directory/file creation */
  rotating?: boolean
}

// ─── Helpers ───

const currentDateStr = (): string => {
  return new Date().toISOString().slice(0, 10)
}

const resolvePath = (template: string, dateStr: string): string => {
  return template.replace('{date}', dateStr)
}

const ensureFile = async (path: string): Promise<void> => {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  try {
    await writeFile(path, '', { flag: 'wx' })
  } catch {}
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
export const JsonlLogger = (
  options: JsonlLoggerOptions,
): ActorDef<JsonlLoggerMsg, JsonlLoggerState> => {
  const { filePath, flushIntervalMs, minLevel = 'debug' } = options
  const minLevelValue = LOG_LEVEL_ORDER[minLevel]

  const handler: MessageHandler<JsonlLoggerMsg, JsonlLoggerState> = onMessage<JsonlLoggerMsg, JsonlLoggerState>({
    log: (state, message, context) => {
      if (state.rotating) {
        return { state, stash: true }
      }

      // Broadcast to admin WS clients
      context.publish(OutboundAdminBroadcastTopic, {
        text: JSON.stringify({ type: 'log', ...message.event }),
      })

      // Drop events below the minimum level for file storage
      if (LOG_LEVEL_ORDER[message.event.level] < minLevelValue) return { state }

      const line = JSON.stringify(message.event)
      const today = currentDateStr()

      if (today !== state.dateStr) {
        context.pipeToSelf(
          (async () => {
            const newPath = resolvePath(state.filePath, today)
            await ensureFile(newPath)
            return { today, resolvedPath: newPath }
          })(),
          res => ({ type: '_rotated' as const, dateStr: res.today, resolvedPath: res.resolvedPath }),
          err => {
            context.log.error('log rotation failed', { error: String(err) })
            return { type: '_rotated' as const, dateStr: today, resolvedPath: state.resolvedPath }
          }
        )
        return { state: { ...state, rotating: true }, stash: true }
      }

      // Buffered mode: accumulate lines, write on flush
      if (flushIntervalMs && flushIntervalMs > 0) {
        return { state: { ...state, buffer: [...state.buffer, line] } }
      }

      // Unbuffered mode: append immediately (fire-and-forget async)
      appendFile(state.resolvedPath, line + '\n').catch(err => {
        context.log.error('Failed to append log line', { error: String(err) })
      })
      return { state: { ...state, written: state.written + 1 } }
    },

    _rotated: (state, message) => {
      return {
        state: { ...state, dateStr: message.dateStr, resolvedPath: message.resolvedPath, rotating: false },
        become: handler,
        unstashAll: true
      }
    },
    
    flush: (state, _message, context) => {
      if (state.buffer.length === 0) return { state }

      const chunk = state.buffer.join('\n') + '\n'
      appendFile(state.resolvedPath, chunk).catch(err => {
        context.log.error('Failed to flush log lines', { error: String(err) })
      })

      const written = state.written + state.buffer.length
      return { state: { ...state, buffer: [], written } }
    },
  })

  return {
    initialState: { filePath, resolvedPath: filePath, dateStr: '', written: 0, buffer: [] },
    handler,

    lifecycle: onLifecycle({
      start: async (state, context) => {
        const dateStr = currentDateStr()
        const resolvedPath = resolvePath(filePath, dateStr)
        await ensureFile(resolvedPath)

        // Subscribe to system log topic — adapter receives LogEvent directly (type-safe)
        context.subscribe(LogTopic, (event) => ({ type: 'log', event }))

        // Start a periodic flush timer if buffered mode is configured
        if (flushIntervalMs && flushIntervalMs > 0) {
          context.timers.startPeriodicTimer('flush', { type: 'flush' }, flushIntervalMs)
        }

        context.log.info(`persisting logs to ${resolvedPath}`)
        return { state: { ...state, filePath, resolvedPath, dateStr } }
      },

      stopped: async (state, context) => {
        // Flush any remaining buffered entries before stopping
        if (state.buffer.length > 0) {
          const chunk = state.buffer.join('\n') + '\n'
          try {
            await appendFile(state.resolvedPath, chunk)
            const written = state.written + state.buffer.length
            context.log.info(`final flush: ${state.buffer.length} entries (${written} total)`)
            return { state: { ...state, buffer: [], written } }
          } catch (err) {
            context.log.error('Failed to perform final flush', { error: String(err) })
          }
        }

        context.log.info(`stopped — ${state.written} log entries persisted`)
        return { state }
      },
    }),
  }
}
