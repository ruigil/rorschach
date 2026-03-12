import { describe, test, expect } from 'bun:test'
import { createActorSystem } from '../system/index.ts'
import { createMailbox } from '../system/mailbox.ts'
import { STOP } from '../system/types.ts'
import type {
  ActorDef,
  ActorRef,
  LifecycleEvent,
} from '../system/index.ts'

// ─── Helpers ───

/** Small delay to let async actor processing settle */
const tick = (ms = 50) => Bun.sleep(ms)

// ═══════════════════════════════════════════════════════════════════
// Mailbox Tests
// ═══════════════════════════════════════════════════════════════════

describe('Mailbox', () => {
  test('enqueue and take deliver messages in FIFO order', async () => {
    const mb = createMailbox<string>()
    mb.enqueue('a')
    mb.enqueue('b')
    mb.enqueue('c')

    expect(await mb.take()).toBe('a')
    expect(await mb.take()).toBe('b')
    expect(await mb.take()).toBe('c')
  })

  test('take suspends until a message is enqueued', async () => {
    const mb = createMailbox<string>()
    let received = ''

    const promise = mb.take().then((v) => { received = String(v) })

    // Nothing yet — the consumer should be suspended
    await tick(10)
    expect(received).toBe('')

    mb.enqueue('hello')
    await promise

    expect(received).toBe('hello')
  })

  test('close returns STOP to a suspended consumer', async () => {
    const mb = createMailbox<string>()
    const promise = mb.take()

    mb.close()

    expect(await promise).toBe(STOP)
  })

  test('close returns STOP for subsequent takes on an empty mailbox', async () => {
    const mb = createMailbox<string>()
    mb.close()

    expect(await mb.take()).toBe(STOP)
    expect(await mb.take()).toBe(STOP)
  })

  test('messages enqueued after close are silently dropped', async () => {
    const mb = createMailbox<string>()
    mb.enqueue('before-close')
    mb.close()
    mb.enqueue('after-close')

    // Should get the buffered message, then STOP
    expect(await mb.take()).toBe('before-close')
    expect(await mb.take()).toBe(STOP)
  })

  test('STOP is queued when consumer is busy processing', async () => {
    const mb = createMailbox<string>()
    mb.enqueue('msg1')
    mb.close()

    // msg1 is in queue, and close should have enqueued STOP after it
    expect(await mb.take()).toBe('msg1')
    expect(await mb.take()).toBe(STOP)
  })

  test('immediate delivery when consumer is already waiting', async () => {
    const mb = createMailbox<string>()

    // Start waiting before enqueueing
    const promise = mb.take()

    // Enqueue while consumer is suspended — should resolve immediately
    mb.enqueue('immediate')

    expect(await promise).toBe('immediate')
  })
})

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

    expect(ref.name).toBe('named-actor')
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

    system.stop({ name: 'drop-test' })
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

    expect(selfName!).toBe('self-check')
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Actor: Lifecycle Events
// ═══════════════════════════════════════════════════════════════════

describe('Actor: lifecycle events', () => {
  test('system receives child-started when actor is spawned', async () => {
    const events: LifecycleEvent[] = []
    const system = createActorSystem((e) => events.push(e))

    system.spawn('starter', {
      handler: (state: null) => ({ state }),
    }, null)

    await tick()

    const started = events.filter((e) => e.type === 'child-started')
    expect(started.length).toBe(1)
    if (started[0]!.type === 'child-started') {
      expect(started[0]!.child.name).toBe('starter')
    }

    await system.shutdown()
  })

  test('system receives child-stopped when actor is stopped', async () => {
    const events: LifecycleEvent[] = []
    const system = createActorSystem((e) => events.push(e))

    system.spawn('stopper', {
      handler: (state: null) => ({ state }),
    }, null)

    await tick()

    system.stop({ name: 'stopper' })
    await tick()

    const stopped = events.filter((e) => e.type === 'child-stopped')
    expect(stopped.length).toBe(1)
    if (stopped[0]!.type === 'child-stopped') {
      expect(stopped[0]!.child.name).toBe('stopper')
    }

    await system.shutdown()
  })

  test('actor lifecycle handler receives "stopped" event on shutdown', async () => {
    let stoppedReceived = false

    const def: ActorDef<string, null> = {
      handler: (state) => ({ state }),
      lifecycle: (state, event) => {
        if (event.type === 'stopped') {
          stoppedReceived = true
        }
        return { state }
      },
    }

    const system = createActorSystem()
    system.spawn('life', def, null)
    await tick()

    await system.shutdown()
    expect(stoppedReceived).toBe(true)
  })

  test('lifecycle events arrive in order: started then stopped', async () => {
    const eventTypes: string[] = []
    const system = createActorSystem((e) => eventTypes.push(e.type))

    system.spawn('ordered', {
      handler: (state: null) => ({ state }),
    }, null)

    await tick()
    await system.shutdown()

    expect(eventTypes).toEqual(['child-started', 'child-stopped'])
  })
})

