import { describe, test, expect } from 'bun:test'
import { createActorSystem, SystemLifecycleTopic, LogTopic } from '../system/index.ts'
import type { ActorDef, LifecycleEvent, LogEvent } from '../system/index.ts'

// ─── Helpers ───

/** Small delay to let async actor processing settle */
const tick = (ms = 50) => Bun.sleep(ms)

/** Creates a simple actor def that throws on a specific "poison" message */
const failingActorDef = (
  opts: {
    supervision?: ActorDef<string, { count: number }>['supervision']
    onSetup?: () => void
    onMessage?: (msg: string) => void
    onStopped?: () => void
  } = {},
): ActorDef<string, { count: number }> => ({
  supervision: opts.supervision,

  setup: (state, _ctx) => {
    opts.onSetup?.()
    return state
  },

  handler: (state, message, _ctx) => {
    if (message === 'POISON') {
      throw new Error('Poisoned!')
    }
    opts.onMessage?.(message)
    return { state: { count: state.count + 1 } }
  },

  lifecycle: (state, event, _ctx) => {
    if (event.type === 'stopped') {
      opts.onStopped?.()
    }
    return { state }
  },
})

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe('Supervision: stop strategy (default)', () => {
  test('actor stops on failure when no strategy is configured', async () => {
    const events: LifecycleEvent[] = []
    const system = createActorSystem()
    system.subscribe('test', SystemLifecycleTopic, (e) => events.push(e as LifecycleEvent))

    const ref = system.spawn('stopper', failingActorDef(), { count: 0 })

    await tick()

    // Send a normal message then a poison message
    ref.send('hello')
    ref.send('POISON')

    await tick(200)

    // The actor should have terminated — we expect a terminated event with reason 'failed'
    const terminated = events.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(1)
    if (terminated[0]!.type === 'terminated') {
      expect(terminated[0]!.ref.name).toBe('system/stopper')
      expect(terminated[0]!.reason).toBe('failed')
      expect(terminated[0]!.error).toBeInstanceOf(Error)
    }

    await system.shutdown()
  })

  test('messages after failure are silently dropped', async () => {
    const received: string[] = []
    const system = createActorSystem()

    const ref = system.spawn(
      'drop-after-fail',
      failingActorDef({ onMessage: (m) => received.push(m) }),
      { count: 0 },
    )

    await tick()

    ref.send('first')
    ref.send('POISON')
    ref.send('should-not-arrive')

    await tick(200)

    expect(received).toEqual(['first'])

    await system.shutdown()
  })
})

describe('Supervision: restart strategy', () => {
  test('actor restarts and continues processing after failure', async () => {
    const received: string[] = []
    let setupCount = 0

    const system = createActorSystem()

    const ref = system.spawn(
      'restarter',
      failingActorDef({
        supervision: { type: 'restart' },
        onSetup: () => { setupCount++ },
        onMessage: (m) => received.push(m),
      }),
      { count: 0 },
    )

    await tick()

    ref.send('before')
    ref.send('POISON')       // This triggers restart
    ref.send('after-restart') // This should still be processed

    await tick(200)

    expect(received).toContain('before')
    expect(received).toContain('after-restart')
    // setup runs once on initial start, and once on restart = 2
    expect(setupCount).toBe(2)

    await system.shutdown()
  })

  test('actor can survive multiple failures with unlimited restarts', async () => {
    const received: string[] = []
    let setupCount = 0

    const system = createActorSystem()

    const ref = system.spawn(
      'multi-restart',
      failingActorDef({
        supervision: { type: 'restart' },
        onSetup: () => { setupCount++ },
        onMessage: (m) => received.push(m),
      }),
      { count: 0 },
    )

    await tick()

    ref.send('a')
    ref.send('POISON')
    ref.send('b')
    ref.send('POISON')
    ref.send('c')
    ref.send('POISON')
    ref.send('d')

    await tick(300)

    expect(received).toEqual(['a', 'b', 'c', 'd'])
    // 1 initial setup + 3 restarts = 4
    expect(setupCount).toBe(4)

    await system.shutdown()
  })

  test('state resets to initialState on restart', async () => {
    const counts: number[] = []

    const def: ActorDef<string, { count: number }> = {
      supervision: { type: 'restart' },

      handler: (state, message) => {
        if (message === 'POISON') throw new Error('fail')
        const newCount = state.count + 1
        counts.push(newCount)
        return { state: { count: newCount } }
      },
    }

    const system = createActorSystem()

    const ref = system.spawn('state-reset', def, { count: 0 })

    await tick()

    ref.send('inc')    // count -> 1
    ref.send('inc')    // count -> 2
    ref.send('POISON') // restart, count -> 0
    ref.send('inc')    // count -> 1 (reset!)

    await tick(200)

    expect(counts).toEqual([1, 2, 1])

    await system.shutdown()
  })
})

