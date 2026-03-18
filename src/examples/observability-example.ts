import { join } from 'node:path'
import {
  createPluginSystem,
  createConfigPlugin,
  LogTopic,
  MetricsTopic,
  onLifecycle,
  onMessage,
} from '../system/index.ts'
import observabilityPlugin from '../plugins/observability/observability.plugin.ts'
import type { LogEvent, MetricsEvent, ActorDef } from '../system/types.ts'

const LOG_FILE = join(import.meta.dir, '../../logs/observability.jsonl')

// ─── A simple worker actor that processes jobs and logs progress ───

type WorkerMsg =
  | { type: 'process'; id: number }
  | { type: 'tick' }

type WorkerState = { processed: number; failed: number }

const workerDef: ActorDef<WorkerMsg, WorkerState> = {
  lifecycle: onLifecycle({
    start: (state, ctx) => {
      ctx.timers.startPeriodicTimer('tick', { type: 'tick' }, 1500)
      ctx.log.info('worker started')
      return { state }
    },
  }),

  handler: onMessage({
    process: (state, msg, ctx) => {
      // Simulate occasional failures
      if (msg.id % 7 === 0) {
        ctx.log.warn(`job ${msg.id} skipped — id is a multiple of 7`)
        return { state: { ...state, failed: state.failed + 1 } }
      }

      ctx.log.debug(`job ${msg.id} processed`)
      return { state: { ...state, processed: state.processed + 1 } }
    },

    tick: (state, _msg, ctx) => {
      ctx.log.info(`worker heartbeat — processed: ${state.processed}, skipped: ${state.failed}`)
      return { state }
    },
  }),
}

// ─── Bootstrap ───

const system = await createPluginSystem({
  plugins: [
    createConfigPlugin({
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
    observabilityPlugin,
  ],
})

// ─── Spawn a worker actor ───

const worker = system.spawn('worker', workerDef, { processed: 0, failed: 0 })

// ─── Forward logs to console ───

system.subscribe('console-logger', LogTopic, (event: LogEvent) => {
  const ts = new Date(event.timestamp).toISOString().slice(11, 23)
  const level = event.level.toUpperCase().padEnd(5)
  const data = event.data !== undefined ? ` ${JSON.stringify(event.data)}` : ''
  console.log(`[${ts}] ${level} [${event.source}] ${event.message}${data}`)
})

// ─── Print a metrics summary on each tick ───

system.subscribe('metrics-printer', MetricsTopic, (event: MetricsEvent) => {
  const ts = new Date(event.timestamp).toISOString().slice(11, 23)
  console.log(`\n[${ts}] --- metrics snapshot (${event.actors.length} actors) ---`)

  for (const actor of event.actors) {
    const avg = actor.processingTime.avg.toFixed(2)
    console.log(
      `  ${actor.name.padEnd(40)} ` +
      `status=${actor.status.padEnd(8)} ` +
      `recv=${String(actor.messagesReceived).padStart(4)} ` +
      `done=${String(actor.messagesProcessed).padStart(4)} ` +
      `fail=${String(actor.messagesFailed).padStart(3)} ` +
      `mailbox=${String(actor.mailboxSize).padStart(3)} ` +
      `avg=${avg}ms`
    )
  }

  console.log()
})

// ─── Drive the worker with jobs every 800 ms ───

let jobId = 1
const jobTimer = setInterval(() => {
  worker.send({ type: 'process', id: jobId++ })
}, 800)

console.log(`Rorschach observability example`)
console.log(`  logs  → ${LOG_FILE}`)
console.log(`  metrics every 5s | jobs every 800ms | heartbeat every 1.5s`)
console.log(`  Press Ctrl+C to stop\n`)

// ─── Graceful shutdown ───

process.on('SIGINT', async () => {
  console.log('\nShutting down...')
  clearInterval(jobTimer)
  await system.shutdown()
  console.log(`Logs written to ${LOG_FILE}`)
  process.exit(0)
})
