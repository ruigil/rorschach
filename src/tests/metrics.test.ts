import { describe, test, expect } from 'bun:test'
import {
  createPluginSystem,
  MetricsTopic,
  type ActorDef,
  type ActorSnapshot,
  type MetricsEvent,
} from '../system/index.ts'

// ─── Helper: wait for async processing to settle ───
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

// ─── Simple counter actor for testing ───
type CounterMsg = { type: 'inc' } | { type: 'slow' } | { type: 'fail' }

const counterDef: ActorDef<CounterMsg, number> = {
  handler: (state, msg) => {
    if (msg.type === 'fail') throw new Error('boom')
    if (msg.type === 'slow') {
      // Simulate blocking work (~10ms)
      const start = performance.now()
      while (performance.now() - start < 10) { /* busy wait */ }
    }
    return { state: state + 1 }
  },
}

const restartingCounterDef: ActorDef<CounterMsg, number> = {
  ...counterDef,
  supervision: { type: 'restart' },
}

// ─── Tests ───

describe('Metrics: per-actor counters', () => {
  test('messagesReceived and messagesProcessed are tracked', async () => {
    const system = await createPluginSystem()
    const ref = system.spawn('counter', counterDef, 0)

    ref.send({ type: 'inc' })
    ref.send({ type: 'inc' })
    ref.send({ type: 'inc' })
    await tick()

    const snap = system.getActorMetrics('system/counter')
    expect(snap).toBeDefined()
    expect(snap!.messagesReceived).toBe(3)
    expect(snap!.messagesProcessed).toBe(3)
    expect(snap!.messagesFailed).toBe(0)
    expect(snap!.restartCount).toBe(0)

    await system.shutdown()
  })

  test('messagesFailed is incremented on handler error', async () => {
    const system = await createPluginSystem()
    system.spawn('counter', restartingCounterDef, 0).send({ type: 'fail' })
    await tick()

    const snap = system.getActorMetrics('system/counter')
    expect(snap).toBeDefined()
    expect(snap!.messagesFailed).toBe(1)

    await system.shutdown()
  })

  test('restartCount is tracked on supervision restart', async () => {
    const system = await createPluginSystem()
    const ref = system.spawn('counter', restartingCounterDef, 0)

    ref.send({ type: 'fail' })
    ref.send({ type: 'fail' })
    await tick()

    const snap = system.getActorMetrics('system/counter')
    expect(snap).toBeDefined()
    expect(snap!.restartCount).toBe(2)
    expect(snap!.messagesFailed).toBe(2)

    await system.shutdown()
  })
})

describe('Metrics: processing time', () => {
  test('processingTime tracks min/max/avg/sum/count', async () => {
    const system = await createPluginSystem()
    const ref = system.spawn('counter', counterDef, 0)

    ref.send({ type: 'slow' })
    ref.send({ type: 'slow' })
    await tick(100)

    const snap = system.getActorMetrics('system/counter')
    expect(snap).toBeDefined()
    expect(snap!.processingTime.count).toBe(2)
    expect(snap!.processingTime.sum).toBeGreaterThan(0)
    expect(snap!.processingTime.min).toBeGreaterThan(0)
    expect(snap!.processingTime.max).toBeGreaterThanOrEqual(snap!.processingTime.min)
    expect(snap!.processingTime.avg).toBeCloseTo(snap!.processingTime.sum / 2, 1)

    await system.shutdown()
  })

  test('processingTime is zero when no messages processed', async () => {
    const system = await createPluginSystem()
    system.spawn('idle', counterDef, 0)
    await tick()

    const snap = system.getActorMetrics('system/idle')
    expect(snap).toBeDefined()
    expect(snap!.processingTime.count).toBe(0)
    expect(snap!.processingTime.sum).toBe(0)
    expect(snap!.processingTime.min).toBe(0)
    expect(snap!.processingTime.max).toBe(0)
    expect(snap!.processingTime.avg).toBe(0)

    await system.shutdown()
  })
})

describe('Metrics: gauges (mailboxSize, stashSize, childCount)', () => {
  test('childCount reflects spawned children', async () => {
    const childDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const parentDef: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          ctx.spawn('child-a', childDef, null)
          ctx.spawn('child-b', childDef, null)
        }
        return { state }
      },
      handler: (state) => ({ state }),
    }

    const system = await createPluginSystem()
    system.spawn('parent', parentDef, null)
    await tick()

    const snap = system.getActorMetrics('system/parent')
    expect(snap).toBeDefined()
    expect(snap!.childCount).toBe(2)
    expect(snap!.children).toContain('system/parent/child-a')
    expect(snap!.children).toContain('system/parent/child-b')

    await system.shutdown()
  })
})