describe('Supervision: restart with maxRetries', () => {
  test('actor stops after exceeding maxRetries', async () => {
    let setupCount = 0
    let stoppedCalled = false
    const events: LifecycleEvent[] = []

    const system = createActorSystem()
    system.subscribe('test', SystemLifecycleTopic, (e) => events.push(e as LifecycleEvent))

    const ref = system.spawn(
      'limited-restart',
      failingActorDef({
        supervision: { type: 'restart', maxRetries: 2 },
        onSetup: () => { setupCount++ },
        onStopped: () => { stoppedCalled = true },
      }),
      { count: 0 },
    )

    await tick()

    // 1st failure -> restart (retry 1/2)
    ref.send('POISON')
    await tick(100)

    // 2nd failure -> restart (retry 2/2)
    ref.send('POISON')
    await tick(100)

    // 3rd failure -> retries exhausted, should stop
    ref.send('POISON')
    await tick(200)

    // 1 initial + 2 restarts = 3
    expect(setupCount).toBe(3)
    expect(stoppedCalled).toBe(true)

    // Should have terminated event with reason 'failed'
    const failedEvents = events.filter(
      (e) => e.type === 'terminated' && e.reason === 'failed',
    )
    expect(failedEvents.length).toBe(1)

    await system.shutdown()
  })

  test('retry window allows retries after time elapses', async () => {
    let setupCount = 0

    const system = createActorSystem()

    const ref = system.spawn(
      'windowed-restart',
      failingActorDef({
        supervision: { type: 'restart', maxRetries: 2, withinMs: 200 },
        onSetup: () => { setupCount++ },
      }),
      { count: 0 },
    )

    await tick()

    // 2 failures within the window
    ref.send('POISON')
    await tick(50)
    ref.send('POISON')
    await tick(50)

    // Wait for the window to slide past
    await tick(250)

    // This failure should be allowed — old failures expired
    ref.send('POISON')
    await tick(100)

    // 1 initial + 3 restarts (window reset allowed the 3rd)
    expect(setupCount).toBe(4)

    await system.shutdown()
  })
})

describe('Supervision: child actor failure propagation via watch', () => {
  test('parent receives terminated event when child fails (stop strategy)', async () => {
    const parentEvents: LifecycleEvent[] = []

    const childDef: ActorDef<string, {}> = {
      // Default stop strategy — child stops on failure
      handler: (_state, message) => {
        if (message === 'POISON') throw new Error('child boom')
        return { state: {} }
      },
    }

    type ParentMsg = { type: 'spawn-child' } | { type: 'fail-child' }

    const parentDef: ActorDef<ParentMsg, { childRef: null | { name: string; send: (m: string) => void } }> = {
      handler: (state, message, context) => {
        switch (message.type) {
          case 'spawn-child': {
            const child = context.spawn('fragile', childDef, {})
            return { state: { childRef: child } }
          }
          case 'fail-child': {
            state.childRef?.send('POISON')
            return { state }
          }
        }
      },

      lifecycle: (state, event) => {
        parentEvents.push(event)
        return { state }
      },
    }

    const system = createActorSystem()

    const parent = system.spawn('parent', parentDef, { childRef: null })
    await tick()

    parent.send({ type: 'spawn-child' })
    await tick()

    parent.send({ type: 'fail-child' })
    await tick(200)

    const terminated = parentEvents.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(1)
    if (terminated[0]!.type === 'terminated') {
      expect(terminated[0]!.ref.name).toBe('system/parent/fragile')
      expect(terminated[0]!.reason).toBe('failed')
      expect(terminated[0]!.error).toBeInstanceOf(Error)
      expect((terminated[0]!.error as Error).message).toBe('child boom')
    }

    await system.shutdown()
  })

  test('parent receives terminated event when child is gracefully stopped', async () => {
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
      expect(terminated[0]!.ref.name).toBe('system/parent/kid')
      expect(terminated[0]!.reason).toBe('stopped')
    }

    await system.shutdown()
  })
})

