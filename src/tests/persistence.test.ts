import { describe, test, expect } from 'bun:test'
import { createPluginSystem, LogTopic } from '../system/index.ts'
import type { ActorDef, PersistenceAdapter, LogEvent } from '../system/index.ts'

// ─── Helpers ───

const tick = (ms = 50) => Bun.sleep(ms)

type Counter = { count: number }

/** In-memory persistence adapter backed by a simple variable. */
const memAdapter = <S>(initial?: S): PersistenceAdapter<S> & { current: S | undefined } => {
  const adapter = {
    current: initial,
    load: async () => adapter.current,
    save: async (state: S) => { adapter.current = state },
  }
  return adapter
}

const counterDef: ActorDef<string, Counter> = {
  handler: (state, message) => {
    if (message === 'POISON') throw new Error('poisoned')
    return { state: { count: state.count + 1 } }
  },
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe('Persistence: load on start', () => {
  test('actor starts from loaded state when adapter returns a snapshot', async () => {
    const adapter = memAdapter<Counter>({ count: 42 })
    const system = await createPluginSystem()

    const ref = system.spawn('counter', { ...counterDef, persistence: adapter }, { count: 0 })

    await tick()
    ref.send('inc')
    await tick()

    expect(adapter.current?.count).toBe(43)

    await system.shutdown()
  })

  test('actor starts from initialState when load returns undefined', async () => {
    const adapter = memAdapter<Counter>(undefined)
    const system = await createPluginSystem()

    const ref = system.spawn('counter', { ...counterDef, persistence: adapter }, { count: 0 })

    await tick()
    ref.send('inc')
    await tick()

    expect(adapter.current?.count).toBe(1)

    await system.shutdown()
  })

  test('start lifecycle receives loaded state, not initialState', async () => {
    const startStates: Counter[] = []
    const adapter = memAdapter<Counter>({ count: 99 })
    const system = await createPluginSystem()

    system.spawn('counter', {
      ...counterDef,
      lifecycle: (state, event) => {
        if (event.type === 'start') startStates.push(state)
        return { state }
      },
      persistence: adapter,
    }, { count: 0 })

    await tick()

    expect(startStates).toHaveLength(1)
    expect(startStates[0]!.count).toBe(99)

    await system.shutdown()
  })
})

describe('Persistence: save after message', () => {
  test('adapter is called with the new state after each message', async () => {
    const saves: Counter[] = []
    const adapter: PersistenceAdapter<Counter> = {
      load: async () => undefined,
      save: async (state) => { saves.push(state) },
    }
    const system = await createPluginSystem()

    const ref = system.spawn('counter', { ...counterDef, persistence: adapter }, { count: 0 })

    await tick()
    ref.send('a')
    ref.send('b')
    ref.send('c')
    await tick()

    expect(saves).toHaveLength(3)
    expect(saves[0]!.count).toBe(1)
    expect(saves[1]!.count).toBe(2)
    expect(saves[2]!.count).toBe(3)

    await system.shutdown()
  })

  test('save error does not crash the actor — subsequent messages still processed', async () => {
    let saveCallCount = 0
    const adapter: PersistenceAdapter<Counter> = {
      load: async () => undefined,
      save: async () => {
        saveCallCount++
        if (saveCallCount === 1) throw new Error('disk full')
      },
    }
    const system = await createPluginSystem()

    const ref = system.spawn('counter', { ...counterDef, persistence: adapter }, { count: 0 })

    await tick()
    ref.send('a') // save throws
    ref.send('b') // save succeeds
    ref.send('c') // save succeeds
    await tick()

    expect(saveCallCount).toBe(3)

    const snapshot = system.getActorMetrics('system/counter')
    expect(snapshot?.messagesProcessed).toBe(3)

    await system.shutdown()
  })

  test('save error is logged as a warning', async () => {
    const logs: LogEvent[] = []
    const adapter: PersistenceAdapter<Counter> = {
      load: async () => undefined,
      save: async () => { throw new Error('storage unavailable') },
    }
    const system = await createPluginSystem()
    system.subscribe('test', LogTopic, (e) => logs.push(e))

    const ref = system.spawn('counter', { ...counterDef, persistence: adapter }, { count: 0 })

    await tick()
    ref.send('a')
    await tick()

    const warnings = logs.filter(l => l.level === 'warn' && l.source === 'system/counter' && l.message.includes('persistence save failed'))
    expect(warnings).toHaveLength(1)

    await system.shutdown()
  })
})

describe('Persistence: load on restart', () => {
  test('restarted actor recovers from last snapshot, not initialState', async () => {
    const adapter = memAdapter<Counter>({ count: 10 })
    const setupStates: Counter[] = []
    const system = await createPluginSystem()

    const ref = system.spawn('counter', {
      ...counterDef,
      lifecycle: (state, event) => {
        if (event.type === 'start') setupStates.push({ ...state })
        return { state }
      },
      supervision: { type: 'restart', maxRetries: 1 },
      persistence: adapter,
    }, { count: 0 })

    await tick()

    // Process two messages — adapter should hold count: 12
    ref.send('a')
    ref.send('b')
    await tick()

    expect(adapter.current?.count).toBe(12)

    // Crash the actor — supervision restarts it
    ref.send('POISON')
    await tick(200)

    // start lifecycle should have been called twice: initial start + restart
    expect(setupStates).toHaveLength(2)
    // Restart should have received the last saved snapshot, not initialState (0)
    expect(setupStates[1]!.count).toBe(12)

    await system.shutdown()
  })

  test('restarted actor falls back to initialState when load returns undefined after restart', async () => {
    let loadCallCount = 0
    const adapter: PersistenceAdapter<Counter> = {
      load: async () => {
        loadCallCount++
        return undefined // always return undefined
      },
      save: async () => {},
    }
    const setupStates: Counter[] = []
    const system = await createPluginSystem()

    const ref = system.spawn('counter', {
      ...counterDef,
      lifecycle: (state, event) => {
        if (event.type === 'start') setupStates.push({ ...state })
        return { state }
      },
      supervision: { type: 'restart', maxRetries: 1 },
      persistence: adapter,
    }, { count: 7 })

    await tick()
    ref.send('POISON')
    await tick(200)

    expect(setupStates).toHaveLength(2)
    expect(setupStates[1]!.count).toBe(7) // initialState fallback

    await system.shutdown()
  })
})

describe('Persistence: no adapter configured', () => {
  test('actor without persistence works identically to before', async () => {
    const system = await createPluginSystem()
    const ref = system.spawn('counter', counterDef, { count: 0 })

    await tick()
    ref.send('a')
    ref.send('b')
    await tick()

    const snapshot = system.getActorMetrics('system/counter')
    expect(snapshot?.messagesProcessed).toBe(2)

    await system.shutdown()
  })
})