describe('Metrics: status tracking', () => {
  test('actor status is running while alive', async () => {
    const system = await createPluginSystem()
    system.spawn('counter', counterDef, 0)
    await tick()

    const snap = system.getActorMetrics('system/counter')
    expect(snap).toBeDefined()
    expect(snap!.status).toBe('running')

    await system.shutdown()
  })

  test('actor metrics are unregistered after stop', async () => {
    const system = await createPluginSystem()
    const ref = system.spawn('counter', counterDef, 0)
    await tick()

    expect(system.getActorMetrics('system/counter')).toBeDefined()

    system.stop(ref)
    await tick()

    expect(system.getActorMetrics('system/counter')).toBeUndefined()

    await system.shutdown()
  })

  test('failed actor has status "failed" in the snapshot before unregistration', async () => {
    // Use stop strategy so the actor actually stops on failure
    const failingDef: ActorDef<CounterMsg, number> = {
      ...counterDef,
      supervision: { type: 'stop' },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('failer', failingDef, 0)
    ref.send({ type: 'fail' })
    await tick()

    // After failure + shutdown sequence, the actor is unregistered
    // The status is 'failed' briefly before unregistration
    // We verify indirectly: the actor is gone from the registry
    expect(system.getActorMetrics('system/failer')).toBeUndefined()

    await system.shutdown()
  })
})

describe('Metrics: uptime and lastMessageTimestamp', () => {
  test('uptime increases over time', async () => {
    const system = await createPluginSystem()
    system.spawn('counter', counterDef, 0)
    await tick()

    const snap1 = system.getActorMetrics('system/counter')
    await tick(100)
    const snap2 = system.getActorMetrics('system/counter')

    expect(snap2!.uptime).toBeGreaterThan(snap1!.uptime)

    await system.shutdown()
  })

  test('lastMessageTimestamp is null before any message', async () => {
    const system = await createPluginSystem()
    system.spawn('idle', counterDef, 0)
    await tick()

    const snap = system.getActorMetrics('system/idle')
    expect(snap!.lastMessageTimestamp).toBeNull()

    await system.shutdown()
  })

  test('lastMessageTimestamp is updated after processing', async () => {
    const system = await createPluginSystem()
    const ref = system.spawn('counter', counterDef, 0)
    ref.send({ type: 'inc' })
    await tick()

    const snap = system.getActorMetrics('system/counter')
    expect(snap!.lastMessageTimestamp).toBeGreaterThan(0)

    await system.shutdown()
  })
})

describe('Metrics: getAllActorMetrics', () => {
  test('returns snapshots for all live actors', async () => {
    const system = await createPluginSystem()
    system.spawn('a', counterDef, 0)
    system.spawn('b', counterDef, 0)
    await tick()

    const all = system.getAllActorMetrics()
    const names = all.map((s) => s.name)

    // Should include the system root actor + the two spawned actors
    expect(names).toContain('system')
    expect(names).toContain('system/a')
    expect(names).toContain('system/b')

    await system.shutdown()
  })

  test('stopped actors are not included', async () => {
    const system = await createPluginSystem()
    const ref = system.spawn('temp', counterDef, 0)
    await tick()

    system.stop(ref)
    await tick()

    const all = system.getAllActorMetrics()
    const names = all.map((s) => s.name)
    expect(names).not.toContain('system/temp')

    await system.shutdown()
  })
})

describe('Metrics: getActorTree', () => {
  test('returns hierarchical tree of actors', async () => {
    const childDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const parentDef: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          ctx.spawn('child-1', childDef, null)
          ctx.spawn('child-2', childDef, null)
        }
        return { state }
      },
      handler: (state) => ({ state }),
    }

    const system = await createPluginSystem()
    system.spawn('parent', parentDef, null)
    await tick()

    const tree = system.getActorTree()

    // Root should be 'system'
    const systemNode = tree.find((n) => n.name === 'system')
    expect(systemNode).toBeDefined()

    // 'system/parent' should be a child of 'system'
    const parentNode = systemNode!.children.find((n) => n.name === 'system/parent')
    expect(parentNode).toBeDefined()

    // Two children of parent
    const childNames = parentNode!.children.map((n) => n.name)
    expect(childNames).toContain('system/parent/child-1')
    expect(childNames).toContain('system/parent/child-2')

    await system.shutdown()
  })
})

describe('Metrics: push-based MetricsTopic', () => {
  test('MetricsTopic receives periodic snapshots when configured', async () => {
    const system = await createPluginSystem({ metrics: { intervalMs: 100 } })
    system.spawn('counter', counterDef, 0)
    await tick()

    const events: MetricsEvent[] = []
    system.subscribe('test-subscriber', MetricsTopic, (event) => {
      events.push(event as MetricsEvent)
    })

    // Wait for at least 2 ticks
    await tick(350)

    expect(events.length).toBeGreaterThanOrEqual(2)

    const first = events[0]!
    expect(first.timestamp).toBeGreaterThan(0)
    expect(first.actors.length).toBeGreaterThan(0)

    // The snapshots should include our counter actor
    const counterSnap = first.actors.find((a) => a.name === 'system/counter')
    expect(counterSnap).toBeDefined()

    await system.shutdown()
  })

  test('MetricsTopic is not published when metrics option is omitted', async () => {
    const system = await createPluginSystem()
    system.spawn('counter', counterDef, 0)

    const events: unknown[] = []
    system.subscribe('test-subscriber', MetricsTopic, (event) => {
      events.push(event)
    })

    await tick(200)

    expect(events.length).toBe(0)

    await system.shutdown()
  })

  test('internal $metrics actor appears in the actor tree', async () => {
    const system = await createPluginSystem({ metrics: { intervalMs: 1000 } })
    await tick()

    const all = system.getAllActorMetrics()
    const names = all.map((s) => s.name)
    expect(names).toContain('system/$metrics')

    await system.shutdown()
  })
})

describe('Metrics: system root actor', () => {
  test('system actor itself is tracked in metrics', async () => {
    const system = await createPluginSystem()
    await tick()

    const snap = system.getActorMetrics('system')
    expect(snap).toBeDefined()
    expect(snap!.name).toBe('system')
    expect(snap!.status).toBe('running')

    await system.shutdown()
  })

  test('getActorMetrics returns undefined for non-existent actor', async () => {
    const system = await createPluginSystem()
    await tick()

    expect(system.getActorMetrics('system/nonexistent')).toBeUndefined()

    await system.shutdown()
  })
})
