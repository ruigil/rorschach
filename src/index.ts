import {
  SystemLifecycleTopic,
  ConfigUpdateRequestTopic,
} from './system/index.ts'
import { loadConfig, saveConfig } from './config.ts'
import type { LifecycleEvent, ConfigUpdateRequest } from './system/index.ts'
import { AgentSystem } from './system/index.ts'

if (!process.env.OPENROUTER_API_KEY) {
  console.error('Error: OPENROUTER_API_KEY environment variable is not set.')
  process.exit(1)
}

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

