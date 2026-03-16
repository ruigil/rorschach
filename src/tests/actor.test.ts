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
// Actor: Start Lifecycle
// ═══════════════════════════════════════════════════════════════════

describe('Actor: start lifecycle', () => {
  test('start lifecycle runs before message processing and enriches initial state', async () => {
    const log: string[] = []

    const def: ActorDef<string, { items: string[] }> = {
      lifecycle: (state, event) => {
        if (event.type === 'start') {
          log.push('start')
          return { state: { items: [...state.items, 'from-start'] } }
        }
        return { state }
      },
      handler: (state, message) => {
        log.push(`message:${message}`)
        return { state: { items: [...state.items, message] } }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('start-actor', def, { items: [] })
    await tick()

    ref.send('msg1')
    await tick()

    // Start ran before message handling
    expect(log).toEqual(['start', 'message:msg1'])
    await system.shutdown()
  })

  test('async start lifecycle is awaited before processing messages', async () => {
    const order: string[] = []

    const def: ActorDef<string, null> = {
      lifecycle: async (state, event) => {
        if (event.type === 'start') {
          await Bun.sleep(50)
          order.push('start-done')
        }
        return { state }
      },
      handler: (state, msg) => {
        order.push(`msg:${msg}`)
        return { state }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('async-start', def, null)
    ref.send('early')
    await tick(150)

    expect(order).toEqual(['start-done', 'msg:early'])
    await system.shutdown()
  })

  test('context.self is available in start lifecycle', async () => {
    let selfName: string | null = null

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') selfName = ctx.self.name
        return { state }
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
// Actor: Async via pipeToSelf
// ═══════════════════════════════════════════════════════════════════

describe('Actor: async via pipeToSelf', () => {
  test('async results are delivered back as messages via pipeToSelf', async () => {
    const results: number[] = []

    type Msg =
      | { type: 'compute'; value: number }
      | { type: 'result'; total: number }

    const def: ActorDef<Msg, { total: number }> = {
      handler: (state, message, ctx) => {
        switch (message.type) {
          case 'compute': {
            const newTotal = state.total + message.value
            ctx.pipeToSelf(
              Promise.resolve(newTotal),
              (total) => ({ type: 'result', total }),
              () => ({ type: 'result', total: -1 }),
            )
            return { state: { total: newTotal } }
          }
          case 'result':
            results.push(message.total)
            return { state }
        }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('pipe-handler', def, { total: 0 })
    await tick()

    ref.send({ type: 'compute', value: 10 })
    ref.send({ type: 'compute', value: 20 })
    ref.send({ type: 'compute', value: 30 })
    await tick(200)

    expect(results).toEqual([10, 30, 60])
    await system.shutdown()
  })

  test('pipeToSelf does not block the message loop — handler returns immediately', async () => {
    const log: string[] = []

    type Msg =
      | { type: 'start'; label: string }
      | { type: 'done'; label: string }

    const def: ActorDef<Msg, null> = {
      handler: (state, msg, ctx) => {
        switch (msg.type) {
          case 'start':
            log.push(`start:${msg.label}`)
            ctx.pipeToSelf(
              Bun.sleep(30).then(() => msg.label),
              (label) => ({ type: 'done', label }),
              () => ({ type: 'done', label: msg.label }),
            )
            return { state }
          case 'done':
            log.push(`done:${msg.label}`)
            return { state }
        }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('non-blocking', def, null)
    await tick()

    ref.send({ type: 'start', label: 'a' })
    ref.send({ type: 'start', label: 'b' })
    await tick(200)

    // Both starts happen immediately, then both dones arrive later
    expect(log[0]).toBe('start:a')
    expect(log[1]).toBe('start:b')
    expect(log).toContain('done:a')
    expect(log).toContain('done:b')
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
