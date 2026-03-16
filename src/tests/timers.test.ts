import { describe, test, expect } from 'bun:test'
import { createPluginSystem } from '../system/index.ts'
import type { ActorDef } from '../system/index.ts'

/** Small delay to let async actor processing settle */
const tick = (ms = 50) => Bun.sleep(ms)

// ═══════════════════════════════════════════════════════════════════
// Timers: Single Timer
// ═══════════════════════════════════════════════════════════════════

describe('Timers: single timer', () => {
  test('startSingleTimer delivers a message after the delay', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') ctx.timers.startSingleTimer('ping', 'delayed-ping', 50)
        return { state }
      },
      handler: (state, msg) => {
        received.push(msg)
        return { state }
      },
    }

    const system = await createPluginSystem()
    system.spawn('single', def, null)
    await tick(150)

    expect(received).toEqual(['delayed-ping'])
    await system.shutdown()
  })

  test('single timer fires only once', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') ctx.timers.startSingleTimer('once', 'fire', 30)
        return { state }
      },
      handler: (state, msg) => {
        received.push(msg)
        return { state }
      },
    }

    const system = await createPluginSystem()
    system.spawn('once', def, null)
    await tick(200)

    expect(received).toEqual(['fire'])
    await system.shutdown()
  })

  test('single timer is no longer active after firing', async () => {
    let activeAfterFire = false

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') ctx.timers.startSingleTimer('check', 'go', 30)
        return { state }
      },
      handler: (state, msg, ctx) => {
        if (msg === 'go') {
          activeAfterFire = ctx.timers.isActive('check')
        }
        return { state }
      },
    }

    const system = await createPluginSystem()
    system.spawn('active-check', def, null)
    await tick(100)

    expect(activeAfterFire).toBe(false)
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Timers: Periodic Timer
// ═══════════════════════════════════════════════════════════════════

describe('Timers: periodic timer', () => {
  test('startPeriodicTimer delivers messages repeatedly', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') ctx.timers.startPeriodicTimer('tick', 'tick', 40)
        return { state }
      },
      handler: (state, msg) => {
        received.push(msg)
        return { state }
      },
    }

    const system = await createPluginSystem()
    system.spawn('periodic', def, null)
    await tick(250)

    // With 40ms interval over ~250ms, expect at least 3 deliveries
    expect(received.length).toBeGreaterThanOrEqual(3)
    expect(received.every((m) => m === 'tick')).toBe(true)
    await system.shutdown()
  })

  test('periodic timer remains active between firings', async () => {
    let checkedActive = false

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') ctx.timers.startPeriodicTimer('poll', 'poll', 30)
        return { state }
      },
      handler: (state, _msg, ctx) => {
        if (!checkedActive) {
          checkedActive = true
          expect(ctx.timers.isActive('poll')).toBe(true)
        }
        return { state }
      },
    }

    const system = await createPluginSystem()
    system.spawn('periodic-active', def, null)
    await tick(100)

    expect(checkedActive).toBe(true)
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Timers: Replacement (same key)
// ═══════════════════════════════════════════════════════════════════

describe('Timers: key replacement', () => {
  test('starting a timer with the same key replaces the previous one', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          // Start a timer, then immediately replace it with a different message
          ctx.timers.startSingleTimer('key', 'first', 30)
          ctx.timers.startSingleTimer('key', 'second', 60)
        }
        return { state }
      },
      handler: (state, msg) => {
        received.push(msg)
        return { state }
      },
    }

    const system = await createPluginSystem()
    system.spawn('replace', def, null)
    await tick(150)

    // Only the replacement timer should have fired
    expect(received).toEqual(['second'])
    await system.shutdown()
  })

  test('replacing a periodic timer with a single timer works', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          ctx.timers.startPeriodicTimer('key', 'periodic', 20)
          // Immediately replace with a single timer
          ctx.timers.startSingleTimer('key', 'single', 80)
        }
        return { state }
      },
      handler: (state, msg) => {
        received.push(msg)
        return { state }
      },
    }

    const system = await createPluginSystem()
    system.spawn('replace-type', def, null)
    await tick(200)

    // The periodic timer was cancelled; only the single timer fires
    expect(received).toEqual(['single'])
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Timers: Cancel
// ═══════════════════════════════════════════════════════════════════

