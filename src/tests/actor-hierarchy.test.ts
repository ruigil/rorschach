import { describe, test, expect } from 'bun:test'
import { createPluginSystem } from '../system/index.ts'
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

    const system = await createPluginSystem()
    const parent = system.spawn('parent', parentDef, { child: null })
    await tick()

    parent.send({ type: 'spawn' })
    await tick()

    expect(childRef).not.toBeNull()
    expect(childRef!.name).toBe('system/parent/worker')

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

    const system = await createPluginSystem()
    const ref = system.spawn('root', parentDef, null)
    await tick()

    ref.send('go')
    await tick()

    expect(spawnedName).not.toBeNull()
    expect(spawnedName!).toBe('system/root/nested')
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
          ctx.stop({ name: 'system/parent/kid' })
        }
        return { state }
      },
      lifecycle: (state, event) => {
        parentEvents.push(event)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('parent', parentDef, null)
    await tick()

    ref.send('spawn')
    await tick(100)

    ref.send('stop-child')
    await tick(100)

    const terminated = parentEvents.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(1)
    if (terminated[0]!.type === 'terminated') {
      expect(terminated[0]!.ref.name).toBe('system/parent/kid')
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
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') ctx.spawn('grandkid', grandchildDef, null)
        if (event.type === 'stopped') stoppedOrder.push('child')
        return { state }
      },
      handler: (state) => ({ state }),
    }

    const parentDef: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') ctx.spawn('kid', childDef, null)
        if (event.type === 'stopped') stoppedOrder.push('parent')
        return { state }
      },
      handler: (state) => ({ state }),
    }

    const system = await createPluginSystem()
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

    const system = await createPluginSystem()
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
// Watch: Cross-Hierarchy Observation
// ═══════════════════════════════════════════════════════════════════

describe('Watch: cross-hierarchy observation', () => {
  test('actor can watch an unrelated actor and receive terminated event', async () => {
    const watcherEvents: LifecycleEvent[] = []

    const targetDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const watcherDef: ActorDef<ActorRef<string>, null> = {
      handler: (state, ref, ctx) => {
        ctx.watch(ref)
        return { state }
      },
      lifecycle: (state, event) => {
        watcherEvents.push(event)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const targetRef = system.spawn('target', targetDef, null)
    const watcher = system.spawn('watcher', watcherDef, null)
    await tick()

    watcher.send(targetRef)
    await tick()

    // Stop the target — watcher should receive terminated
    system.stop({ name: 'system/target' })
    await tick(100)

    const terminated = watcherEvents.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(1)
    if (terminated[0]!.type === 'terminated') {
      expect(terminated[0]!.ref.name).toBe('system/target')
      expect(terminated[0]!.reason).toBe('stopped')
    }

    await system.shutdown()
  })

  test('watching an already-dead actor delivers terminated immediately', async () => {
    const watcherEvents: LifecycleEvent[] = []

    const targetDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const watcherDef: ActorDef<ActorRef<string>, null> = {
      handler: (state, ref, ctx) => {
        // Target is already stopped — should get immediate terminated
        ctx.watch(ref)
        return { state }
      },
      lifecycle: (state, event) => {
        watcherEvents.push(event)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const targetRef = system.spawn('target', targetDef, null)
    await tick()

    // Stop target first
    system.stop({ name: 'system/target' })
    await tick(100)

    // Now spawn watcher and try to watch the dead target
    const watcher = system.spawn('watcher', watcherDef, null)
    await tick()

    watcher.send(targetRef)
    await tick()

    const terminated = watcherEvents.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(1)
    if (terminated[0]!.type === 'terminated') {
      expect(terminated[0]!.ref.name).toBe('system/target')
      expect(terminated[0]!.reason).toBe('stopped')
    }

    await system.shutdown()
  })

  test('unwatch prevents further terminated notifications', async () => {
    const watcherEvents: LifecycleEvent[] = []

    const targetDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    type WatcherMsg = { type: 'watch'; ref: ActorRef<string> } | { type: 'unwatch'; ref: ActorRef<string> }
    const watcherDef: ActorDef<WatcherMsg, null> = {
      handler: (state, msg, ctx) => {
        if (msg.type === 'watch') ctx.watch(msg.ref)
        else ctx.unwatch(msg.ref)
        return { state }
      },
      lifecycle: (state, event) => {
        watcherEvents.push(event)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const targetRef = system.spawn('target', targetDef, null)
    const watcher = system.spawn('watcher', watcherDef, null)
    await tick()

    watcher.send({ type: 'watch', ref: targetRef })
    await tick()

    watcher.send({ type: 'unwatch', ref: targetRef })
    await tick()

    // Stop target — watcher should NOT receive terminated (unwatched)
    system.stop({ name: 'system/target' })
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

    const watcherDef: ActorDef<ActorRef<string>, null> = {
      handler: (state, ref, ctx) => {
        ctx.watch(ref)
        return { state }
      },
      lifecycle: (state, event) => {
        watcherEvents.push(event)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const targetRef = system.spawn('target', targetDef, null)
    const watcher = system.spawn('watcher', watcherDef, null)
    await tick()

    // Watch twice
    watcher.send(targetRef)
    watcher.send(targetRef)
    await tick()

    system.stop({ name: 'system/target' })
    await tick(100)

    const terminated = watcherEvents.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(1)

    await system.shutdown()
  })

  test('watches are cleaned up when the watcher itself stops', async () => {
    // This test verifies no errors/dangling refs when watcher dies before target
    const system = await createPluginSystem()

    const targetDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const watcherDef: ActorDef<ActorRef<string>, null> = {
      handler: (state, ref, ctx) => {
        ctx.watch(ref)
        return { state }
      },
    }

    const targetRef = system.spawn('target', targetDef, null)
    const watcher = system.spawn('watcher', watcherDef, null)
    await tick()

    watcher.send(targetRef)
    await tick()

    // Stop watcher first — its watches should be cleaned up
    system.stop({ name: 'system/watcher' })
    await tick(100)

    // Stop target — should not cause any errors
    system.stop({ name: 'system/target' })
    await tick(100)

    await system.shutdown()
  })

  test('multiple actors can watch the same target', async () => {
    const eventsA: LifecycleEvent[] = []
    const eventsB: LifecycleEvent[] = []

    const targetDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    const makeWatcher = (events: LifecycleEvent[]): ActorDef<ActorRef<string>, null> => ({
      handler: (state, ref, ctx) => {
        ctx.watch(ref)
        return { state }
      },
      lifecycle: (state, event) => {
        events.push(event)
        return { state }
      },
    })

    const system = await createPluginSystem()
    const targetRef = system.spawn('target', targetDef, null)
    const watcherA = system.spawn('watcher-a', makeWatcher(eventsA), null)
    const watcherB = system.spawn('watcher-b', makeWatcher(eventsB), null)
    await tick()

    watcherA.send(targetRef)
    watcherB.send(targetRef)
    await tick()

    system.stop({ name: 'system/target' })
    await tick(100)

    const terminatedA = eventsA.filter((e) => e.type === 'terminated')
    const terminatedB = eventsB.filter((e) => e.type === 'terminated')
    expect(terminatedA.length).toBe(1)
    expect(terminatedB.length).toBe(1)

    await system.shutdown()
  })
})
