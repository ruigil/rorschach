import {
  AgentSystem,
  SystemLifecycleTopic,
  type LifecycleEvent,
  fileSource,
  resolveConfigPath,
} from './system/index.ts'

// ─── Desired store + boot via first convergence ───
// Single operator path knob: --config / CONFIG_PATH / default config.json.

const configPath = resolveConfigPath()
const source = fileSource(configPath)
const system = await AgentSystem({ source })

// ─── Log actor lifecycle events to console ───

system.subscribe(SystemLifecycleTopic, (event) => {
  const e = event as LifecycleEvent
  if (e.type === 'watchStatus' && e.status === 'ok') {
    console.log(`[system] actor ${e.ref.name} started successfully`)
  }
  if (e.type === 'watchStatus' && e.status === 'terminated') {
    console.log(`[system] actor ${e.ref.name} terminated (${e.reason})`)
  }
})

console.log(`\n🚀 Rorschach running (config: ${configPath})`)

// ─── Graceful shutdown on Ctrl+C ───

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down…')
  await system.shutdown()
  process.exit(0)
})
