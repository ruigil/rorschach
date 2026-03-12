import {
  createActorSystem,
  type ActorDef,
  type ActorRef,
} from './src/system/index.ts'

// ═══════════════════════════════════════════════════════════════════
// Worker Actor — processes jobs
// ═══════════════════════════════════════════════════════════════════

type WorkerMsg =
  | { type: 'job'; payload: string }
  | { type: 'status' }

type WorkerState = {
  completed: number
}

const workerDef: ActorDef<WorkerMsg, WorkerState> = {
  setup: (state, context) => {
    console.log(`  [${context.self.name}] setup complete`)
    return state
  },

  handler: async (state, message, context) => {
    switch (message.type) {
      case 'job': {
        // Simulate async work
        await Bun.sleep(50)
        const completed = state.completed + 1
        console.log(`  [${context.self.name}] completed job "${message.payload}" (total: ${completed})`)
        return { state: { ...state, completed } }
      }
      case 'status': {
        console.log(`  [${context.self.name}] status: ${state.completed} jobs completed`)
        return { state }
      }
    }
  },

  lifecycle: (state, event, context) => {
    switch (event.type) {
      case 'stopped':
        console.log(`  [${context.self.name}] stopped (completed ${state.completed} jobs)`)
        return { state }
      default:
        return { state }
    }
  },
}

// ═══════════════════════════════════════════════════════════════════
// Supervisor Actor — spawns workers and dispatches jobs round-robin
// ═══════════════════════════════════════════════════════════════════

type SupervisorMsg =
  | { type: 'dispatch'; payload: string }
  | { type: 'status' }
  | { type: 'stop-worker'; name: string }

type SupervisorState = {
  workers: ActorRef<WorkerMsg>[]
  roundRobin: number
}

const supervisorDef: ActorDef<SupervisorMsg, SupervisorState> = {
  setup: (state, context) => {
    console.log(`[${context.self.name}] spawning 3 workers...`)

    const workers = [
      context.spawn('worker-1', workerDef, { completed: 0 }),
      context.spawn('worker-2', workerDef, { completed: 0 }),
      context.spawn('worker-3', workerDef, { completed: 0 }),
    ]

    return { ...state, workers }
  },

  handler: (state, message, context) => {
    switch (message.type) {
      case 'dispatch': {
        if (state.workers.length === 0) {
          console.log(`[${context.self.name}] no workers available!`)
          return { state }
        }
        const idx = state.roundRobin % state.workers.length
        const worker = state.workers[idx]!
        worker.send({ type: 'job', payload: message.payload })
        return { state: { ...state, roundRobin: state.roundRobin + 1 } }
      }

      case 'status': {
        console.log(`[${context.self.name}] ${state.workers.length} workers, round-robin at ${state.roundRobin}`)
        state.workers.forEach((w) => w.send({ type: 'status' }))
        return { state }
      }

      case 'stop-worker': {
        const worker = state.workers.find((w) => w.name.endsWith(message.name))
        if (worker) {
          console.log(`[${context.self.name}] stopping ${worker.name}...`)
          context.stop(worker)
        }
        return { state }
      }
    }
  },

  lifecycle: (state, event, context) => {
    switch (event.type) {
      case 'child-started':
        console.log(`[${context.self.name}] ✓ child started: ${event.child.name}`)
        return { state }

      case 'child-stopped': {
        console.log(`[${context.self.name}] ✗ child stopped: ${event.child.name} — restarting...`)

        // Supervision: restart the stopped worker
        const shortName = event.child.name.split('/').pop()!
        const newWorker = context.spawn(shortName, workerDef, { completed: 0 })

        const workers = state.workers.map((w) =>
          w.name === event.child.name ? newWorker : w,
        )

        return { state: { ...state, workers } }
      }

      case 'stopped':
        console.log(`[${context.self.name}] supervisor stopped`)
        return { state }

      default:
        return { state }
    }
  },
}

// ═══════════════════════════════════════════════════════════════════
// Main — Run the demo
// ═══════════════════════════════════════════════════════════════════

const main = async () => {
  console.log('=== Actor System Demo ===\n')

  // Create the system with a root lifecycle observer
  const system = createActorSystem((event) => {
    console.log(`[system] lifecycle event: ${event.type}`)
  })

  // Spawn the supervisor
  const supervisor = system.spawn('supervisor', supervisorDef, {
    workers: [],
    roundRobin: 0,
  })

  // Give actors time to start up
  await Bun.sleep(100)

  console.log('\n--- Dispatching jobs ---\n')

  // Dispatch some jobs
  supervisor.send({ type: 'dispatch', payload: 'build-report' })
  supervisor.send({ type: 'dispatch', payload: 'send-email' })
  supervisor.send({ type: 'dispatch', payload: 'process-image' })
  supervisor.send({ type: 'dispatch', payload: 'analyze-data' })
  supervisor.send({ type: 'dispatch', payload: 'sync-db' })

  // Wait for jobs to complete
  await Bun.sleep(500)

  console.log('\n--- Status check ---\n')

  supervisor.send({ type: 'status' })
  await Bun.sleep(100)

  console.log('\n--- Stopping worker-2 (supervision will restart it) ---\n')

  supervisor.send({ type: 'stop-worker', name: 'worker-2' })
  await Bun.sleep(200)

  console.log('\n--- Dispatching more jobs (worker-2 should be restarted) ---\n')

  supervisor.send({ type: 'dispatch', payload: 'post-restart-job-1' })
  supervisor.send({ type: 'dispatch', payload: 'post-restart-job-2' })
  supervisor.send({ type: 'dispatch', payload: 'post-restart-job-3' })

  await Bun.sleep(500)

  console.log('\n--- Final status ---\n')

  supervisor.send({ type: 'status' })
  await Bun.sleep(100)

  console.log('\n--- Shutting down system ---\n')

  await system.shutdown()

  console.log('\n=== Done ===')
}

await main()
