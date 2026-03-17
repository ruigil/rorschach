import { createPluginSystem, createConfigPlugin, LogTopic, SystemLifecycleTopic } from '../system/index.ts'
import interfacesPlugin from '../plugins/interfaces/interfaces.plugin.ts'
import cognitivePlugin from '../plugins/cognitive/cognitive.plugin.ts'
import type { LifecycleEvent, LogEvent } from '../system/types.ts'

const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) {
  console.error('Error: OPENROUTER_API_KEY environment variable is not set.')
  process.exit(1)
}

// ─── Create the actor system with unified config ───
const system = await createPluginSystem({
  plugins: [
    createConfigPlugin({
      interfaces: { http: { port: 3000 } },
      cognitive: {
        chatbot: {
          apiKey,
          model: process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini',
          systemPrompt: process.env.CHATBOT_SYSTEM_PROMPT,
        },
      },
    }),
    interfacesPlugin,
    cognitivePlugin,
  ],
})

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

console.log('\n🚀 Chatbot running — open http://localhost:3000\n')

// ─── Graceful shutdown on Ctrl+C ───
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down…')
  await system.shutdown()
  process.exit(0)
})
