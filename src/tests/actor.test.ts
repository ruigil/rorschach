import { describe, test, expect } from 'bun:test'
import { createActorSystem } from '../system/index.ts'
import type {
  ActorDef,
  ActorRef,
  LifecycleEvent,
} from '../system/index.ts'

// ─── Helpers ───

/** Small delay to let async actor processing settle */
const tick = (ms = 50) => Bun.sleep(ms)

// ═══════════════════════════════════════════════════════════════════
// Actor: Basic Message Handling
// ═══════════════════════════════════════════════════════════════════

describe('Actor: basic message handling', () => {
  test('actor processes messages through the handler', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      handler: (state, message) => {
        received.push(message)
        return { state }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('basic', def, null)
    await tick()

    ref.send('hello')
    ref.send('world')
    await tick()

    expect(received).toEqual(['hello', 'world'])
    await system.shutdown()
  })

  test('actor maintains and evolves state across messages', async () => {
    const snapshots: number[] = []

    const def: ActorDef<'inc' | 'snapshot', { count: number }> = {
      handler: (state, message) => {
        if (message === 'inc') {
          return { state: { count: state.count + 1 } }
        }
        if (message === 'snapshot') {
          snapshots.push(state.count)
          return { state }
        }
        return { state }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('counter', def, { count: 0 })
    await tick()

    ref.send('inc')
    ref.send('inc')
    ref.send('inc')
    ref.send('snapshot')
    await tick()

    expect(snapshots).toEqual([3])
    await system.shutdown()
  })

  test('actor ref has the correct name', async () => {
    const def: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const system = createActorSystem()
    const ref = system.spawn('named-actor', def, null)

    expect(ref.name).toBe('system/named-actor')
    await system.shutdown()
  })

  test('messages sent after stop are silently dropped', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      handler: (state, message) => {
        received.push(message)
        return { state }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('drop-test', def, null)
    await tick()

    ref.send('before')
    await tick()

    system.stop({ name: 'system/drop-test' })
    await tick()

    ref.send('after-stop')
    await tick()

    expect(received).toEqual(['before'])
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Actor: Setup Phase
// ═══════════════════════════════════════════════════════════════════

describe('Actor: setup phase', () => {
  test('setup runs before message processing and enriches initial state', async () => {
    const log: string[] = []

    const def: ActorDef<string, { items: string[] }> = {
      setup: (state, _ctx) => {
        log.push('setup')
        return { items: [...state.items, 'from-setup'] }
      },
      handler: (state, message) => {
        log.push(`message:${message}`)
        return { state: { items: [...state.items, message] } }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('setup-actor', def, { items: [] })
    await tick()

    ref.send('msg1')
    await tick()

    // Setup ran before message handling
    expect(log).toEqual(['setup', 'message:msg1'])
    await system.shutdown()
  })

  test('async setup is awaited before processing messages', async () => {
    const order: string[] = []

    const def: ActorDef<string, null> = {
      setup: async (state) => {
        await Bun.sleep(50)
        order.push('setup-done')
        return state
      },
      handler: (state, msg) => {
        order.push(`msg:${msg}`)
        return { state }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('async-setup', def, null)
    ref.send('early')
    await tick(150)

    expect(order).toEqual(['setup-done', 'msg:early'])
    await system.shutdown()
  })

  test('context.self is available in setup', async () => {
    let selfName: string | null = null

    const def: ActorDef<string, null> = {
      setup: (state, ctx) => {
        selfName = ctx.self.name
        return state
      },
      handler: (state) => ({ state }),
    }

    const system = createActorSystem()
    system.spawn('self-check', def, null)
    await tick()

    expect(selfName!).toBe('system/self-check')
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Actor: Async Handler Support
// ═══════════════════════════════════════════════════════════════════

describe('Actor: async handler support', () => {
  test('actor handler can be async', async () => {
    const results: number[] = []

    const def: ActorDef<number, { total: number }> = {
      handler: async (state, message) => {
        await Bun.sleep(10)
        const newTotal = state.total + message
        results.push(newTotal)
        return { state: { total: newTotal } }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('async-handler', def, { total: 0 })
    await tick()

    ref.send(10)
    ref.send(20)
    ref.send(30)
    await tick(200)

    expect(results).toEqual([10, 30, 60])
    await system.shutdown()
  })

  test('async messages are processed sequentially, not concurrently', async () => {
    const log: string[] = []

    const def: ActorDef<string, null> = {
      handler: async (state, msg) => {
        log.push(`start:${msg}`)
        await Bun.sleep(30)
        log.push(`end:${msg}`)
        return { state }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('sequential', def, null)
    await tick()

    ref.send('a')
    ref.send('b')
    await tick(200)

    // Messages must be processed one at a time
    expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b'])
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Actor: Lifecycle State Evolution
// ═══════════════════════════════════════════════════════════════════

describe('Actor: lifecycle state evolution', () => {
  test('lifecycle handler can evolve state from terminated events', async () => {
    const snapshots: string[][] = []

    const childDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    type Msg = 'spawn' | 'stop-child' | 'snapshot'

    const parentDef: ActorDef<Msg, { events: string[] }> = {
      handler: (state, msg, ctx) => {
        if (msg === 'spawn') {
          ctx.spawn('child', childDef, null)
          return { state }
        }
        if (msg === 'stop-child') {
          ctx.stop({ name: 'system/tracker/child' })
          return { state }
        }
        if (msg === 'snapshot') {
          snapshots.push([...state.events])
          return { state }
        }
        return { state }
      },
      lifecycle: (state, event) => {
        return { state: { events: [...state.events, event.type] } }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('tracker', parentDef, { events: [] })
    await tick(100)

    ref.send('spawn')
    await tick(100)

    ref.send('stop-child')
    await tick(100)

    ref.send('snapshot')
    await tick(100)

    expect(snapshots.length).toBe(1)
    expect(snapshots[0]).toContain('terminated')

    await system.shutdown()
  })
})