describe('Timers: cancel', () => {
  test('cancel prevents a single timer from firing', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          ctx.timers.startSingleTimer('cancel-me', 'nope', 50)
          ctx.timers.cancel('cancel-me')
        }
        return { state }
      },
      handler: (state, msg) => {
        received.push(msg)
        return { state }
      },
    }

    const system = await createPluginSystem()
    system.spawn('cancel-single', def, null)
    await tick(150)

    expect(received).toEqual([])
    await system.shutdown()
  })

  test('cancel stops a periodic timer', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') ctx.timers.startPeriodicTimer('stop-me', 'tick', 20)
        return { state }
      },
      handler: (state, msg, ctx) => {
        received.push(msg)
        // Cancel after first tick
        if (received.length === 1) {
          ctx.timers.cancel('stop-me')
        }
        return { state }
      },
    }

    const system = await createPluginSystem()
    system.spawn('cancel-periodic', def, null)
    await tick(200)

    // Should have received exactly 1 tick before cancellation
    expect(received).toEqual(['tick'])
    await system.shutdown()
  })

  test('cancel on non-existent key is a no-op', async () => {
    let setupCompleted = false

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          ctx.timers.cancel('does-not-exist') // should not throw
          setupCompleted = true
        }
        return { state }
      },
      handler: (state) => ({ state }),
    }

    const system = await createPluginSystem()
    system.spawn('cancel-noop', def, null)
    await tick()

    expect(setupCompleted).toBe(true)
    await system.shutdown()
  })

  test('cancelAll clears all active timers', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          ctx.timers.startSingleTimer('a', 'timer-a', 50)
          ctx.timers.startSingleTimer('b', 'timer-b', 60)
          ctx.timers.startPeriodicTimer('c', 'timer-c', 30)
          ctx.timers.cancelAll()
        }
        return { state }
      },
      handler: (state, msg) => {
        received.push(msg)
        return { state }
      },
    }

    const system = await createPluginSystem()
    system.spawn('cancel-all', def, null)
    await tick(200)

    expect(received).toEqual([])
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Timers: isActive
// ═══════════════════════════════════════════════════════════════════

describe('Timers: isActive', () => {
  test('isActive returns true for an active timer', async () => {
    let active = false

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          ctx.timers.startSingleTimer('check', 'msg', 500)
          active = ctx.timers.isActive('check')
        }
        return { state }
      },
      handler: (state) => ({ state }),
    }

    const system = await createPluginSystem()
    system.spawn('is-active-true', def, null)
    await tick()

    expect(active).toBe(true)
    await system.shutdown()
  })

  test('isActive returns false for an unregistered key', async () => {
    let active = true

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') active = ctx.timers.isActive('nonexistent')
        return { state }
      },
      handler: (state) => ({ state }),
    }

    const system = await createPluginSystem()
    system.spawn('is-active-false', def, null)
    await tick()

    expect(active).toBe(false)
    await system.shutdown()
  })

  test('isActive returns false after cancel', async () => {
    let activeAfterCancel = true

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          ctx.timers.startSingleTimer('k', 'msg', 500)
          ctx.timers.cancel('k')
          activeAfterCancel = ctx.timers.isActive('k')
        }
        return { state }
      },
      handler: (state) => ({ state }),
    }

    const system = await createPluginSystem()
    system.spawn('is-active-cancelled', def, null)
    await tick()

    expect(activeAfterCancel).toBe(false)
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Timers: Lifecycle Integration
// ═══════════════════════════════════════════════════════════════════

