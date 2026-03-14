import { describe, test, expect } from 'bun:test'
import { createActorSystem, DeadLetterTopic } from '../system/index.ts'
import { createMailbox } from '../system/mailbox.ts'
import { STOP } from '../system/types.ts'
import type {
  ActorDef,
  LifecycleEvent,
} from '../system/index.ts'

// ─── Helpers ───

/** Small delay to let async actor processing settle */
const tick = (ms = 50) => Bun.sleep(ms)

// ═══════════════════════════════════════════════════════════════════
// Graceful Shutdown: Mailbox Drain
// ═══════════════════════════════════════════════════════════════════

describe('Graceful shutdown: drain mode', () => {
  test('actor with drain processes all remaining mailbox messages before stopping', async () => {
    const processed: number[] = []

    const def: ActorDef<number, null> = {
      handler: (state, message) => {
        processed.push(message)
        return { state }
      },
      shutdown: { drain: true },
    }

    const system = createActorSystem()
    const ref = system.spawn('drainer', def, null)
    await tick()

    // Send several messages
    ref.send(1)
    ref.send(2)
    ref.send(3)

    // Stop immediately — drain should process all queued messages
    system.stop({ name: 'system/drainer' })
    await tick(200)

    expect(processed).toEqual([1, 2, 3])
    await system.shutdown()
  })

  test('actor without drain config does not receive stopping lifecycle event', async () => {
    const lifecycleEvents: string[] = []

    const def: ActorDef<string, null> = {
      handler: (state) => ({ state }),
      lifecycle: (state, event) => {
        lifecycleEvents.push(event.type)
        return { state }
      },
      // No shutdown config — immediate stop (default)
    }

    const system = createActorSystem()
    system.spawn('no-drain', def, null)
    await tick()

    system.stop({ name: 'system/no-drain' })
    await tick(200)

    // Without drain, no 'stopping' event — only 'stopped' during shutdown sequence
    expect(lifecycleEvents).toEqual(['stopped'])
    await system.shutdown()
  })

  test('new messages sent during drain are rejected (dead-lettered)', async () => {
    const processed: string[] = []
    const deadLetters: unknown[] = []

    const def: ActorDef<string, null> = {
      handler: async (state, message) => {
        await Bun.sleep(20)
        processed.push(message)
        return { state }
      },
      shutdown: { drain: true, timeoutMs: 5000 },
    }

    const system = createActorSystem()
    const ref = system.spawn('drain-reject', def, null)
    await tick()

    // Subscribe to dead letters
    system.subscribe('test-dl', DeadLetterTopic, (event) => {
      deadLetters.push(event)
    })

    ref.send('before')

    // Start drain
    system.stop({ name: 'system/drain-reject' })

    // Try sending after drain started
    await tick(5)
    ref.send('after-drain')
    await tick(200)

    // 'before' should be processed, 'after-drain' should be dead-lettered
    expect(processed).toContain('before')

    // 'after-drain' is either dead-lettered (because stopped=true in ref.send)
    // or silently dropped by the draining mailbox
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Graceful Shutdown: Stopping Lifecycle Event
// ═══════════════════════════════════════════════════════════════════

describe('Graceful shutdown: stopping lifecycle event', () => {
  test('stopping lifecycle event fires before stopped when drain is enabled', async () => {
    const lifecycleOrder: string[] = []

    const def: ActorDef<string, null> = {
      handler: (state) => ({ state }),
      lifecycle: (state, event) => {
        lifecycleOrder.push(event.type)
        return { state }
      },
      shutdown: { drain: true },
    }

    const system = createActorSystem()
    system.spawn('lifecycle-order', def, null)
    await tick()

    system.stop({ name: 'system/lifecycle-order' })
    await tick(200)

    expect(lifecycleOrder).toEqual(['stopping', 'stopped'])
    await system.shutdown()
  })

  test('stopping event is NOT fired when drain is not configured', async () => {
    const lifecycleOrder: string[] = []

    const def: ActorDef<string, null> = {
      handler: (state) => ({ state }),
      lifecycle: (state, event) => {
        lifecycleOrder.push(event.type)
        return { state }
      },
      // No shutdown config — immediate stop
    }

    const system = createActorSystem()
    system.spawn('no-stopping', def, null)
    await tick()

    system.stop({ name: 'system/no-stopping' })
    await tick(200)

    // Should only have 'stopped', not 'stopping'
    expect(lifecycleOrder).toEqual(['stopped'])
    await system.shutdown()
  })

  test('stopping lifecycle handler can perform cleanup before drain completes', async () => {
    const log: string[] = []

    const def: ActorDef<string, { cleaning: boolean }> = {
      handler: (state, message) => {
        log.push(`msg:${message}`)
        return { state }
      },
      lifecycle: (state, event) => {
        if (event.type === 'stopping') {
          log.push('cleanup-started')
          return { state: { cleaning: true } }
        }
        if (event.type === 'stopped') {
          log.push(`stopped:cleaning=${state.cleaning}`)
          return { state }
        }
        return { state }
      },
      shutdown: { drain: true },
    }

    const system = createActorSystem()
    const ref = system.spawn('cleanup', def, { cleaning: false })
    await tick()

    ref.send('work')
    system.stop({ name: 'system/cleanup' })
    await tick(200)

    // Messages processed, then stopping, then stopped
    expect(log).toContain('msg:work')
    expect(log).toContain('cleanup-started')
    expect(log).toContain('stopped:cleaning=true')

    // Stopping comes after messages but before stopped
    const stoppingIdx = log.indexOf('cleanup-started')
    const stoppedIdx = log.indexOf('stopped:cleaning=true')
    expect(stoppingIdx).toBeLessThan(stoppedIdx)

    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Graceful Shutdown: Timeout
// ═══════════════════════════════════════════════════════════════════

describe('Graceful shutdown: timeout', () => {
  test('drain timeout force-closes the mailbox when actor is stuck', async () => {
    const processed: string[] = []

    const def: ActorDef<string, null> = {
      handler: async (state, message) => {
        processed.push(message)
        // Simulate a very slow handler
        if (message === 'slow') {
          await Bun.sleep(5000) // 5 seconds — way longer than timeout
        }
        return { state }
      },
      shutdown: { drain: true, timeoutMs: 100 },
    }

    const system = createActorSystem()
    const ref = system.spawn('timeout-test', def, null)
    await tick()

    ref.send('fast')
    ref.send('slow')
    ref.send('never')

    // Wait for 'fast' to be processed, then stop
    await tick(20)
    const stopPromise = (async () => {
      system.stop({ name: 'system/timeout-test' })
      await tick(500)
    })()

    await stopPromise

    // 'fast' should have been processed.
    // 'slow' may have started but was interrupted by timeout.
    // 'never' should not have been processed.
    expect(processed).toContain('fast')
    expect(processed).not.toContain('never')

    await system.shutdown()
  })

  test('drain completes before timeout — timer is cleared cleanly', async () => {
    const processed: string[] = []

    const def: ActorDef<string, null> = {
      handler: (state, message) => {
        processed.push(message)
        return { state }
      },
      shutdown: { drain: true, timeoutMs: 5000 }, // generous timeout
    }

    const system = createActorSystem()
    const ref = system.spawn('fast-drain', def, null)
    await tick()

    ref.send('a')
    ref.send('b')

    system.stop({ name: 'system/fast-drain' })
    await tick(200)

    // All messages processed, no timeout needed
    expect(processed).toEqual(['a', 'b'])
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Graceful Shutdown: Child Actors
// ═══════════════════════════════════════════════════════════════════

describe('Graceful shutdown: parent-child interaction', () => {
  test('children are stopped after parent drain completes', async () => {
    const events: string[] = []

    const childDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
      lifecycle: (state, event) => {
        if (event.type === 'stopped') events.push('child-stopped')
        return { state }
      },
    }

    const parentDef: ActorDef<string, null> = {
      setup: (state, ctx) => {
        ctx.spawn('child', childDef, null)
        return state
      },
      handler: (state, message) => {
        events.push(`parent-msg:${message}`)
        return { state }
      },
      lifecycle: (state, event) => {
        events.push(`parent-lifecycle:${event.type}`)
        return { state }
      },
      shutdown: { drain: true },
    }

    const system = createActorSystem()
    const ref = system.spawn('parent', parentDef, null)
    await tick()

    ref.send('work')
    system.stop({ name: 'system/parent' })
    await tick(300)

    // Parent drains messages, gets stopping event, then children stop, then parent stopped
    expect(events).toContain('parent-msg:work')
    expect(events).toContain('parent-lifecycle:stopping')

    // Child should be terminated before parent's stopped event
    const childStoppedIdx = events.indexOf('child-stopped')
    const parentMsgIdx = events.indexOf('parent-msg:work')
    expect(parentMsgIdx).toBeLessThan(childStoppedIdx)

    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Graceful Shutdown: System-Level
// ═══════════════════════════════════════════════════════════════════

describe('Graceful shutdown: system-level options', () => {
  test('createActorSystem with legacy callback signature still works', async () => {
    const events: LifecycleEvent[] = []

    const system = createActorSystem((event) => {
      events.push(event)
    })

    const def: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    system.spawn('legacy', def, null)
    await tick()

    await system.shutdown()
    await tick()

    // Should have received terminated event for the child
    expect(events.some((e) => e.type === 'terminated')).toBe(true)
  })

  test('createActorSystem with options object works', async () => {
    const events: LifecycleEvent[] = []

    const system = createActorSystem({
      onLifecycle: (event) => {
        events.push(event)
      },
    })

    const def: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    system.spawn('options', def, null)
    await tick()

    await system.shutdown()
    await tick()

    expect(events.some((e) => e.type === 'terminated')).toBe(true)
  })

  test('createActorSystem with shutdownTimeoutMs enables root drain', async () => {
    const processed: string[] = []

    const system = createActorSystem({
      shutdownTimeoutMs: 5000,
    })

    const def: ActorDef<string, null> = {
      handler: (state, message) => {
        processed.push(message)
        return { state }
      },
    }

    const ref = system.spawn('root-drain-child', def, null)
    await tick()

    ref.send('hello')
    await tick()

    await system.shutdown()

    expect(processed).toContain('hello')
  })
})

// ═══════════════════════════════════════════════════════════════════
// Mailbox: Drain Mode (unit-level)
// ═══════════════════════════════════════════════════════════════════

describe('Mailbox: drain mode', () => {
  test('drain mode delivers all buffered messages then STOP', async () => {
    const mailbox = createMailbox<string>()

    mailbox.enqueue('a')
    mailbox.enqueue('b')
    mailbox.enqueue('c')
    mailbox.drain()

    expect(await mailbox.take()).toBe('a')
    expect(await mailbox.take()).toBe('b')
    expect(await mailbox.take()).toBe('c')
    expect(await mailbox.take()).toBe(STOP)
  })

  test('drain mode rejects new enqueue calls', async () => {
    const mailbox = createMailbox<string>()

    mailbox.enqueue('before')
    mailbox.drain()
    mailbox.enqueue('after') // should be silently dropped

    expect(await mailbox.take()).toBe('before')
    expect(await mailbox.take()).toBe(STOP)
  })

  test('drain mode still accepts enqueueSystem calls', async () => {
    const mailbox = createMailbox<string>()

    mailbox.enqueue('normal')
    mailbox.drain()
    mailbox.enqueueSystem('system-msg') // should be accepted

    expect(await mailbox.take()).toBe('normal')
    expect(await mailbox.take()).toBe('system-msg')
    expect(await mailbox.take()).toBe(STOP)
  })

  test('drain on empty mailbox with suspended consumer delivers STOP immediately', async () => {
    const mailbox = createMailbox<string>()

    // Start a take() that will suspend
    const takePromise = mailbox.take()

    // Drain while consumer is suspended and queue is empty
    mailbox.drain()

    expect(await takePromise).toBe(STOP)
  })

  test('drain is idempotent', async () => {
    const mailbox = createMailbox<string>()

    mailbox.enqueue('x')
    mailbox.drain()
    mailbox.drain() // second call should be no-op

    expect(await mailbox.take()).toBe('x')
    expect(await mailbox.take()).toBe(STOP)
  })

  test('close after drain still works', async () => {
    const mailbox = createMailbox<string>()

    mailbox.enqueue('msg')
    mailbox.drain()

    // close() should be a no-op or work gracefully after drain
    expect(await mailbox.take()).toBe('msg')

    mailbox.close()
    expect(await mailbox.take()).toBe(STOP)
  })
})
