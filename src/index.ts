import {
  createPluginSystem,
  LogTopic,
  MetricsTopic,
  SystemLifecycleTopic,
  TraceTopic,
} from './system/index.ts'
import { WsBroadcastTopic, WsConnectTopic, WsSendTopic, HttpConfigTopic, ConfigSnapshotTopic } from './types/ws.ts'
import type { HttpConfigPayload } from './types/ws.ts'
import { loadConfig, saveConfig } from './config.ts'
import type { LogEvent, MetricsEvent, LifecycleEvent, TraceSpan } from './system/index.ts'
import { ToolRegistrationTopic } from './types/tools.ts'
import type { ToolRegistrationEvent } from './types/tools.ts'

if (!process.env.OPENROUTER_API_KEY) {
  console.error('Error: OPENROUTER_API_KEY environment variable is not set.')
  process.exit(1)
}

// ─── Build a flat config snapshot suitable for the browser config form ───

const buildConfigSnapshot = (c: Record<string, unknown>): Record<string, unknown> => {
  const cog = (c.cognitive     as any) ?? {}
  const tls = (c.tools         as any) ?? {}
  const mem = (c.memory        as any) ?? {}
  const obs = (c.observability as any) ?? {}
  const nb  = (c.notebook      as any) ?? {}
  return {
    model:                         cog.chatbot?.model                     ?? '',
    systemPrompt:                  cog.chatbot?.systemPrompt               ?? '',
    historyWindow:                 cog.chatbot?.historyWindow              ?? 40,
    reasoningEnabled:              String(cog.llmProvider?.reasoning?.enabled ?? false),
    reasoningEffort:               cog.llmProvider?.reasoning?.effort      ?? 'medium',
    visionModel:                   tls.visionActor?.model                  ?? '',
    audioModel:                    tls.audioActor?.model                   ?? '',
    audioVoice:                    tls.audioActor?.voice                   ?? 'alloy',
    bashCwd:                       tls.bash?.cwd                           ?? '/workspace',
    webSearchCount:                tls.webSearch?.count                    ?? 20,
    kgraphDbPath:                  mem.kgraph?.dbPath                      ?? './workspace/memory/kgraph',
    kgraphEmbeddingModel:          mem.kgraph?.embeddingModel              ?? '',
    kgraphEmbeddingDimensions:     mem.kgraph?.embeddingDimensions         ?? 1536,
    memoryModel:                   mem.memory?.model                       ?? '',
    memoryConsolidationIntervalMs: mem.memory?.consolidationIntervalMs     ?? 30000,
    memoryReflectionIntervalMs:    mem.memory?.reflectionIntervalMs        ?? 604800000,
    logPath:                       obs.jsonlLogger?.filePath               ?? './logs/app.jsonl',
    minLevel:                      obs.jsonlLogger?.minLevel               ?? 'debug',
    flushIntervalMs:               obs.jsonlLogger?.flushIntervalMs        ?? 3000,
    metricsIntervalMs:             obs.metrics?.intervalMs                 ?? 5000,
    metricsEnabled:                obs.metrics !== undefined,
    notebookDir:                   nb.notebookDir                          ?? './workspace/notebook',
    notebookAgentModel:            nb.agentModel                           ?? '',
    notebookConsolidationIntervalMs: nb.consolidationIntervalMs            ?? 604800000,
    notebookMaxToolLoops:          nb.maxToolLoops                         ?? 10,
  }
}

// ─── Load config and plugins from config.json ───

const { plugins, config, configPath } = await loadConfig()

const PORT         = (config.interfaces as any)?.http?.port as number ?? 3000
const apiKey       = (config.cognitive as any)?.llmProvider?.apiKey as string
const SYSTEM_PROMPT = (config.cognitive as any)?.chatbot?.systemPrompt as string

// ─── Create the actor system (plugins loaded in topo-sorted order) ───

const system = await createPluginSystem({ plugins, config })

// Seed the HTTP actor with the initial config snapshot
system.publish(ConfigSnapshotTopic, { config: buildConfigSnapshot(config) })

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

system.subscribe(HttpConfigTopic, async (form: HttpConfigPayload) => {
  const chatbotPatch = {
    model:         String(form.model ?? 'openai/gpt-4o-mini'),
    systemPrompt:  form.systemPrompt ? String(form.systemPrompt) : SYSTEM_PROMPT,
    historyWindow: form.historyWindow ? Number(form.historyWindow) : undefined,
  }
  const toolsPatch = {
    visionActor: {
      model: String(form.visionModel ?? 'google/gemini-flash-1.5'),
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
      count: Number(form.webSearchCount ?? (config.tools as any)?.webSearch?.count ?? 20),
    },
  }
  const memoryPatch = {
    kgraph: {
      dbPath:               String(form.kgraphDbPath ?? (config.memory as any)?.kgraph?.dbPath ?? './workspace/memory/kgraph'),
      ...(form.kgraphEmbeddingModel ? {
        embeddingModel:      String(form.kgraphEmbeddingModel),
        embeddingDimensions: Number(form.kgraphEmbeddingDimensions ?? 1536),
      } : {}),
    },
    ...(form.memoryModel ? {
      memory: {
        model:                   String(form.memoryModel),
        consolidationIntervalMs: Number(form.memoryConsolidationIntervalMs ?? 30000),
        reflectionIntervalMs:    Number(form.memoryReflectionIntervalMs ?? 604800000),
      },
    } : {}),
  }
  const notebookPatch = {
    notebookDir:             String(form.notebookDir ?? (config.notebook as any)?.notebookDir ?? './workspace/notebook'),
    ...(form.notebookAgentModel ? { agentModel: String(form.notebookAgentModel) } : {}),
    consolidationIntervalMs: Number(form.notebookConsolidationIntervalMs ?? 604800000),
    maxToolLoops:            Number(form.notebookMaxToolLoops ?? 10),
  }
  const observabilityPatch = {
    jsonlLogger: {
      filePath:        String(form.logPath ?? (config.observability as any)?.jsonlLogger?.filePath ?? './logs/app.jsonl'),
      minLevel:        (form.minLevel as any) ?? 'debug',
      flushIntervalMs: Number(form.flushIntervalMs ?? 3000),
    },
    ...(form.metricsEnabled !== false && {
      metrics: {
        intervalMs: Number(form.metricsIntervalMs ?? 5000),
      },
    }),
  }

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
      chatbot: chatbotPatch,
    },
    tools: {
      ...toolsPatch,
      webSearch: { ...toolsPatch.webSearch, apiKey: process.env.BRAVESEARCH_API_KEY ?? '' },
    },
    memory:        memoryPatch,
    notebook:      notebookPatch,
    observability: observabilityPatch,
  })

  // Persist safe (non-secret) values back to config.json
  await saveConfig(configPath, {
    cognitive: {
      llmProvider: {
        reasoning: {
          enabled: form.reasoningEnabled === 'true',
          effort:  (form.reasoningEffort as string) ?? 'medium',
        },
      },
      chatbot: chatbotPatch,
    },
    tools:         toolsPatch,
    memory:        memoryPatch,
    notebook:      notebookPatch,
    observability: observabilityPatch,
  })

  // Update the config snapshot so GET /config reflects the new values
  system.publish(ConfigSnapshotTopic, {
    config: buildConfigSnapshot({
      cognitive: {
        llmProvider: { reasoning: { enabled: form.reasoningEnabled === 'true', effort: form.reasoningEffort } },
        chatbot: chatbotPatch,
      },
      tools:         toolsPatch,
      memory:        memoryPatch,
      notebook:      notebookPatch,
      observability: observabilityPatch,
    }),
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
