import {
  LogTopic,
  MetricsTopic,
  SystemLifecycleTopic,
  TraceTopic,
  ConfigUpdateRequestTopic,
} from './system/index.ts'
import { OutboundAdminBroadcastTopic, ClientPresenceTopic, OutboundMessageTopic } from './types/events.ts'
import { loadConfig, saveConfig } from './config.ts'
import type { LogEvent, MetricsEvent, LifecycleEvent, TraceSpan } from './system/index.ts'
import type { ConfigUpdateRequest } from './system/index.ts'
import { ToolRegistrationTopic } from './types/tools.ts'
import type { ToolRegistrationEvent } from './types/tools.ts'
import { AgentSystem } from './system/index.ts'

if (!process.env.OPENROUTER_API_KEY) {
  console.error('Error: OPENROUTER_API_KEY environment variable is not set.')
  process.exit(1)
}

// ─── Load config and plugins from config.json ───

const { plugins, config, configPath } = await loadConfig()

// ─── Create the actor system (plugins loaded in topo-sorted order) ───

const system = await AgentSystem({ plugins, config })

// ─── Forward logs to the observability page via WebSocket broadcast ───

system.subscribe(LogTopic, (event: LogEvent) => {
  system.publish(OutboundAdminBroadcastTopic, {
    text: JSON.stringify({ type: 'log', ...event }),
  })
})

// ─── Forward metrics snapshots to the observability page ───

system.subscribe(MetricsTopic, (event: MetricsEvent) => {
  system.publish(OutboundAdminBroadcastTopic, {
    text: JSON.stringify({ type: 'metrics', ...event }),
  })
})

// ─── Forward tool registrations to the observability page ───
// Keep a local snapshot so new clients get the full list on connect.

const toolsSnapshot: Record<string, Extract<ToolRegistrationEvent, { schema: unknown }>> = {}

system.subscribe(ToolRegistrationTopic, (event: ToolRegistrationEvent) => {
  if (event.ref === null) {
    delete toolsSnapshot[event.name]
    system.publish(OutboundAdminBroadcastTopic, {
      text: JSON.stringify({ type: 'tool_unregistered', name: event.name }),
    })
  } else {
    toolsSnapshot[event.name] = event
    system.publish(OutboundAdminBroadcastTopic, {
      text: JSON.stringify({ type: 'tool_registered', name: event.name, schema: event.schema }),
    })
  }
})

// ─── Replay current tools to each newly connected client ───

system.subscribe(ClientPresenceTopic, (event) => {
  if (event.status !== 'connected') return
  const { clientId, userId, roles } = event
  if (userId !== 'anonymous' && !roles.includes('admin')) return
  for (const event of Object.values(toolsSnapshot)) {
    system.publish(OutboundMessageTopic, {
      clientId,
      text: JSON.stringify({ type: 'tool_registered', name: event.name, schema: event.schema }),
    })
  }
})

// ─── Forward trace spans to the observability page ───

system.subscribe(TraceTopic, (span: TraceSpan) => {
  system.publish(OutboundAdminBroadcastTopic, {
    text: JSON.stringify({ type: 'trace', ...span }),
  })
})

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
