import { describe, test, expect } from 'bun:test'
import { createActorSystem } from '../system/index.ts'
import type { ActorDef, LifecycleEvent } from '../system/index.ts'

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
    const system = createActorSystem((e) => events.push(e))

    const ref = system.spawn('stopper', failingActorDef(), { count: 0 })

    await tick()

    // Send a normal message then a poison message
    ref.send('hello')
    ref.send('POISON')

    await tick(200)

    // The actor should have stopped — we expect child-started then child-stopped
    const types = events.map((e) => e.type)
    expect(types).toContain('child-started')
    expect(types).toContain('child-stopped')

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

    const system = createActorSystem((e) => events.push(e))

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

    // Should have child-failed event
    const failedEvents = events.filter((e) => e.type === 'child-failed')
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

describe('Supervision: escalate strategy', () => {
  test('parent receives child-failed event on escalation', async () => {
    const events: LifecycleEvent[] = []

    const system = createActorSystem((e) => events.push(e))

    const ref = system.spawn(
      'escalator',
      failingActorDef({
        supervision: { type: 'escalate' },
      }),
      { count: 0 },
    )

    await tick()

    ref.send('POISON')

    await tick(200)

    const failedEvents = events.filter((e) => e.type === 'child-failed')
    expect(failedEvents.length).toBe(1)

    const failedEvent = failedEvents[0]!
    expect(failedEvent.type).toBe('child-failed')
    if (failedEvent.type === 'child-failed') {
      expect(failedEvent.child.name).toBe('escalator')
      expect(failedEvent.error).toBeInstanceOf(Error)
      expect((failedEvent.error as Error).message).toBe('Poisoned!')
    }

    await system.shutdown()
  })

  test('actor stops after escalating', async () => {
    let stoppedCalled = false
    const received: string[] = []

    const system = createActorSystem()

    const ref = system.spawn(
      'escalate-then-stop',
      failingActorDef({
        supervision: { type: 'escalate' },
        onStopped: () => { stoppedCalled = true },
        onMessage: (m) => received.push(m),
      }),
      { count: 0 },
    )

    await tick()

    ref.send('before')
    ref.send('POISON')
    ref.send('after')

    await tick(200)

    expect(received).toEqual(['before'])
    expect(stoppedCalled).toBe(true)

    await system.shutdown()
  })
})

describe('Supervision: child actor failure propagation', () => {
  test('parent actor receives child-failed lifecycle event from escalating child', async () => {
    const parentEvents: LifecycleEvent[] = []

    const childDef: ActorDef<string, {}> = {
      supervision: { type: 'escalate' },
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

    const childFailed = parentEvents.filter((e) => e.type === 'child-failed')
    expect(childFailed.length).toBe(1)

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
    const system = createActorSystem((e) => events.push(e))

    system.spawn(
      'clean-shutdown',
      failingActorDef({ supervision: { type: 'restart' } }),
      { count: 0 },
    )

    await tick()

    await system.shutdown()

    const stopped = events.filter((e) => e.type === 'child-stopped')
    expect(stopped.length).toBe(1)
  })
})
