import { createPluginSystem, LogTopic } from '../src/system/index.ts'
import interfacesPlugin from '../src/plugins/interfaces/interfaces.plugin.ts'
import cognitivePlugin from '../src/plugins/cognitive/cognitive.plugin.ts'
import memoryPlugin from '../src/plugins/memory/memory.plugin.ts'
import observabilityPlugin from '../src/plugins/observability/observability.plugin.ts'
import {
  ClientConnectTopic, ClientDisconnectTopic,
  InboundMessageTopic, OutboundMessageTopic, OutboundBroadcastTopic,
} from '../src/types/events.ts'
import type { OutboundMessageEvent } from '../src/types/events.ts'
import { TraceTopic, newId } from '../src/types/trace.ts'
import type { TraceSpan } from '../src/types/trace.ts'
import { CostTopic } from '../src/types/llm.ts'
import type { CostEvent } from '../src/types/llm.ts'
import type { LogEvent } from '../src/system/types.ts'
import { mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'

// ─── Configuration ───

const configPath = join(import.meta.dir, 'config-benchmark.json')
const configFile = await readFile(configPath, 'utf-8')
const benchmarkConfig = JSON.parse(configFile)

const apiKey = process.env.OPENROUTER_API_KEY || benchmarkConfig.config.cognitive.llmProvider.apiKey
if (!apiKey || apiKey.includes('${')) {
  console.error('Error: OPENROUTER_API_KEY environment variable is not set.')
  process.exit(1)
}

benchmarkConfig.config.cognitive.llmProvider.apiKey = apiKey

const DB_DIR = join(process.cwd(), benchmarkConfig.config.memory.dbPath)
const CONSOLIDATION_TIMEOUT: number = benchmarkConfig.config.memory.system.consolidationIntervalMs * 2
const TURN_TIMEOUT_MS = 120_000
const USER_ID = 'anonymous'

// ─── Datasets ───

const datasetPath = join(process.cwd(), benchmarkConfig.dataset)
const datasetFile = await readFile(datasetPath, 'utf-8')
const dataset = JSON.parse(datasetFile)

const factualStatements: string[] = dataset.statements

console.log(`Loaded dataset for injection: ${dataset.name} (${factualStatements.length} statements)`)

// ─── Helpers ───

async function setupDir() {
  console.log(`Cleaning database directory: ${DB_DIR}`)
  await rm(DB_DIR, { recursive: true, force: true })
  await mkdir(DB_DIR, { recursive: true })
}

function computeStats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length
  const median = sorted[Math.floor(sorted.length / 2)]
  const p95 = sorted[Math.floor(sorted.length * 0.95)]
  return { mean, median, p95, min: sorted[0], max: sorted[sorted.length - 1] }
}

// ─── Setup ───

await setupDir()

const system = await createPluginSystem({
  config: benchmarkConfig.config,
  plugins: [interfacesPlugin, cognitivePlugin, memoryPlugin, observabilityPlugin],
})

// ─── Cost tracking ───

const costByRole: Record<string, { inputTokens: number; outputTokens: number; cost: number }> = {}
system.subscribe(CostTopic, (event) => {
  const e = event as CostEvent
  const r = costByRole[e.role] ??= { inputTokens: 0, outputTokens: 0, cost: 0 }
  r.inputTokens += e.inputTokens
  r.outputTokens += e.outputTokens
  r.cost += e.cost ?? 0
})

// ─── store_memory call tracking ───

const storeMemoryCalls  = new Set<string>()
const toolCallsPerTrace = new Map<string, number>()
system.subscribe(TraceTopic, (span: TraceSpan) => {
  if (span.operation === 'tool-invoke' && span.data?.toolName === 'store_memory') {
    storeMemoryCalls.add(span.traceId)
  }
  if (span.operation === 'tool-invoke' && span.status === 'started') {
    toolCallsPerTrace.set(span.traceId, (toolCallsPerTrace.get(span.traceId) ?? 0) + 1)
  }
  system.publish(OutboundBroadcastTopic, { text: JSON.stringify({ type: 'trace', ...span }) })
})

// ─── Log subscription ───

system.subscribe(LogTopic, (event) => {
  const log = event as LogEvent
  if (log.level === 'error' || log.level === 'warn') {
    console.log(`[${log.level.toUpperCase()}] [${log.source}] ${log.message}`)
  }
})

