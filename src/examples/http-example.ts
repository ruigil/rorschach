import { createPluginSystem, LogTopic, SystemLifecycleTopic } from '../system/index.ts'
import { WsMessageTopic } from '../system/topics.ts'
import interfacesPlugin from '../plugins/interfaces/interfaces.plugin.ts'
import type { LifecycleEvent, LogEvent } from '../system/types.ts'

// ─── Create the actor system with unified config ───
const system = await createPluginSystem({
  config: { interfaces: { http: { port: 3000 } } },
  plugins: [interfacesPlugin],
})

// ─── Observe top-level actor lifecycle events ───
system.subscribe(SystemLifecycleTopic, (event) => {
  const e = event as LifecycleEvent
  if (e.type === 'terminated') {
    console.log(`[system] actor ${e.ref.name} terminated (${e.reason})`)
  }
})

// ─── Subscribe to system logs so we can see what's happening ───
system.subscribe(LogTopic, (event) => {
  const log = event as LogEvent
  const ts = new Date(log.timestamp).toISOString().slice(11, 23)
  console.log(`[${ts}] ${log.level.toUpperCase().padEnd(5)} [${log.source}] ${log.message}`)
})

// ─── Subscribe to domain events published by the HTTP actor ───
system.subscribe(WsMessageTopic, ({ clientId, text }) => {
  console.log(`\n📨 Received from browser [${clientId.slice(0, 8)}…]: "${text}"\n`)
})

console.log('\n🚀 Rorschach HTTP actor running — open http://localhost:3000\n')

// ─── Graceful shutdown on Ctrl+C ───
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down…')
  await system.shutdown()
  process.exit(0)
})
