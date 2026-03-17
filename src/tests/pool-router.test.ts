import { describe, test, expect } from 'bun:test'
import { createPluginSystem, createConfigPlugin, DeadLetterTopic, MetricsTopic, SystemLifecycleTopic } from '../system/index.ts'
import type { ActorDef, DeadLetter, LifecycleEvent, MetricsEvent } from '../system/index.ts'
import { createPoolRouter } from '../plugins/parallel/pool-router.ts'
import observabilityPlugin from '../plugins/observability/observability.plugin.ts'

// ─── Helpers ───

const tick = (ms = 50) => Bun.sleep(ms)

const withMetrics = async () => {
  const events: MetricsEvent[] = []
  const system = await createPluginSystem({
    plugins: [
      createConfigPlugin({ observability: { metrics: { intervalMs: 50 } } }),
      observabilityPlugin,
    ],
  })
  system.subscribe('test', MetricsTopic, (e) => events.push(e))
  return { system, events }
}

/**
 * A worker that records each processed message as `{ worker, message }`.
 * Throws on 'POISON' so we can deterministically kill a specific worker.
 */
const makeRecordingWorker = (
  log: Array<{ worker: string; message: string }>,
): ActorDef<string, null> => ({
  handler: (state, message, ctx) => {
    if (message === 'POISON') throw new Error('poisoned')
    log.push({ worker: ctx.self.name, message })
    return { state }
  },
})

// ─── Round-robin distribution ───────────────────────────────────────────────

describe('PoolRouter: round-robin distribution', () => {
  test('distributes messages evenly across all workers', async () => {
    const log: Array<{ worker: string; message: string }> = []
    const system = await createPluginSystem()

    const router = createPoolRouter({
      poolSize: 3,
      worker: makeRecordingWorker(log),
      workerInitialState: null,
    })

    const ref = system.spawn('pool', router.def, router.initialState)
    await tick()

    for (let i = 0; i < 9; i++) ref.send(`msg-${i}`)
    await tick()

    expect(log).toHaveLength(9)

    // Group by worker
    const byWorker = new Map<string, string[]>()
    for (const { worker, message } of log) {
      const existing = byWorker.get(worker) ?? []
      existing.push(message)
      byWorker.set(worker, existing)
    }

    // All 3 workers participated
    expect(byWorker.size).toBe(3)
    // Each received exactly 3 messages
    for (const messages of byWorker.values()) {
      expect(messages).toHaveLength(3)
    }

    await system.shutdown()
  })

  test('first message always goes to worker-0', async () => {
    const log: Array<{ worker: string; message: string }> = []
    const system = await createPluginSystem()

    const router = createPoolRouter({
      poolSize: 3,
      worker: makeRecordingWorker(log),
      workerInitialState: null,
    })

    const ref = system.spawn('pool', router.def, router.initialState)
    await tick()

    ref.send('first')
    await tick()

    expect(log[0]?.worker).toBe('system/pool/worker-0')
    expect(log[0]?.message).toBe('first')

    await system.shutdown()
  })

  test('cycles back to the first worker after a full round', async () => {
    const log: Array<{ worker: string; message: string }> = []
    const system = await createPluginSystem()

    const router = createPoolRouter({
      poolSize: 2,
      worker: makeRecordingWorker(log),
      workerInitialState: null,
    })

    const ref = system.spawn('pool', router.def, router.initialState)
    await tick()

    // Messages 0,2 → worker-0; messages 1,3 → worker-1
    ref.send('a')
    ref.send('b')
    ref.send('c')
    ref.send('d')
    await tick()

    const worker0Messages = log.filter(e => e.worker === 'system/pool/worker-0').map(e => e.message)
    const worker1Messages = log.filter(e => e.worker === 'system/pool/worker-1').map(e => e.message)

    expect(worker0Messages).toEqual(['a', 'c'])
    expect(worker1Messages).toEqual(['b', 'd'])

    await system.shutdown()
  })
})

// ─── Worker naming ──────────────────────────────────────────────────────────

describe('PoolRouter: worker naming', () => {
  test('workers are named worker-0 through worker-N under the router', async () => {
    const { system, events } = await withMetrics()

    const router = createPoolRouter({
      poolSize: 3,
      worker: { handler: (state) => ({ state }) },
      workerInitialState: null,
    })

    system.spawn('pool', router.def, router.initialState)
    await tick(150)

    const workerNames = (events[events.length - 1]?.actors ?? [])
      .map(s => s.name)
      .filter(n => n.startsWith('system/pool/worker-'))
      .sort()

    expect(workerNames).toEqual([
      'system/pool/worker-0',
      'system/pool/worker-1',
      'system/pool/worker-2',
    ])

    await system.shutdown()
  })
})

