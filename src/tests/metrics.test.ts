import { describe, test, expect } from 'bun:test'
import {
  createPluginSystem,
  MetricsTopic,
  type ActorDef,
  type MetricsEvent,
  type PluginSystem,
} from '../system/index.ts'
import observabilityPlugin from '../plugins/observability/observability.plugin.ts'

// ─── Helpers ───

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

/** Get the most recent snapshot for a named actor from a MetricsEvent list. */
const getSnap = (events: MetricsEvent[], name: string) =>
  events[events.length - 1]?.actors.find(a => a.name === name)

/** Create a system with the metrics actor loaded and a pre-wired event collector. */
const withMetrics = async (intervalMs = 50): Promise<{ system: PluginSystem; events: MetricsEvent[] }> => {
  const events: MetricsEvent[] = []
  const system = await createPluginSystem({
    config: { observability: { metrics: { intervalMs } } },
    plugins: [observabilityPlugin],
  })
  system.subscribe(MetricsTopic, (e) => events.push(e))
  return { system, events }
}

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
    const { system, events } = await withMetrics()
    const ref = system.spawn('counter', counterDef, 0)

    ref.send({ type: 'inc' })
    ref.send({ type: 'inc' })
    ref.send({ type: 'inc' })
    await tick(150)

    const snap = getSnap(events, 'system/counter')
    expect(snap).toBeDefined()
    expect(snap!.messagesReceived).toBe(3)
    expect(snap!.messagesProcessed).toBe(3)
    expect(snap!.messagesFailed).toBe(0)
    expect(snap!.restartCount).toBe(0)

    await system.shutdown()
  })

  test('messagesFailed is incremented on handler error', async () => {
    const { system, events } = await withMetrics()
    system.spawn('counter', restartingCounterDef, 0).send({ type: 'fail' })
    await tick(150)

    const snap = getSnap(events, 'system/counter')
    expect(snap).toBeDefined()
    expect(snap!.messagesFailed).toBe(1)

    await system.shutdown()
  })

  test('restartCount is tracked on supervision restart', async () => {
    const { system, events } = await withMetrics()
    const ref = system.spawn('counter', restartingCounterDef, 0)

    ref.send({ type: 'fail' })
    ref.send({ type: 'fail' })
    await tick(150)

    const snap = getSnap(events, 'system/counter')
    expect(snap).toBeDefined()
    expect(snap!.restartCount).toBe(2)
    expect(snap!.messagesFailed).toBe(2)

    await system.shutdown()
  })
})

describe('Metrics: processing time', () => {
  test('processingTime tracks min/max/avg/sum/count', async () => {
    const { system, events } = await withMetrics()
    const ref = system.spawn('counter', counterDef, 0)

    ref.send({ type: 'slow' })
    ref.send({ type: 'slow' })
    await tick(200)

    const snap = getSnap(events, 'system/counter')
    expect(snap).toBeDefined()
    expect(snap!.processingTime.count).toBe(2)
    expect(snap!.processingTime.sum).toBeGreaterThan(0)
    expect(snap!.processingTime.min).toBeGreaterThan(0)
    expect(snap!.processingTime.max).toBeGreaterThanOrEqual(snap!.processingTime.min)
    expect(snap!.processingTime.avg).toBeCloseTo(snap!.processingTime.sum / 2, 1)

    await system.shutdown()
  })

  test('processingTime is zero when no messages processed', async () => {
    const { system, events } = await withMetrics()
    system.spawn('idle', counterDef, 0)
    await tick(150)

    const snap = getSnap(events, 'system/idle')
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

    const { system, events } = await withMetrics()
    system.spawn('parent', parentDef, null)
    await tick(150)

    const snap = getSnap(events, 'system/parent')
    expect(snap).toBeDefined()
    expect(snap!.childCount).toBe(2)
    expect(snap!.children).toContain('system/parent/child-a')
    expect(snap!.children).toContain('system/parent/child-b')

    await system.shutdown()
  })
})

describe('Metrics: status tracking', () => {
  test('actor status is running while alive', async () => {
    const { system, events } = await withMetrics()
    system.spawn('counter', counterDef, 0)
    await tick(150)

    const snap = getSnap(events, 'system/counter')
    expect(snap).toBeDefined()
    expect(snap!.status).toBe('running')

    await system.shutdown()
  })

  test('actor is absent from metrics after stop', async () => {
    const { system, events } = await withMetrics()
    const ref = system.spawn('counter', counterDef, 0)
    await tick(150)

    expect(getSnap(events, 'system/counter')).toBeDefined()

    system.stop(ref)
    await tick(150)

    expect(getSnap(events, 'system/counter')).toBeUndefined()

    await system.shutdown()
  })

  test('failed actor is absent from metrics after termination', async () => {
    const failingDef: ActorDef<CounterMsg, number> = {
      ...counterDef,
      supervision: { type: 'stop' },
    }

    const { system, events } = await withMetrics()
    const ref = system.spawn('failer', failingDef, 0)
    ref.send({ type: 'fail' })
    await tick(150)

    expect(getSnap(events, 'system/failer')).toBeUndefined()

    await system.shutdown()
  })
})