describe('Timers: lifecycle integration', () => {
  test('timers are cancelled when actor is stopped', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          ctx.timers.startSingleTimer('delayed', 'should-not-arrive', 200)
          ctx.timers.startPeriodicTimer('periodic', 'should-not-arrive', 200)
        }
        return { state }
      },
      handler: (state, msg) => {
        received.push(msg)
        return { state }
      },
    }

    const system = await createPluginSystem()
    system.spawn('stop-cancels', def, null)
    await tick()

    // Stop the actor before timers fire
    system.stop({ name: 'system/stop-cancels' })
    await tick(400)

    expect(received).toEqual([])
    await system.shutdown()
  })

  test('timers are cancelled when system shuts down', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') ctx.timers.startPeriodicTimer('poll', 'poll', 200)
        return { state }
      },
      handler: (state, msg) => {
        received.push(msg)
        return { state }
      },
    }

    const system = await createPluginSystem()
    system.spawn('shutdown-cancels', def, null)
    await tick()

    await system.shutdown()
    await tick(400)

    expect(received).toEqual([])
  })

  test('timers are cancelled on restart (supervision)', async () => {
    const received: string[] = []
    let firstRun = true

    const def: ActorDef<string, null> = {
      supervision: { type: 'restart' },
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start' && firstRun) {
          // First run: start a timer that should be cancelled on restart
          ctx.timers.startSingleTimer('stale', 'stale-msg', 150)
          firstRun = false
        }
        return { state }
      },
      handler: (state, msg) => {
        if (msg === 'crash') {
          throw new Error('boom')
        }
        received.push(msg)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('restart-cancels', def, null)
    await tick()

    // Trigger a restart — this should cancel the timer set in setup
    ref.send('crash')
    await tick(300)

    // The stale timer from the first setup should not have delivered
    expect(received).not.toContain('stale-msg')
    await system.shutdown()
  })

  test('timers can be re-established after restart via start lifecycle', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      supervision: { type: 'restart' },
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          // Every start/restart sets up the same timer
          ctx.timers.startSingleTimer('hello', 'hello', 50)
        }
        return { state }
      },
      handler: (state, msg) => {
        if (msg === 'crash') {
          throw new Error('boom')
        }
        received.push(msg)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('restart-resets', def, null)
    await tick(150)

    // First timer fires
    expect(received).toEqual(['hello'])

    // Trigger restart
    ref.send('crash')
    await tick(150)

    // Timer re-established after restart fires again
    expect(received).toEqual(['hello', 'hello'])
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Timers: Message Interleaving
// ═══════════════════════════════════════════════════════════════════

describe('Timers: message interleaving', () => {
  test('timer messages interleave with regular messages in order', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') ctx.timers.startSingleTimer('delayed', 'timer-msg', 80)
        return { state }
      },
      handler: (state, msg) => {
        received.push(msg)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('interleave', def, null)
    await tick()

    ref.send('early')
    await tick(150)

    // 'early' should arrive before the timer message
    expect(received[0]).toBe('early')
    expect(received).toContain('timer-msg')
    expect(received.length).toBe(2)
    await system.shutdown()
  })

  test('timer started from handler delivers to same actor', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      handler: (state, msg, ctx) => {
        if (msg === 'start') {
          ctx.timers.startSingleTimer('from-handler', 'scheduled', 30)
        }
        received.push(msg)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('handler-timer', def, null)
    await tick()

    ref.send('start')
    await tick(100)

    expect(received).toEqual(['start', 'scheduled'])
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Timers: Symbol Keys
// ═══════════════════════════════════════════════════════════════════

describe('Timers: symbol keys', () => {
  test('timers work with symbol keys', async () => {
    const TICK = Symbol('tick')
    const received: string[] = []

    const def: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          ctx.timers.startSingleTimer(TICK, 'sym-msg', 30)
          expect(ctx.timers.isActive(TICK)).toBe(true)
        }
        return { state }
      },
      handler: (state, msg, ctx) => {
        received.push(msg)
        expect(ctx.timers.isActive(TICK)).toBe(false)
        return { state }
      },
    }

    const system = await createPluginSystem()
    system.spawn('symbol-key', def, null)
    await tick(100)

    expect(received).toEqual(['sym-msg'])
    await system.shutdown()
  })
})