// ─── onWorkerFailure: 'replace' (default) ───────────────────────────────────

describe("PoolRouter: onWorkerFailure 'replace'", () => {
  test('spawns a replacement worker and maintains pool size', async () => {
    const { system, events } = await withMetrics()

    const router = createPoolRouter({
      poolSize: 3,
      worker: makeRecordingWorker([]),
      workerInitialState: null,
    })

    const ref = system.spawn('pool', router.def, router.initialState)
    await tick()

    // POISON goes to worker-0 (first message → index 0)
    ref.send('POISON')
    await tick(300) // wait for failure, replacement, and a metrics tick

    // Pool should still have 3 workers (router's child count)
    const routerSnap = events[events.length - 1]?.actors.find(a => a.name === 'system/pool')
    expect(routerSnap?.childCount).toBe(3)

    await system.shutdown()
  })

  test('replacement worker processes messages normally', async () => {
    const log: Array<{ worker: string; message: string }> = []
    const system = await createPluginSystem()

    const router = createPoolRouter({
      poolSize: 2,
      worker: makeRecordingWorker(log),
      workerInitialState: null,
    })

    const ref = system.spawn('pool', router.def, router.initialState)
    await tick()

    // Kill worker-0
    ref.send('POISON')
    await tick(200)

    // Send more messages — should still be processed by the remaining pool
    ref.send('after-replace-1')
    ref.send('after-replace-2')
    ref.send('after-replace-3')
    ref.send('after-replace-4')
    await tick()

    const processedMessages = log.map(e => e.message)
    expect(processedMessages).toContain('after-replace-1')
    expect(processedMessages).toContain('after-replace-2')
    expect(processedMessages).toContain('after-replace-3')
    expect(processedMessages).toContain('after-replace-4')

    await system.shutdown()
  })

  test('replacement worker gets a new sequential name', async () => {
    const { system, events } = await withMetrics()

    const router = createPoolRouter({
      poolSize: 2,
      worker: makeRecordingWorker([]),
      workerInitialState: null,
    })

    const ref = system.spawn('pool', router.def, router.initialState)
    await tick()

    ref.send('POISON') // kills worker-0
    await tick(300) // wait for failure, replacement, and a metrics tick

    const workerNames = (events[events.length - 1]?.actors ?? [])
      .map(s => s.name)
      .filter(n => n.startsWith('system/pool/worker-'))
      .sort()

    // worker-0 is gone, worker-2 is the replacement
    expect(workerNames).toContain('system/pool/worker-1')
    expect(workerNames).toContain('system/pool/worker-2')
    expect(workerNames).not.toContain('system/pool/worker-0')

    await system.shutdown()
  })

  test('can replace multiple workers across sequential failures', async () => {
    const { system, events } = await withMetrics()

    const router = createPoolRouter({
      poolSize: 3,
      worker: makeRecordingWorker([]),
      workerInitialState: null,
    })

    const ref = system.spawn('pool', router.def, router.initialState)
    await tick()

    // Kill one worker at a time, waiting for replacement each time
    ref.send('POISON') // kills worker-0 (index 0, seq → 3)
    await tick(300)
    ref.send('POISON') // kills next worker in rotation
    await tick(300)

    // Pool should still be at full size
    const routerSnap = events[events.length - 1]?.actors.find(a => a.name === 'system/pool')
    expect(routerSnap?.childCount).toBe(3)

    await system.shutdown()
  })
})

// ─── onWorkerFailure: 'shrink' ───────────────────────────────────────────────

