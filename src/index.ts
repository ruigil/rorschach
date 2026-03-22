import { join } from 'node:path'
import {
  createPluginSystem,
  LogTopic,
  MetricsTopic,
  SystemLifecycleTopic,
  TraceTopic,
} from './system/index.ts'
import interfacesPlugin from './plugins/interfaces/interfaces.plugin.ts'
import cognitivePlugin from './plugins/cognitive/cognitive.plugin.ts'
import toolsPlugin from './plugins/tools/tools.plugin.ts'
import observabilityPlugin from './plugins/observability/observability.plugin.ts'
import { WsBroadcastTopic, HttpConfigTopic } from './plugins/interfaces/http.ts'
import type { LogEvent, MetricsEvent, LifecycleEvent, TraceSpan } from './system/index.ts'
import type { HttpConfigPayload } from './plugins/interfaces/http.ts'

const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) {
  console.error('Error: OPENROUTER_API_KEY environment variable is not set.')
  process.exit(1)
}

const PORT          = Number(process.env.PORT ?? 3000)
const LOG_FILE      = join(import.meta.dir, '../logs/app.jsonl')
const SYSTEM_PROMPT = "You're the user perfect mirror. You always reflect what you perceive. If the user is curious, you are curious. If the user is sad, you're sad. If the user is concise, you're concise. You're a perfect mirror of he user."

// ─── Create the actor system ───

const system = await createPluginSystem({
  config: {
    interfaces: { http: { port: PORT } },
    tools: {
      webSearch: {
        apiKey: process.env.BRAVESEARCH_API_KEY ?? '',
      },
    },
    cognitive: {
      llmProvider: {
        apiKey,
        model: process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini',
      },
      chatbot: {
        systemPrompt: SYSTEM_PROMPT,
      },
      visionActor: {
        model: process.env.OPENROUTER_VISION_MODEL ?? 'openai/gpt-5.4-nano',
      },
    },
    observability: {
      jsonlLogger: {
        filePath: LOG_FILE,
        minLevel: 'debug',
        flushIntervalMs: 30000,
      },
      metrics: {
        intervalMs: 5000,
      },
    },
  },
  plugins: [
    interfacesPlugin,
    toolsPlugin,
    cognitivePlugin,
    observabilityPlugin,
  ],
})

// ─── Forward logs to the observability page via WebSocket broadcast ───

system.subscribe(LogTopic, (event: LogEvent) => {
  system.publish(WsBroadcastTopic, {
    text: JSON.stringify({ type: 'log', ...event }),
  })
})

// ─── Forward metrics snapshots to the observability page ───

system.subscribe(MetricsTopic, (event: MetricsEvent) => {
  system.publish(WsBroadcastTopic, {
    text: JSON.stringify({ type: 'metrics', ...event }),
  })
})

// ─── Forward trace spans to the observability page ───

system.subscribe(TraceTopic, (span: TraceSpan) => {
  system.publish(WsBroadcastTopic, {
    text: JSON.stringify({ type: 'trace', ...span }),
  })
})

// ─── Apply config page changes to the running system ───

system.subscribe(HttpConfigTopic, (form: HttpConfigPayload) => {
  system.updateConfig({
    interfaces: { http: { port: PORT } },
    cognitive: {
      llmProvider: {
        apiKey,
        model: String(form.model ?? process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini'),
        reasoning: {
          enabled: form.reasoningEnabled === 'true',
          effort: (form.reasoningEffort as 'high' | 'medium' | 'low' | 'minimal') ?? 'medium',
        },
      },
      chatbot: {
        systemPrompt: SYSTEM_PROMPT,
      },
      visionActor: {
        model: String(form.visionModel ?? process.env.OPENROUTER_VISION_MODEL ?? 'google/gemini-flash-1.5'),
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
  })
})

// ─── Log actor lifecycle events to console ───

system.subscribe(SystemLifecycleTopic, (event) => {
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