// ═══════════════════════════════════════════════════════════════════
// Actor: Parent-Child Hierarchy
// ═══════════════════════════════════════════════════════════════════

describe('Actor: parent-child hierarchy', () => {
  test('parent can spawn a child actor from context', async () => {
    const childMessages: string[] = []
    let childRef: ActorRef<string> | null = null

    const childDef: ActorDef<string, null> = {
      handler: (state, message) => {
        childMessages.push(message)
        return { state }
      },
    }

    type ParentMsg = { type: 'spawn' } | { type: 'send-to-child'; text: string }

    const parentDef: ActorDef<ParentMsg, { child: ActorRef<string> | null }> = {
      handler: (state, message, context) => {
        if (message.type === 'spawn') {
          const child = context.spawn('worker', childDef, null)
          childRef = child
          return { state: { child } }
        }
        if (message.type === 'send-to-child' && state.child) {
          state.child.send(message.text)
          return { state }
        }
        return { state }
      },
    }

    const system = createActorSystem()
    const parent = system.spawn('parent', parentDef, { child: null })
    await tick()

    parent.send({ type: 'spawn' })
    await tick()

    expect(childRef).not.toBeNull()
    expect(childRef!.name).toBe('parent/worker')

    parent.send({ type: 'send-to-child', text: 'hi child' })
    await tick()

    expect(childMessages).toEqual(['hi child'])
    await system.shutdown()
  })

  test('child name is prefixed with parent name', async () => {
    let spawnedName: string | null = null

    const childDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const parentDef: ActorDef<'go', null> = {
      handler: (state, _msg, ctx) => {
        const child = ctx.spawn('nested', childDef, null)
        spawnedName = child.name
        return { state }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('root', parentDef, null)
    await tick()

    ref.send('go')
    await tick()

    expect(spawnedName).not.toBeNull()
    expect(spawnedName!).toBe('root/nested')
    await system.shutdown()
  })

  test('parent receives child-started lifecycle event when spawning a child', async () => {
    const parentEvents: LifecycleEvent[] = []

    const childDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const parentDef: ActorDef<'spawn', null> = {
      handler: (state, _msg, ctx) => {
        ctx.spawn('kid', childDef, null)
        return { state }
      },
      lifecycle: (state, event) => {
        parentEvents.push(event)
        return { state }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('parent', parentDef, null)
    await tick()

    ref.send('spawn')
    await tick(100)

    const childStarted = parentEvents.filter((e) => e.type === 'child-started')
    expect(childStarted.length).toBe(1)
    if (childStarted[0]!.type === 'child-started') {
      expect(childStarted[0]!.child.name).toBe('parent/kid')
    }

    await system.shutdown()
  })

  test('parent receives child-stopped lifecycle event when child is stopped', async () => {
    const parentEvents: LifecycleEvent[] = []

    const childDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const parentDef: ActorDef<'spawn' | 'stop-child', null> = {
      handler: (state, msg, ctx) => {
        if (msg === 'spawn') {
          ctx.spawn('kid', childDef, null)
        } else if (msg === 'stop-child') {
          ctx.stop({ name: 'parent/kid' })
        }
        return { state }
      },
      lifecycle: (state, event) => {
        parentEvents.push(event)
        return { state }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('parent', parentDef, null)
    await tick()

    ref.send('spawn')
    await tick(100)

    ref.send('stop-child')
    await tick(100)

    const childStopped = parentEvents.filter((e) => e.type === 'child-stopped')
    expect(childStopped.length).toBe(1)
    if (childStopped[0]!.type === 'child-stopped') {
      expect(childStopped[0]!.child.name).toBe('parent/kid')
    }

    await system.shutdown()
  })

  test('children are stopped top-down when parent stops', async () => {
    const stoppedOrder: string[] = []

    const grandchildDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
      lifecycle: (state, event) => {
        if (event.type === 'stopped') stoppedOrder.push('grandchild')
        return { state }
      },
    }

    const childDef: ActorDef<string, null> = {
      setup: (state, ctx) => {
        ctx.spawn('grandkid', grandchildDef, null)
        return state
      },
      handler: (state) => ({ state }),
      lifecycle: (state, event) => {
        if (event.type === 'stopped') stoppedOrder.push('child')
        return { state }
      },
    }

    const parentDef: ActorDef<string, null> = {
      setup: (state, ctx) => {
        ctx.spawn('kid', childDef, null)
        return state
      },
      handler: (state) => ({ state }),
      lifecycle: (state, event) => {
        if (event.type === 'stopped') stoppedOrder.push('parent')
        return { state }
      },
    }

    const system = createActorSystem()
    system.spawn('p', parentDef, null)
    await tick(100)

    await system.shutdown()
    await tick(100)

    // All three should have stopped
    expect(stoppedOrder).toContain('grandchild')
    expect(stoppedOrder).toContain('child')
    expect(stoppedOrder).toContain('parent')
  })

  test('spawning a child with a duplicate name throws', async () => {
    let error: Error | null = null

    const childDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const parentDef: ActorDef<'spawn', null> = {
      handler: (state, _msg, ctx) => {
        try {
          ctx.spawn('dup', childDef, null)
          ctx.spawn('dup', childDef, null) // duplicate
        } catch (e) {
          error = e as Error
        }
        return { state }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('parent', parentDef, null)
    await tick()

    ref.send('spawn')
    await tick()

    expect(error).not.toBeNull()
    expect(error!.message).toContain('already exists')
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Actor System
// ═══════════════════════════════════════════════════════════════════

describe('Actor system', () => {
  test('spawn returns a valid ActorRef', async () => {
    const system = createActorSystem()

    const ref = system.spawn('test', {
      handler: (state: null) => ({ state }),
    }, null)

    expect(ref).toBeDefined()
    expect(ref.name).toBe('test')
    expect(typeof ref.send).toBe('function')
    await system.shutdown()
  })

  test('spawning a top-level actor with a duplicate name throws', () => {
    const system = createActorSystem()

    system.spawn('same', {
      handler: (state: null) => ({ state }),
    }, null)

    expect(() => {
      system.spawn('same', {
        handler: (state: null) => ({ state }),
      }, null)
    }).toThrow('already exists')
  })

  test('spawning after shutdown throws', async () => {
    const system = createActorSystem()
    await system.shutdown()

    expect(() => {
      system.spawn('late', {
        handler: (state: null) => ({ state }),
      }, null)
    }).toThrow('shutting down')
  })

  test('shutdown stops all spawned actors', async () => {
    const stopped: string[] = []

    const makeDef = (name: string): ActorDef<string, null> => ({
      handler: (state) => ({ state }),
      lifecycle: (state, event) => {
        if (event.type === 'stopped') stopped.push(name)
        return { state }
      },
    })

    const system = createActorSystem()
    system.spawn('a', makeDef('a'), null)
    system.spawn('b', makeDef('b'), null)
    system.spawn('c', makeDef('c'), null)
    await tick()

    await system.shutdown()

    expect(stopped.sort()).toEqual(['a', 'b', 'c'])
  })

  test('double shutdown is idempotent', async () => {
    const events: LifecycleEvent[] = []
    const system = createActorSystem((e) => events.push(e))

    system.spawn('once', {
      handler: (state: null) => ({ state }),
    }, null)
    await tick()

    await system.shutdown()
    const countAfterFirst = events.length

    await system.shutdown()
    expect(events.length).toBe(countAfterFirst)
  })

  test('system.stop removes a specific actor', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      handler: (state, msg) => {
        received.push(msg)
        return { state }
      },
    }

    const system = createActorSystem()
    const refA = system.spawn('a', def, null)
    const refB = system.spawn('b', def, null)
    await tick()

    refA.send('a1')
    refB.send('b1')
    await tick()

    system.stop({ name: 'a' })
    await tick()

    refA.send('a2') // should be dropped
    refB.send('b2') // should arrive
    await tick()

    expect(received).toContain('a1')
    expect(received).toContain('b1')
    expect(received).toContain('b2')
    expect(received).not.toContain('a2')

    await system.shutdown()
  })

  test('multiple actors can run concurrently and independently', async () => {
    const log: string[] = []

    const makeDef = (prefix: string): ActorDef<string, null> => ({
      handler: (state, msg) => {
        log.push(`${prefix}:${msg}`)
        return { state }
      },
    })

    const system = createActorSystem()
    const refX = system.spawn('x', makeDef('x'), null)
    const refY = system.spawn('y', makeDef('y'), null)
    await tick()

    refX.send('1')
    refY.send('1')
    refX.send('2')
    refY.send('2')
    await tick()

    expect(log).toContain('x:1')
    expect(log).toContain('x:2')
    expect(log).toContain('y:1')
    expect(log).toContain('y:2')

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
  test('lifecycle handler can evolve state', async () => {
    const snapshots: string[][] = []

    const childDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    type Msg = 'spawn' | 'snapshot'

    const parentDef: ActorDef<Msg, { events: string[] }> = {
      handler: (state, msg, ctx) => {
        if (msg === 'spawn') {
          ctx.spawn('child', childDef, null)
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

    ref.send('snapshot')
    await tick(100)

    expect(snapshots.length).toBe(1)
    expect(snapshots[0]).toContain('child-started')

    await system.shutdown()
  })
})
