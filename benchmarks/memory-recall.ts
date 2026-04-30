import { createPluginSystem, LogTopic, MetricsTopic } from '../src/system/index.ts'
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
import { CostTopic, LlmProviderTopic } from '../src/types/llm.ts'
import type { CostEvent, LlmProviderMsg, LlmProviderReply, LlmProviderEvent } from '../src/types/llm.ts'
import type { LogEvent, ActorRef } from '../src/system/types.ts'
import { readFile } from 'node:fs/promises'
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

const RUNS: number = benchmarkConfig.runs ?? 1
const TURN_TIMEOUT_MS = 120_000
const USER_ID = 'anonymous'

// ─── Datasets ───

const datasetPath = join(process.cwd(), benchmarkConfig.dataset)
const datasetFile = await readFile(datasetPath, 'utf-8')
const dataset = JSON.parse(datasetFile)

const recallQuestions: Array<{ q: string; a: string[] }> = dataset.questions

console.log(`Loaded dataset for recall: ${dataset.name} (${recallQuestions.length} questions)`)

// ─── Helpers ───

function computeStats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length
  const median = sorted[Math.floor(sorted.length / 2)]
  const p95 = sorted[Math.floor(sorted.length * 0.95)]
  return { mean, median, p95, min: sorted[0], max: sorted[sorted.length - 1] }
}

// ─── Setup ───

const system = await createPluginSystem({
  config: benchmarkConfig.config,
  plugins: [interfacesPlugin, cognitivePlugin, memoryPlugin, observabilityPlugin],
})

