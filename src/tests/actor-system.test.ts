import { describe, test, expect } from 'bun:test'
import { createPluginSystem, SystemLifecycleTopic } from '../system/index.ts'
import type {
  ActorDef,
  LifecycleEvent,
} from '../system/index.ts'

// ─── Helpers ───

/** Small delay to let async actor processing settle */
const tick = (ms = 50) => Bun.sleep(ms)

// ═══════════════════════════════════════════════════════════════════
// Actor: Lifecycle Events
// ═══════════════════════════════════════════════════════════════════

describe('Actor: lifecycle events', () => {
  test('system receives terminated event when actor stops', async () => {
    const events: LifecycleEvent[] = []
    const system = await createPluginSystem()
    system.subscribe(SystemLifecycleTopic, (e) => events.push(e as LifecycleEvent))

    system.spawn('stopper', {
      handler: (state: null) => ({ state }),
    }, null)

    await tick()

    system.stop({ name: 'system/stopper' })
    await tick()

    const terminated = events.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(1)
    if (terminated[0]!.type === 'terminated') {
      expect(terminated[0]!.ref.name).toBe('system/stopper')
      expect(terminated[0]!.reason).toBe('stopped')
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

    const system = await createPluginSystem()
    system.spawn('life', def, null)
    await tick()

    await system.shutdown()
    expect(stoppedReceived).toBe(true)
  })

  test('system receives terminated event on shutdown', async () => {
    const eventTypes: string[] = []
    const system = await createPluginSystem()
    system.subscribe( SystemLifecycleTopic, (e) => eventTypes.push((e as LifecycleEvent).type))

    system.spawn('ordered', {
      handler: (state: null) => ({ state }),
    }, null)

    await tick()
    await system.shutdown()

    expect(eventTypes).toEqual(['terminated'])
  })
})

// ═══════════════════════════════════════════════════════════════════
// Actor System
// ═══════════════════════════════════════════════════════════════════

describe('Actor system', () => {
  test('spawn returns a valid ActorRef', async () => {
    const system = await createPluginSystem()

    const ref = system.spawn('test', {
      handler: (state: null) => ({ state }),
    }, null)

    expect(ref).toBeDefined()
    expect(ref.name).toBe('system/test')
    expect(typeof ref.send).toBe('function')
    await system.shutdown()
  })

  test('spawning a top-level actor with a duplicate name throws', async () => {
    const system = await createPluginSystem()

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
    const system = await createPluginSystem()
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

    const system = await createPluginSystem()
    system.spawn('a', makeDef('a'), null)
    system.spawn('b', makeDef('b'), null)
    system.spawn('c', makeDef('c'), null)
    await tick()

    await system.shutdown()

    expect(stopped.sort()).toEqual(['a', 'b', 'c'])
  })

  test('double shutdown is idempotent', async () => {
    const events: LifecycleEvent[] = []
    const system = await createPluginSystem()
    system.subscribe(SystemLifecycleTopic, (e) => events.push(e as LifecycleEvent))

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

    const system = await createPluginSystem()
    const refA = system.spawn('a', def, null)
    const refB = system.spawn('b', def, null)
    await tick()

    refA.send('a1')
    refB.send('b1')
    await tick()

    system.stop({ name: 'system/a' })
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

    const system = await createPluginSystem()
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
