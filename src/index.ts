import { AgentSystem, SystemLifecycleTopic, type LifecycleEvent } from './system/index.ts'
import { type ConfigUpdateRequest, ConfigUpdateRequestTopic } from './plugins/interfaces/types.ts'
import { loadConfig, saveConfig } from './config.ts'

// ─── Load config and plugins from config.json ───

const { plugins, config, configPath } = await loadConfig()

// ─── Create the actor system (plugins loaded in topo-sorted order) ───

const system = await AgentSystem({ plugins, config })

// ─── Apply config changes from the web UI ───

system.subscribe(ConfigUpdateRequestTopic, async ({ pluginId, patch }: ConfigUpdateRequest) => {
  system.updateConfig({ [pluginId]: patch })
  await saveConfig(configPath, { [pluginId]: patch })
})

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