let llmRef: ActorRef<LlmProviderMsg> | null = null
system.subscribe(LlmProviderTopic, (event) => {
  llmRef = (event as LlmProviderEvent).ref
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

// ─── recall_memory call tracking ───

const recallMemoryCalls = new Set<string>()
const toolCallsPerTrace = new Map<string, number>()
system.subscribe(TraceTopic, (span: TraceSpan) => {
  if (span.operation === 'tool-invoke' && span.data?.toolName === 'recall_memory') {
    recallMemoryCalls.add(span.traceId)
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
  // Forward to UI
  system.publish(OutboundBroadcastTopic, { text: JSON.stringify({ type: 'log', ...log }) })
})

// ─── Metrics subscription ───

system.subscribe(MetricsTopic, (event) => {
  // Forward to UI
  system.publish(OutboundBroadcastTopic, { text: JSON.stringify({ type: 'metrics', ...event }) })
})

// ─── Judge Implementation ───

async function collectJudgeReply(question: string, groundTruth: string[], reply: string): Promise<{ score: number; reason: string }> {
  if (!llmRef) return { score: 0, reason: 'LLM Provider not available' }

  return new Promise((resolve) => {
    let fullText = ''
    const requestId = newId()
    
    const replyTo: ActorRef<LlmProviderReply> = {
      name: `judge-collector-${requestId}`,
      send: (msg) => {
        if (msg.type === 'llmChunk') {
          fullText += msg.text
        } else if (msg.type === 'llmDone') {
          try {
            const jsonMatch = fullText.match(/\{[\s\S]*\}/)
            const data = JSON.parse(jsonMatch ? jsonMatch[0] : fullText)
            resolve({ score: data.score ?? 0, reason: data.reason ?? 'No reason provided' })
          } catch (e) {
            resolve({ score: 0, reason: `Failed to parse judge JSON: ${fullText}` })
          }
        } else if (msg.type === 'llmError') {
          resolve({ score: 0, reason: `Judge LLM error: ${String(msg.error)}` })
        }
      },
      isAlive: () => true
    }

    llmRef!.send({
      type: 'stream',
      requestId,
      model: benchmarkConfig.judge.model,
      messages: [
        { role: 'system', content: benchmarkConfig.judge.systemPrompt },
        { role: 'user', content: `QUESTION: ${question}\nGROUND TRUTH: ${groundTruth.join(', ')}\nASSISTANT REPLY: ${reply}` }
      ],
      role: 'judge',
      replyTo
    })

    setTimeout(() => resolve({ score: 0, reason: 'Judge timed out' }), 30_000)
  })
}

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

console.log('\n🚀 Starting Recall Phase (No Context)\n')

type RecallResult = { q: string; expected: string[]; reply: string; latency: number; isCorrect: boolean; judgeScore: number; judgeReason: string; toolCalls: number; recallMemory: boolean }
const allRunResults: RecallResult[][] = []

for (let run = 0; run < RUNS; run++) {
  if (RUNS > 1) console.log(`Run ${run + 1}/${RUNS}`)

  const RECALL_CLIENT_ID = `benchmark-recall-${run}`
  system.publish(ClientConnectTopic, { clientId: RECALL_CLIENT_ID, userId: USER_ID, roles: ['user'] })

  // Wait for the chatbot actor to fully initialize and register its tools
  await new Promise(resolve => setTimeout(resolve, 500))

  const runResults: RecallResult[] = []
  for (const { q, a } of recallQuestions) {
    const traceId = newId()
    console.log(`Question: ${q}`)
    process.stdout.write('Assistant: ')
    const result    = await sendTurn(q, RECALL_CLIENT_ID, traceId)
    const isCorrect = a.every(kw => result.reply.toLowerCase().includes(kw.toLowerCase()))
    
    process.stdout.write('Judge: ')
    const judge = await collectJudgeReply(q, a, result.reply)
    console.log(`${judge.score} (${judge.reason})`)

    const toolCalls    = toolCallsPerTrace.get(traceId) ?? 0
    const recallMemory = recallMemoryCalls.has(traceId)
    runResults.push({ q, expected: a, reply: result.reply, latency: result.latency, isCorrect, judgeScore: judge.score, judgeReason: judge.reason, toolCalls, recallMemory })
    console.log(`(Latency: ${result.latency}ms, Keyword: ${isCorrect}, Judge: ${judge.score}, tools: ${toolCalls}, recall_memory: ${recallMemory})\n`)
  }

  system.publish(ClientDisconnectTopic, { clientId: RECALL_CLIENT_ID })
  allRunResults.push(runResults)
}

// ─── Reporting ───

const allRecallResults = allRunResults.flat()
const recallStats    = computeStats(allRecallResults.map(r => r.latency))
const keywordCorrect = allRecallResults.filter(r => r.isCorrect).length
const totalJudgeScore = allRecallResults.reduce((s, r) => s + r.judgeScore, 0)
const accuracy       = (keywordCorrect / allRecallResults.length) * 100
const judgeAccuracy  = (totalJudgeScore / allRecallResults.length) * 100
const recallMemoryCount = allRecallResults.filter(r => r.recallMemory).length
const totalCost      = Object.values(costByRole).reduce((s, r) => s + r.cost, 0)

console.log('--- Recall Report ---\n')
console.log(`Latency:      avg=${recallStats.mean.toFixed(0)}ms  median=${recallStats.median}ms  p95=${recallStats.p95}ms`)
console.log(`Keyword Accuracy:    ${accuracy.toFixed(1)}% (${keywordCorrect}/${allRecallResults.length})`)
console.log(`Judge Accuracy:      ${judgeAccuracy.toFixed(1)}% (${totalJudgeScore.toFixed(1)}/${allRecallResults.length})`)
console.log(`recall_memory calls: ${recallMemoryCount}/${allRecallResults.length}`)
console.log(`Total Cost:          $${totalCost.toFixed(4)}`)
console.log('')

console.log('✅ Recall phase complete. HTTP server remains active for inspection.')
console.log('🔗 URL: http://localhost:3001')
console.log('Press Ctrl+C to terminate.')

// We do NOT call process.exit(0) to keep the system and HTTP server alive.
// The event loop will stay active due to the HTTP server and actor system.