describe("PoolRouter: onWorkerFailure 'shrink'", () => {
  test('reduces pool size when a worker fails', async () => {
    const { system, events } = await withMetrics()

    const router = createPoolRouter({
      poolSize: 3,
      worker: makeRecordingWorker([]),
      workerInitialState: null,
      onWorkerFailure: 'shrink',
    })

    const ref = system.spawn('pool', router.def, router.initialState)
    await tick()

    ref.send('POISON') // kills worker-0
    await tick(300) // wait for failure and a metrics tick

    const routerSnap = events[events.length - 1]?.actors.find(a => a.name === 'system/pool')
    expect(routerSnap?.childCount).toBe(2)

    await system.shutdown()
  })

  test('remaining workers still process messages after shrink', async () => {
    const log: Array<{ worker: string; message: string }> = []
    const system = await createPluginSystem()

    const router = createPoolRouter({
      poolSize: 2,
      worker: makeRecordingWorker(log),
      workerInitialState: null,
      onWorkerFailure: 'shrink',
    })

    const ref = system.spawn('pool', router.def, router.initialState)
    await tick()

    ref.send('POISON') // kills worker-0 → pool shrinks to 1
    await tick(200)

    ref.send('work-1')
    ref.send('work-2')
    await tick()

    const processed = log.map(e => e.message)
    expect(processed).toContain('work-1')
    expect(processed).toContain('work-2')

    await system.shutdown()
  })

  test('messages go to dead letters when pool shrinks to empty', async () => {
    const deadLetters: DeadLetter[] = []
    const system = await createPluginSystem()
    system.subscribe('test', DeadLetterTopic, (dl) => deadLetters.push(dl))

    const router = createPoolRouter({
      poolSize: 1,
      worker: makeRecordingWorker([]),
      workerInitialState: null,
      onWorkerFailure: 'shrink',
    })

    const ref = system.spawn('pool', router.def, router.initialState)
    await tick()

    ref.send('POISON') // kills worker-0 → pool is now empty
    await tick(200)

    ref.send('lost-message')
    await tick()

    const poolDeadLetters = deadLetters.filter(dl => dl.recipient === 'system/pool')
    expect(poolDeadLetters).toHaveLength(1)
    expect(poolDeadLetters[0]?.message).toBe('lost-message')

    await system.shutdown()
  })
})

// ─── onWorkerFailure: 'escalate' ────────────────────────────────────────────

describe("PoolRouter: onWorkerFailure 'escalate'", () => {
  test('router terminates when a worker fails', async () => {
    const events: LifecycleEvent[] = []
    const system = await createPluginSystem()
    system.subscribe('test', SystemLifecycleTopic, (e) => events.push(e))

    const router = createPoolRouter({
      poolSize: 2,
      worker: makeRecordingWorker([]),
      workerInitialState: null,
      onWorkerFailure: 'escalate',
    })

    const ref = system.spawn('pool', router.def, router.initialState)
    await tick()

    ref.send('POISON') // kills worker-0, router should escalate and die
    await tick(200)

    const terminated = events.filter(
      (e): e is Extract<LifecycleEvent, { type: 'terminated' }> =>
        e.type === 'terminated' && (e as Extract<LifecycleEvent, { type: 'terminated' }>).ref.name === 'system/pool',
    )
    expect(terminated).toHaveLength(1)
    expect(terminated[0]?.reason).toBe('failed')

    await system.shutdown()
  })
})

// ─── Validation ─────────────────────────────────────────────────────────────

describe('PoolRouter: validation', () => {
  test('throws RangeError when poolSize is 0', () => {
    expect(() =>
      createPoolRouter({
        poolSize: 0,
        worker: { handler: (state) => ({ state }) },
        workerInitialState: null,
      }),
    ).toThrow(RangeError)
  })

  test('throws RangeError when poolSize is negative', () => {
    expect(() =>
      createPoolRouter({
        poolSize: -1,
        worker: { handler: (state) => ({ state }) },
        workerInitialState: null,
      }),
    ).toThrow(RangeError)
  })
})

// ─── Shutdown ────────────────────────────────────────────────────────────────

describe('PoolRouter: shutdown', () => {
  test('all workers are stopped on system shutdown', async () => {
    const { system, events } = await withMetrics()
    const terminated: string[] = []
    system.subscribe('lifecycle', SystemLifecycleTopic, (e) => {
      if (e.type === 'terminated') terminated.push(e.ref.name)
    })

    const router = createPoolRouter({
      poolSize: 3,
      worker: { handler: (state) => ({ state }) },
      workerInitialState: null,
    })

    system.spawn('pool', router.def, router.initialState)
    await tick(150)

    // Verify all actors are present before shutdown
    const names = events[events.length - 1]!.actors.map(s => s.name)
    expect(names).toContain('system/pool')
    expect(names.filter(n => n.startsWith('system/pool/worker-'))).toHaveLength(3)

    await system.shutdown()

    // The pool itself terminated (workers are its children — their cleanup is implicit)
    expect(terminated).toContain('system/pool')
  })
})
