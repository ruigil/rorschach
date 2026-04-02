import {
  createPluginSystem,
  LogTopic,
  MetricsTopic,
  SystemLifecycleTopic,
  TraceTopic,
} from './system/index.ts'
import { WsBroadcastTopic, WsConnectTopic, WsSendTopic, HttpConfigTopic } from './types/ws.ts'
import type { HttpConfigPayload } from './types/ws.ts'
import { loadConfig } from './config.ts'
import type { LogEvent, MetricsEvent, LifecycleEvent, TraceSpan } from './system/index.ts'
import { ToolRegistrationTopic } from './types/tools.ts'
import type { ToolRegistrationEvent } from './types/tools.ts'

if (!process.env.OPENROUTER_API_KEY) {
  console.error('Error: OPENROUTER_API_KEY environment variable is not set.')
  process.exit(1)
}

// ─── Load config and plugins from config.json ───

const { plugins, config } = await loadConfig()

const PORT         = (config.interfaces as any)?.http?.port as number ?? 3000
const apiKey       = (config.cognitive as any)?.llmProvider?.apiKey as string
const SYSTEM_PROMPT = (config.cognitive as any)?.chatbot?.systemPrompt as string

// ─── Create the actor system (plugins loaded in topo-sorted order) ───

const system = await createPluginSystem({ plugins, config })

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

// ─── Forward tool registrations to the observability page ───
// Keep a local snapshot so new clients get the full list on connect.

const toolsSnapshot: Record<string, Extract<ToolRegistrationEvent, { schema: unknown }>> = {}

system.subscribe(ToolRegistrationTopic, (event: ToolRegistrationEvent) => {
  if (event.ref === null) {
    delete toolsSnapshot[event.name]
    system.publish(WsBroadcastTopic, {
      text: JSON.stringify({ type: 'tool_unregistered', name: event.name }),
    })
  } else {
    toolsSnapshot[event.name] = event
    system.publish(WsBroadcastTopic, {
      text: JSON.stringify({ type: 'tool_registered', name: event.name, schema: event.schema }),
    })
  }
})

// ─── Replay current tools to each newly connected client ───

system.subscribe(WsConnectTopic, ({ clientId }) => {
  for (const event of Object.values(toolsSnapshot)) {
    system.publish(WsSendTopic, {
      clientId,
      text: JSON.stringify({ type: 'tool_registered', name: event.name, schema: event.schema }),
    })
  }
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
        reasoning: {
          enabled: form.reasoningEnabled === 'true',
          effort: (form.reasoningEffort as 'high' | 'medium' | 'low' | 'minimal') ?? 'medium',
        },
      },
      chatbot: {
        model:         String(form.model ?? process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini'),
        systemPrompt:  form.systemPrompt ? String(form.systemPrompt) : SYSTEM_PROMPT,
        historyWindow: form.historyWindow ? Number(form.historyWindow) : undefined,
      },
    },
    tools: {
      visionActor: {
        model: String(form.visionModel ?? process.env.OPENROUTER_VISION_MODEL ?? 'google/gemini-flash-1.5'),
      },
      ...(form.audioModel ? {
        audioActor: {
          model: String(form.audioModel),
          voice: String(form.audioVoice ?? 'alloy'),
        },
      } : {}),
      bash: {
        cwd: String(form.bashCwd ?? (config.tools as any)?.bash?.cwd ?? process.cwd()),
      },
      webSearch: {
        apiKey: process.env.BRAVESEARCH_API_KEY ?? '',
        count:  Number(form.webSearchCount ?? (config.tools as any)?.webSearch?.count ?? 20),
      },
    },
    memory: {
      kgraph: {
        dbPath: String(form.kgraphDbPath ?? (config.memory as any)?.kgraph?.dbPath ?? './workspace/memory/kgraph'),
      },
      ...(form.memoryModel ? {
        memory: {
          model:                   String(form.memoryModel),
          userId:                  String(form.memoryUserId ?? 'default'),
          consolidationIntervalMs: Number(form.memoryConsolidationIntervalMs ?? 30000),
        },
      } : {}),
    },
    observability: {
      jsonlLogger: {
        filePath:       String(form.logPath ?? (config.observability as any)?.jsonlLogger?.filePath ?? './logs/app.jsonl'),
        minLevel:       (form.minLevel as any) ?? 'debug',
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
