import { join } from 'node:path'
import {
  createPluginSystem,
  createConfigPlugin,
  ConfigCommandTopic,
  LogTopic,
  MetricsTopic,
  SystemLifecycleTopic,
} from './system/index.ts'
import interfacesPlugin from './plugins/interfaces/interfaces.plugin.ts'
import cognitivePlugin from './plugins/cognitive/cognitive.plugin.ts'
import observabilityPlugin from './plugins/observability/observability.plugin.ts'
import { WsBroadcastTopic, HttpConfigTopic } from './plugins/interfaces/http.ts'
import type { LogEvent, MetricsEvent, LifecycleEvent, SystemConfig } from './system/index.ts'
import type { HttpConfigPayload } from './plugins/interfaces/http.ts'

const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) {
  console.error('Error: OPENROUTER_API_KEY environment variable is not set.')
  process.exit(1)
}

const PORT          = Number(process.env.PORT ?? 3000)
const LOG_FILE      = join(import.meta.dir, '../logs/app.jsonl')
const SYSTEM_PROMPT = "You're name is Rorschach. The entity of the book Blindsight by Peter Watts. Act like him. Do not break role, ever."

// ─── Create the actor system ───

const system = await createPluginSystem({
  plugins: [
    createConfigPlugin({
      interfaces: { http: { port: PORT } },
      cognitive: {
        chatbot: {
          apiKey,
          model: process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini',
          systemPrompt: SYSTEM_PROMPT,
        },
      },
      observability: {
        jsonlLogger: {
          filePath: LOG_FILE,
          minLevel: 'debug',
          flushIntervalMs: 3000,
        },
        metrics: {
          intervalMs: 5000,
        },
      },
    }),
    interfacesPlugin,
    cognitivePlugin,
    observabilityPlugin,
  ],
})

// ─── Forward logs to the observability page via WebSocket broadcast ───

system.subscribe('ws-log-broadcaster', LogTopic, (event: LogEvent) => {
  system.publish(WsBroadcastTopic, {
    text: JSON.stringify({ type: 'log', ...event }),
  })
})

// ─── Forward metrics snapshots to the observability page ───

system.subscribe('ws-metrics-broadcaster', MetricsTopic, (event: MetricsEvent) => {
  system.publish(WsBroadcastTopic, {
    text: JSON.stringify({ type: 'metrics', ...event }),
  })
})

// ─── Apply config page changes to the running system ───

system.subscribe('config-api', HttpConfigTopic, (form: HttpConfigPayload) => {
  const next: SystemConfig = {
    interfaces: { http: { port: PORT } },
    cognitive: {
      chatbot: {
        apiKey,
        model: String(form.model ?? process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini'),
        systemPrompt: SYSTEM_PROMPT,
      },
    },
    observability: {
      jsonlLogger: {
        filePath: String(form.logPath ?? LOG_FILE),
        minLevel: (form.minLevel as any) ?? 'debug',
        flushIntervalMs: Number(form.flushIntervalMs ?? 3000),
      },
      ...(form.metricsEnabled !== false && {
        metrics: {
          intervalMs: Number(form.metricsIntervalMs ?? 5000),
        },
      }),
    },
  }
  system.publish(ConfigCommandTopic, { type: 'replace', config: next })
})

// ─── Log actor lifecycle events to console ───

system.subscribe('lifecycle-observer', SystemLifecycleTopic, (event) => {
  const e = event as LifecycleEvent
  if (e.type === 'terminated') {
    console.log(`[system] actor ${e.ref.name} terminated (${e.reason})`)
  }
})

console.log(`\n🚀 Rorschach running`)
console.log(`   chat     → http://localhost:${PORT}`)

// ─── Graceful shutdown on Ctrl+C ───

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down…')
  await system.shutdown()
  process.exit(0)
})