describe('Supervision: normal operation unaffected', () => {
  test('actor with restart strategy works normally when no errors occur', async () => {
    const received: string[] = []

    const system = createActorSystem()

    const ref = system.spawn(
      'happy-path',
      failingActorDef({
        supervision: { type: 'restart', maxRetries: 3 },
        onMessage: (m) => received.push(m),
      }),
      { count: 0 },
    )

    await tick()

    ref.send('one')
    ref.send('two')
    ref.send('three')

    await tick(200)

    expect(received).toEqual(['one', 'two', 'three'])

    await system.shutdown()
  })

  test('system shutdown still works cleanly with supervision configured', async () => {
    const events: LifecycleEvent[] = []
    const system = createActorSystem()
    system.subscribe('test', SystemLifecycleTopic, (e) => events.push(e as LifecycleEvent))

    system.spawn(
      'clean-shutdown',
      failingActorDef({ supervision: { type: 'restart' } }),
      { count: 0 },
    )

    await tick()

    await system.shutdown()

    const terminated = events.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(1)
    if (terminated[0]!.type === 'terminated') {
      expect(terminated[0]!.reason).toBe('stopped')
    }
  })
})

describe('Supervision: setup failure during restart', () => {
  test('actor terminates with reason failed when setup throws on restart', async () => {
    const lifecycleEvents: LifecycleEvent[] = []
    const logs: LogEvent[] = []
    let setupCallCount = 0

    const system = createActorSystem()
    system.subscribe('test-lifecycle', SystemLifecycleTopic, (e) => lifecycleEvents.push(e as LifecycleEvent))
    system.subscribe('test-logs', LogTopic, (e) => logs.push(e))

    const def: ActorDef<string, null> = {
      supervision: { type: 'restart' },

      setup: (state, _ctx) => {
        setupCallCount++
        // Throw on the second call (i.e., the restart), not the initial start
        if (setupCallCount > 1) {
          throw new Error('setup exploded during restart')
        }
        return state
      },

      handler: (_state, message) => {
        if (message === 'POISON') throw new Error('handler failed')
        return { state: null }
      },
    }

    const ref = system.spawn('setup-fail-restart', def, null)
    await tick()

    // Trigger a failure → restart → setup throws → actor should terminate
    ref.send('POISON')

    await tick(300)

    // 1. terminated event with reason 'failed'
    const terminated = lifecycleEvents.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(1)
    if (terminated[0]!.type === 'terminated') {
      expect(terminated[0]!.ref.name).toBe('system/setup-fail-restart')
      expect(terminated[0]!.reason).toBe('failed')
    }

    // 2. log.error was emitted for the restart setup failure
    const errorLogs = logs.filter(
      (l) =>
        l.level === 'error' &&
        l.source === 'system/setup-fail-restart' &&
        l.message.includes('setup threw during restart'),
    )
    expect(errorLogs.length).toBeGreaterThanOrEqual(1)

    // 3. Actor is no longer tracked in metrics after shutdown
    await system.shutdown()
    expect(system.getActorMetrics('system/setup-fail-restart')).toBeUndefined()
  })
})
