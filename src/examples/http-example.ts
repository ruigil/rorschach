import { createActorSystem, LogTopic, SystemLifecycleTopic } from '../system/index.ts'
import { createHttpActor, type HttpState } from '../actors/http.ts'
import type { LifecycleEvent, LogEvent } from '../system/types.ts'

// ─── Create the actor system ───
const system = createActorSystem()

// ─── Observe top-level actor lifecycle events ───
system.subscribe('lifecycle-observer', SystemLifecycleTopic, (event) => {
  const e = event as LifecycleEvent
  if (e.type === 'terminated') {
    console.log(`[system] actor ${e.ref.name} terminated (${e.reason})`)
  }
})

// ─── Subscribe to system logs so we can see what's happening ───
system.subscribe('console-logger', LogTopic, (event) => {
  const log = event as LogEvent
  const ts = new Date(log.timestamp).toISOString().slice(11, 23)
  console.log(`[${ts}] ${log.level.toUpperCase().padEnd(5)} [${log.source}] ${log.message}`)
})

// ─── Spawn the HTTP actor ───
const initialState: HttpState = { server: null, connections: 0 }
const httpRef = system.spawn('http', createHttpActor({ port: 3000 }), initialState)

// ─── Subscribe to domain events published by the HTTP actor ───
// The actor publishes { clientId, text } events for every ws:message it receives
system.subscribe('text-handler', 'system/http', (event) => {
  const { clientId, text } = event as { clientId: string; text: string }
  console.log(`\n📨 Received from browser [${clientId.slice(0, 8)}…]: "${text}"\n`)
})

console.log('\n🚀 Rorschach HTTP actor running — open http://localhost:3000\n')

// ─── Graceful shutdown on Ctrl+C ───
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down…')
  await system.shutdown()
  process.exit(0)
})
