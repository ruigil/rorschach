import { createPluginSystem, LogTopic, SystemLifecycleTopic } from '../system/index.ts'
import { createHttpActor, type HttpState } from '../actors/http.ts'
import { createChatbotActor } from '../actors/chatbot.ts'
import type { LifecycleEvent, LogEvent } from '../system/types.ts'

const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) {
  console.error('Error: OPENROUTER_API_KEY environment variable is not set.')
  process.exit(1)
}

// ─── Create the actor system ───
const system = await createPluginSystem()

// ─── Subscribe to system logs ───
system.subscribe('console-logger', LogTopic, (event) => {
  const log = event as LogEvent
  const ts = new Date(log.timestamp).toISOString().slice(11, 23)
  console.log(`[${ts}] ${log.level.toUpperCase().padEnd(5)} [${log.source}] ${log.message}`)
})

// ─── Observe actor lifecycle events ───
system.subscribe('lifecycle-observer', SystemLifecycleTopic, (event) => {
  const e = event as LifecycleEvent
  if (e.type === 'terminated') {
    console.log(`[system] actor ${e.ref.name} terminated (${e.reason})`)
  }
})

// ─── Spawn actors ───
const initialHttpState: HttpState = { server: null, connections: 0 }
system.spawn('http', createHttpActor({ port: 3000 }), initialHttpState)

system.spawn('chatbot', createChatbotActor({
  apiKey,
  model: process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini',
  systemPrompt: process.env.CHATBOT_SYSTEM_PROMPT,
}), {
  history: {},
  pending: {}
})

console.log('\n🚀 Chatbot running — open http://localhost:3000\n')

// ─── Graceful shutdown on Ctrl+C ───
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down…')
  await system.shutdown()
  process.exit(0)
})
