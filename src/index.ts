import { AgentSystem, SystemLifecycleTopic, type LifecycleEvent } from './system/index.ts'
import { loadConfig } from './config.ts'
import { wireConfigManager } from './config-set.ts'

// ─── Load config and plugins from config.json ───

const { plugins, config, configPath } = await loadConfig()

// ─── Create the actor system (plugins loaded in topo-sorted order) ───

const system = await AgentSystem({ plugins, config })

wireConfigManager(system, configPath)


// ─── Log actor lifecycle events to console ───

system.subscribe(SystemLifecycleTopic, (event) => {
  const e = event as LifecycleEvent
  if (e.type === 'terminated') {
    console.log(`[system] actor ${e.ref.name} terminated (${e.reason})`)
  }
})

console.log(`\n🚀 Rorschach running`)

// ─── Graceful shutdown on Ctrl+C ───

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down…')
  await system.shutdown()
  process.exit(0)
})