describe('Metrics: uptime and lastMessageTimestamp', () => {
  test('uptime increases over time', async () => {
    const { system, events } = await withMetrics()
    system.spawn('counter', counterDef, 0)
    await tick(200)

    const first = events[0]?.actors.find(a => a.name === 'system/counter')
    const latest = events[events.length - 1]?.actors.find(a => a.name === 'system/counter')
    expect(latest!.uptime).toBeGreaterThan(first!.uptime)

    await system.shutdown()
  })

  test('lastMessageTimestamp is null before any message', async () => {
    const { system, events } = await withMetrics()
    system.spawn('idle', counterDef, 0)
    await tick(150)

    const snap = getSnap(events, 'system/idle')
    expect(snap!.lastMessageTimestamp).toBeNull()

    await system.shutdown()
  })

  test('lastMessageTimestamp is updated after processing', async () => {
    const { system, events } = await withMetrics()
    const ref = system.spawn('counter', counterDef, 0)
    ref.send({ type: 'inc' })
    await tick(150)

    const snap = getSnap(events, 'system/counter')
    expect(snap!.lastMessageTimestamp).toBeGreaterThan(0)

    await system.shutdown()
  })
})

describe('Metrics: all actors snapshot', () => {
  test('snapshot contains all live actors', async () => {
    const { system, events } = await withMetrics()
    system.spawn('a', counterDef, 0)
    system.spawn('b', counterDef, 0)
    await tick(150)

    const names = events[events.length - 1]!.actors.map(s => s.name)
    expect(names).toContain('system')
    expect(names).toContain('system/a')
    expect(names).toContain('system/b')

    await system.shutdown()
  })

  test('stopped actors are absent from the next snapshot', async () => {
    const { system, events } = await withMetrics()
    const ref = system.spawn('temp', counterDef, 0)
    await tick(150)

    system.stop(ref)
    await tick(150)

    const names = events[events.length - 1]!.actors.map(s => s.name)
    expect(names).not.toContain('system/temp')

    await system.shutdown()
  })
})

describe('Metrics: actor hierarchy', () => {
  test('parent snapshot lists its children', async () => {
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

    const { system, events } = await withMetrics()
    system.spawn('parent', parentDef, null)
    await tick(150)

    const parentSnap = getSnap(events, 'system/parent')
    expect(parentSnap).toBeDefined()
    expect(parentSnap!.children).toContain('system/parent/child-1')
    expect(parentSnap!.children).toContain('system/parent/child-2')

    expect(getSnap(events, 'system/parent/child-1')).toBeDefined()
    expect(getSnap(events, 'system/parent/child-2')).toBeDefined()

    await system.shutdown()
  })
})

describe('Metrics: push-based MetricsTopic', () => {
  test('MetricsTopic receives periodic snapshots when configured', async () => {
    const { system, events } = await withMetrics(100)
    system.spawn('counter', counterDef, 0)
    await tick()

    // Wait for at least 2 ticks
    await tick(350)

    expect(events.length).toBeGreaterThanOrEqual(2)

    const first = events[0]!
    expect(first.timestamp).toBeGreaterThan(0)
    expect(first.actors.length).toBeGreaterThan(0)

    const counterSnap = first.actors.find((a) => a.name === 'system/counter')
    expect(counterSnap).toBeDefined()

    await system.shutdown()
  })

  test('MetricsTopic is not published when observability plugin is not loaded', async () => {
    const system = await createPluginSystem()
    system.spawn('counter', counterDef, 0)

    const events: unknown[] = []
    system.subscribe(MetricsTopic, (event) => {
      events.push(event)
    })

    await tick(200)

    expect(events.length).toBe(0)

    await system.shutdown()
  })

  test('metrics actor appears in its own snapshot', async () => {
    const { system, events } = await withMetrics()
    await tick(150)

    const names = events[events.length - 1]!.actors.map(s => s.name)
    expect(names).toContain('system/observability/metrics-0')

    await system.shutdown()
  })
})

describe('Metrics: system root actor', () => {
  test('system actor itself is tracked in metrics', async () => {
    const { system, events } = await withMetrics()
    await tick(150)

    const snap = getSnap(events, 'system')
    expect(snap).toBeDefined()
    expect(snap!.name).toBe('system')
    expect(snap!.status).toBe('running')

    await system.shutdown()
  })

  test('non-existent actor has no snapshot', async () => {
    const { system, events } = await withMetrics()
    await tick(150)

    expect(getSnap(events, 'system/nonexistent')).toBeUndefined()

    await system.shutdown()
  })
})
