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

  test('parent receives terminated event via implicit watch when child stops', async () => {
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

    const terminated = parentEvents.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(1)
    if (terminated[0]!.type === 'terminated') {
      expect(terminated[0]!.ref.name).toBe('parent/kid')
      expect(terminated[0]!.reason).toBe('stopped')
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
// Registry: Actor Lookup
// ═══════════════════════════════════════════════════════════════════

describe('Registry: actor lookup', () => {
  test('actor can look up another actor by name', async () => {
    const received: string[] = []

    const receiverDef: ActorDef<string, null> = {
      handler: (state, msg) => {
        received.push(msg)
        return { state }
      },
    }

    const senderDef: ActorDef<'go', null> = {
      handler: (state, _msg, ctx) => {
        const target = ctx.lookup<string>('receiver')
        if (target) {
          target.send('found you!')
        }
        return { state }
      },
    }

    const system = createActorSystem()
    system.spawn('receiver', receiverDef, null)
    await tick()

    const sender = system.spawn('sender', senderDef, null)
    await tick()

    sender.send('go')
    await tick()

    expect(received).toEqual(['found you!'])
    await system.shutdown()
  })

  test('lookup returns undefined for non-existent actors', async () => {
    let found = false

    const def: ActorDef<'check', null> = {
      handler: (state, _msg, ctx) => {
        found = ctx.lookup('nobody') !== undefined
        return { state }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('checker', def, null)
    await tick()

    ref.send('check')
    await tick()

    expect(found).toBe(false)
    await system.shutdown()
  })

  test('actor is unregistered after stopping', async () => {
    let foundBeforeStop = false
    let foundAfterStop = true // start true, expect it to become false

    const targetDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const checkerDef: ActorDef<'check-before' | 'check-after', null> = {
      handler: (state, msg, ctx) => {
        if (msg === 'check-before') {
          foundBeforeStop = ctx.lookup('target') !== undefined
        } else if (msg === 'check-after') {
          foundAfterStop = ctx.lookup('target') !== undefined
        }
        return { state }
      },
    }

    const system = createActorSystem()
    system.spawn('target', targetDef, null)
    const checker = system.spawn('checker', checkerDef, null)
    await tick()

    checker.send('check-before')
    await tick()

    system.stop({ name: 'target' })
    await tick(100)

    checker.send('check-after')
    await tick()

    expect(foundBeforeStop).toBe(true)
    expect(foundAfterStop).toBe(false)
    await system.shutdown()
  })

  test('child actors are discoverable via lookup with hierarchical name', async () => {
    let foundChild = false

    const childDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const parentDef: ActorDef<'spawn', null> = {
      setup: (state, ctx) => {
        ctx.spawn('worker', childDef, null)
        return state
      },
      handler: (state) => ({ state }),
    }

    const observerDef: ActorDef<'check', null> = {
      handler: (state, _msg, ctx) => {
        foundChild = ctx.lookup('parent/worker') !== undefined
        return { state }
      },
    }

    const system = createActorSystem()
    system.spawn('parent', parentDef, null)
    await tick(100)

    const observer = system.spawn('observer', observerDef, null)
    await tick()

    observer.send('check')
    await tick()

    expect(foundChild).toBe(true)
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Watch: Cross-Hierarchy Observation
// ═══════════════════════════════════════════════════════════════════

describe('Watch: cross-hierarchy observation', () => {
  test('actor can watch an unrelated actor and receive terminated event', async () => {
    const watcherEvents: LifecycleEvent[] = []

    const targetDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const watcherDef: ActorDef<'start-watching', null> = {
      handler: (state, _msg, ctx) => {
        ctx.watch({ name: 'target' })
        return { state }
      },
      lifecycle: (state, event) => {
        watcherEvents.push(event)
        return { state }
      },
    }

    const system = createActorSystem()
    system.spawn('target', targetDef, null)
    const watcher = system.spawn('watcher', watcherDef, null)
    await tick()

    watcher.send('start-watching')
    await tick()

    // Stop the target — watcher should receive terminated
    system.stop({ name: 'target' })
    await tick(100)

    const terminated = watcherEvents.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(1)
    if (terminated[0]!.type === 'terminated') {
      expect(terminated[0]!.ref.name).toBe('target')
      expect(terminated[0]!.reason).toBe('stopped')
    }

    await system.shutdown()
  })

  test('watching an already-dead actor delivers terminated immediately', async () => {
    const watcherEvents: LifecycleEvent[] = []

    const targetDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const watcherDef: ActorDef<'watch-dead', null> = {
      handler: (state, _msg, ctx) => {
        // Target is already stopped — should get immediate terminated
        ctx.watch({ name: 'target' })
        return { state }
      },
      lifecycle: (state, event) => {
        watcherEvents.push(event)
        return { state }
      },
    }

    const system = createActorSystem()
    system.spawn('target', targetDef, null)
    await tick()

    // Stop target first
    system.stop({ name: 'target' })
    await tick(100)

    // Now spawn watcher and try to watch the dead target
    const watcher = system.spawn('watcher', watcherDef, null)
    await tick()

    watcher.send('watch-dead')
    await tick()

    const terminated = watcherEvents.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(1)
    if (terminated[0]!.type === 'terminated') {
      expect(terminated[0]!.ref.name).toBe('target')
      expect(terminated[0]!.reason).toBe('stopped')
    }

    await system.shutdown()
  })

  test('unwatch prevents further terminated notifications', async () => {
    const watcherEvents: LifecycleEvent[] = []

    const targetDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const watcherDef: ActorDef<'watch' | 'unwatch', null> = {
      handler: (state, msg, ctx) => {
        if (msg === 'watch') {
          ctx.watch({ name: 'target' })
        } else if (msg === 'unwatch') {
          ctx.unwatch({ name: 'target' })
        }
        return { state }
      },
      lifecycle: (state, event) => {
        watcherEvents.push(event)
        return { state }
      },
    }

    const system = createActorSystem()
    system.spawn('target', targetDef, null)
    const watcher = system.spawn('watcher', watcherDef, null)
    await tick()

    watcher.send('watch')
    await tick()

    watcher.send('unwatch')
    await tick()

    // Stop target — watcher should NOT receive terminated (unwatched)
    system.stop({ name: 'target' })
    await tick(100)

    const terminated = watcherEvents.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(0)

    await system.shutdown()
  })

  test('watch is idempotent — duplicate watch does not cause double notification', async () => {
    const watcherEvents: LifecycleEvent[] = []

    const targetDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const watcherDef: ActorDef<'watch', null> = {
      handler: (state, _msg, ctx) => {
        ctx.watch({ name: 'target' })
        return { state }
      },
      lifecycle: (state, event) => {
        watcherEvents.push(event)
        return { state }
      },
    }

    const system = createActorSystem()
    system.spawn('target', targetDef, null)
    const watcher = system.spawn('watcher', watcherDef, null)
    await tick()

    // Watch twice
    watcher.send('watch')
    watcher.send('watch')
    await tick()

    system.stop({ name: 'target' })
    await tick(100)

    const terminated = watcherEvents.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(1)

    await system.shutdown()
  })

  test('watches are cleaned up when the watcher itself stops', async () => {
    // This test verifies no errors/dangling refs when watcher dies before target
    const system = createActorSystem()

    const targetDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const watcherDef: ActorDef<'watch', null> = {
      handler: (state, _msg, ctx) => {
        ctx.watch({ name: 'target' })
        return { state }
      },
    }

    system.spawn('target', targetDef, null)
    const watcher = system.spawn('watcher', watcherDef, null)
    await tick()

    watcher.send('watch')
    await tick()

    // Stop watcher first — its watches should be cleaned up
    system.stop({ name: 'watcher' })
    await tick(100)

    // Stop target — should not cause any errors
    system.stop({ name: 'target' })
    await tick(100)

    await system.shutdown()
  })

  test('multiple actors can watch the same target', async () => {
    const eventsA: LifecycleEvent[] = []
    const eventsB: LifecycleEvent[] = []

    const targetDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const makeWatcher = (events: LifecycleEvent[]): ActorDef<'watch', null> => ({
      handler: (state, _msg, ctx) => {
        ctx.watch({ name: 'target' })
        return { state }
      },
      lifecycle: (state, event) => {
        events.push(event)
        return { state }
      },
    })

    const system = createActorSystem()
    system.spawn('target', targetDef, null)
    const watcherA = system.spawn('watcher-a', makeWatcher(eventsA), null)
    const watcherB = system.spawn('watcher-b', makeWatcher(eventsB), null)
    await tick()

    watcherA.send('watch')
    watcherB.send('watch')
    await tick()

    system.stop({ name: 'target' })
    await tick(100)

    const terminatedA = eventsA.filter((e) => e.type === 'terminated')
    const terminatedB = eventsB.filter((e) => e.type === 'terminated')
    expect(terminatedA.length).toBe(1)
    expect(terminatedB.length).toBe(1)

    await system.shutdown()
  })
})