// ─── sendTurn ───

const sendTurn = async (text: string, clientId: string, traceId: string): Promise<{ reply: string; latency: number }> => {
  const start = Date.now()
  const spanId = newId()
  let reply = ''

  return new Promise((res) => {
    let resolved = false
    let msgUnsub: (() => void) | undefined
    const done = (result: { reply: string; latency: number }) => {
      if (resolved) return
      resolved = true
      clearTimeout(timeout)
      if (msgUnsub) msgUnsub()
      res(result)
    }

    const timeout = setTimeout(
      () => done({ reply: 'TIMEOUT', latency: TURN_TIMEOUT_MS }),
      TURN_TIMEOUT_MS,
    )

    msgUnsub = system.subscribe(OutboundMessageTopic, (event) => {
      const e = event as OutboundMessageEvent
      if (e.clientId !== clientId) return
      try {
        const data = JSON.parse(e.text)
        if (data.type === 'chunk') {
          reply += data.text
          process.stdout.write(data.text)
        } else if (data.type === 'done') {
          process.stdout.write('\n')
          done({ reply, latency: Date.now() - start })
        } else if (data.type === 'error') {
          console.error(`\n  Error: ${data.text}`)
          done({ reply: `ERROR: ${data.text}`, latency: Date.now() - start })
        }
      } catch { }
    })

    system.publish(InboundMessageTopic, { clientId, text, traceId, parentSpanId: spanId })
  })
}

// ─── waitForConsolidation ───

const waitForConsolidation = () => new Promise<void>(resolve => {
  let done = false
  let unsub: (() => void) | undefined
  const finish = () => {
    if (done) return
    done = true
    clearTimeout(timer)
    if (unsub) unsub()
    resolve()
  }
  const timer = setTimeout(finish, CONSOLIDATION_TIMEOUT)
  unsub = system.subscribe(TraceTopic, (span: TraceSpan) => {
    if (span.operation === 'memory-consolidation' && (span.status === 'done' || span.status === 'error')) finish()
  })
})

console.log('\n🚀 Starting Injection Phase\n')

const INJECT_CLIENT_ID = 'benchmark-inject'
system.publish(ClientConnectTopic, { clientId: INJECT_CLIENT_ID, userId: USER_ID, roles: ['user'] })

const injectionResults: Array<{ latency: number; storedMemory: boolean; toolCalls: number }> = []

for (const statement of factualStatements) {
  const traceId = newId()
  console.log(`User: ${statement}`)
  process.stdout.write('Assistant: ')
  const result     = await sendTurn(statement, INJECT_CLIENT_ID, traceId)
  const storedMemory = storeMemoryCalls.has(traceId)
  const toolCalls    = toolCallsPerTrace.get(traceId) ?? 0
  injectionResults.push({ latency: result.latency, storedMemory, toolCalls })
  console.log(`(Latency: ${result.latency}ms, store_memory: ${storedMemory}, tools: ${toolCalls})\n`)
}

const storeMemoryCount = injectionResults.filter(r => r.storedMemory).length
console.log(`store_memory called: ${storeMemoryCount}/${injectionResults.length} turns\n`)

console.log('--- Waiting for Memory Consolidation ---\n')
await waitForConsolidation()
console.log('Consolidation complete.\n')

// ─── Reporting ───

const injStats = computeStats(injectionResults.map(r => r.latency))
const totalCost = Object.values(costByRole).reduce((s, r) => s + r.cost, 0)

console.log('--- Injection Report ---\n')
console.log(`Latency:   avg=${injStats.mean.toFixed(0)}ms  median=${injStats.median}ms  p95=${injStats.p95}ms`)
console.log(`store_memory calls:  ${storeMemoryCount}/${injectionResults.length}`)
console.log(`Total Cost:          $${totalCost.toFixed(4)}`)
console.log('\nInjection phase complete. Database is ready for recall.\n')

console.log('✅ Injection phase complete. HTTP server remains active for inspection.')
console.log('🔗 URL: http://localhost:3001')
console.log('Press Ctrl+C to terminate.')

// We do NOT call process.exit(0) to keep the system and HTTP server alive.
