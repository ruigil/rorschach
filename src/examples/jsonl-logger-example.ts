import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPluginSystem, LogTopic, SystemLifecycleTopic } from '../system/index.ts'
import { createJsonlLoggerActor, type JsonlLoggerState } from '../actors/jsonl-logger.ts'
import { createHttpActor, type HttpState } from '../actors/http.ts'
import type { LifecycleEvent, LogEvent } from '../system/types.ts'

// ─── Resolve log file path relative to project root ───
const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG_FILE = join(__dirname, '../../logs/app.jsonl')

// ─── Create the actor system ───
const system = await createPluginSystem()

// ─── Observe top-level actor lifecycle events ───
system.subscribe('lifecycle-observer', SystemLifecycleTopic, (event) => {
  const e = event as LifecycleEvent
  if (e.type === 'terminated') {
    console.log(`[system] actor ${e.ref.name} terminated (${e.reason})`)
  }
})

// ─── Optional: also print logs to console for visibility ───
system.subscribe('console-logger', LogTopic, (event) => {
  const log = event as LogEvent
  const ts = new Date(log.timestamp).toISOString().slice(11, 23)
  console.log(`[${ts}] ${log.level.toUpperCase().padEnd(5)} [${log.source}] ${log.message}`)
})

// ─── Spawn the JSONL logger actor ───
// It subscribes to system logs and persists them as JSON lines to disk.
const loggerInitialState: JsonlLoggerState = { filePath: LOG_FILE, written: 0, buffer: [] }
system.spawn('jsonl-logger', createJsonlLoggerActor({
  filePath: LOG_FILE,
  minLevel: 'info',          // only persist info and above
  // flushIntervalMs: 2000,  // uncomment for buffered mode (flush every 2s)
}), loggerInitialState)

// ─── Spawn the HTTP actor to generate some log traffic ───
const httpInitialState: HttpState = { server: null, connections: 0 }
system.spawn('http', createHttpActor({ port: 3000 }), httpInitialState)

console.log(`\n🚀 Rorschach running — open http://localhost:3000`)
console.log(`📝 Logs are being persisted to ${LOG_FILE}\n`)

// ─── Graceful shutdown on Ctrl+C ───
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down…')
  await system.shutdown()
  console.log(`📄 Check your logs: cat ${LOG_FILE}`)
  process.exit(0)
})
