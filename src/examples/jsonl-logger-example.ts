import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPluginSystem, createConfigPlugin, LogTopic, SystemLifecycleTopic } from '../system/index.ts'
import observabilityPlugin from '../plugins/observability/observability.plugin.ts'
import interfacesPlugin from '../plugins/interfaces/interfaces.plugin.ts'
import type { LifecycleEvent, LogEvent } from '../system/types.ts'

// ─── Resolve log file path relative to project root ───
const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG_FILE = join(__dirname, '../../logs/app.jsonl')

// ─── Create the actor system with unified config ───
const system = await createPluginSystem({
  plugins: [
    createConfigPlugin({
      observability: {
        jsonlLogger: {
          filePath: LOG_FILE,
          minLevel: 'info',         // only persist info and above
          // flushIntervalMs: 2000, // uncomment for buffered mode (flush every 2s)
        },
      },
      interfaces: { http: { port: 3000 } },
    }),
    observabilityPlugin,
    interfacesPlugin,
  ],
})

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

console.log(`\n🚀 Rorschach running — open http://localhost:3000`)
console.log(`📝 Logs are being persisted to ${LOG_FILE}\n`)

// ─── Graceful shutdown on Ctrl+C ───
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down…')
  await system.shutdown()
  console.log(`📄 Check your logs: cat ${LOG_FILE}`)
  process.exit(0)
})
