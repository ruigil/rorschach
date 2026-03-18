// ─── Parallel Plugin Example ──────────────────────────────────────────────────
//
// Demonstrates the two parallel primitives:
//
//   Pool Router   — distributes messages across a fixed pool of worker actors
//                   using round-robin; workers can be any actor, including
//                   worker bridges backed by real Bun Worker threads.
//
//   Worker Bridge — offloads work to a real Bun Worker thread; the bridge actor
//                   forwards requests and publishes progress/done/failed events
//                   on a per-task topic so any actor can observe completion.
//
// Both can be used directly (as shown below) or wired up via the parallel
// plugin, which manages their lifecycle through the config system.

import { createPluginSystem, LogTopic, taskTopic } from '../system/index.ts'
import { createPoolRouter } from '../plugins/parallel/pool-router.ts'
import { createWorkerBridge } from '../plugins/parallel/worker-bridge.ts'
import type { ActorDef, LogEvent, TaskEvent, WorkerBridgeMsg, WorkerBridgeState } from '../system/index.ts'

// ─── System setup ─────────────────────────────────────────────────────────────

const system = await createPluginSystem()

system.subscribe('console-logger', LogTopic, (e) => {
  const { level, source, message } = e as LogEvent
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] ${level.padEnd(5)} [${source}] ${message}`)
})

// ═══════════════════════════════════════════════════════════════════════════════
// Part 1: Pool Router of Worker Bridges
//
// Fan out 12 jobs across a pool of 4 worker bridge actors via round-robin.
// Each bridge runs a real Bun Worker thread. Results arrive via taskTopic(id)
// rather than a replyTo ref, so we subscribe per-job before sending.
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── Part 1: Pool Router of Worker Bridges ──')

type ParsePayload = { input: string }
type ParseResult  = string

// Worker bridge: each pool slot runs parse-worker.ts in its own thread
const parseBridge = createWorkerBridge<ParsePayload, ParseResult>({
  scriptPath: new URL('./workers/parse-worker.ts', import.meta.url).href,
})

const pool = createPoolRouter<WorkerBridgeMsg<ParsePayload, ParseResult>, WorkerBridgeState>({
  poolSize: 4,
  worker: parseBridge.def,
  workerInitialState: parseBridge.initialState,
})
const poolRef = system.spawn('pool', pool.def, pool.initialState)

await Bun.sleep(100) // let actors and worker threads start

const inputs = ['apple', 'banana', 'cherry', 'date', 'elderberry', 'fig',
                'grape', 'honeydew', 'kiwi', 'lemon', 'mango', 'nectarine']

// Subscribe to each task's result topic before sending
const results: Array<{ input: string; output: string }> = []
let received = 0

for (let i = 0; i < inputs.length; i++) {
  const id = `parse-${i}`
  system.subscribe(`task-sub-${id}`, taskTopic<ParseResult>(id), (event) => {
    if (event.type === 'task.done') {
      results.push({ input: inputs[i]!, output: event.result })
      received++
    }
  })
}

console.log(`Sending ${inputs.length} jobs to a pool of 4 worker bridges...\n`)
for (let i = 0; i < inputs.length; i++) {
  poolRef.send({ type: 'request', id: `parse-${i}`, payload: { input: inputs[i]! } })
}

while (received < inputs.length) await Bun.sleep(50)

console.log(`Collected ${results.length} results:`)
for (const r of results) {
  console.log(`  ${r.input.padEnd(12)}  →  ${r.output}`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Part 2: Worker Bridge
//
// Offload a multi-step computation to a real Bun Worker thread.
// Subscribe to the per-task topic before sending the request to receive all
// progress and completion events as they arrive.
//
// The bridge actor handles routing; the caller observes via the event system.
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── Part 2: Worker Bridge ──')
console.log('Submitting a task to a worker thread...\n')

type ComputePayload = { steps: number; multiplier: number }
type ComputeResult  = number

const bridge = createWorkerBridge<ComputePayload, ComputeResult>({
  scriptPath: new URL('./workers/compute-worker.ts', import.meta.url).href,
})
const bridgeRef = system.spawn('compute-bridge', bridge.def, bridge.initialState)

await Bun.sleep(50) // let the worker thread start

// Observer actor: subscribe to the task topic and print events as they arrive
const taskId = 'compute-1'
let taskDone = false

type ObserverMsg = { type: 'task-event'; event: TaskEvent<ComputeResult> }
const observerDef: ActorDef<ObserverMsg, null> = {
  lifecycle: (state, event, ctx) => {
    if (event.type === 'start') {
      ctx.subscribe(taskTopic<ComputeResult>(taskId), e => ({ type: 'task-event' as const, event: e }))
    }
    return { state }
  },
  handler: (state, msg) => {
    const ev = msg.event
    if (ev.type === 'task.progress') {
      console.log(`  [${ev.pct.toString().padStart(3)}%]  ${ev.note ?? ''}`)
    } else if (ev.type === 'task.done') {
      console.log(`\n  Done!  result = ${ev.result}`)
      taskDone = true
    } else if (ev.type === 'task.failed') {
      console.log(`\n  Failed: ${ev.error}`)
      taskDone = true
    }
    return { state }
  },
}

system.spawn('task-observer', observerDef, null)
await Bun.sleep(50) // let observer subscribe before sending

// Send the request — the worker thread will compute and report back
bridgeRef.send({ type: 'request', id: taskId, payload: { steps: 4, multiplier: 10 } })

// Wait for the task to complete (up to 2s)
for (let i = 0; i < 20 && !taskDone; i++) await Bun.sleep(100)

// ─── Shutdown ─────────────────────────────────────────────────────────────────

console.log('\n── Shutting down ──')
await system.shutdown()
