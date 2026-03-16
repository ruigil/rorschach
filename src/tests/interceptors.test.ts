import { describe, test, expect } from 'bun:test'
import { createPluginSystem, SystemLifecycleTopic } from '../system/index.ts'
import type {
  ActorDef,
  Interceptor,
  LifecycleEvent,
  MessageHandler,
} from '../system/index.ts'

// ─── Helpers ───

/** Small delay to let async actor processing settle */
const tick = (ms = 50) => Bun.sleep(ms)

// ═══════════════════════════════════════════════════════════════════
// Interceptors: Basic Pipeline
// ═══════════════════════════════════════════════════════════════════

describe('Interceptors: basic pipeline', () => {
  test('single interceptor wraps the handler', async () => {
    const log: string[] = []

    const loggingInterceptor: Interceptor<string, null> = (state, message, _ctx, next) => {
      log.push(`before:${message}`)
      const result = next(state, message)
      log.push(`after:${message}`)
      return result
    }

    const def: ActorDef<string, null> = {
      interceptors: [loggingInterceptor],
      handler: (state, message) => {
        log.push(`handler:${message}`)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('intercepted', def, null)
    await tick()

    ref.send('hello')
    await tick()

    expect(log).toEqual(['before:hello', 'handler:hello', 'after:hello'])
    await system.shutdown()
  })

  test('multiple interceptors execute in array order (first = outermost)', async () => {
    const log: string[] = []

    const outer: Interceptor<string, null> = (state, message, _ctx, next) => {
      log.push(`outer-before`)
      const result = next(state, message)
      log.push(`outer-after`)
      return result
    }

    const inner: Interceptor<string, null> = (state, message, _ctx, next) => {
      log.push(`inner-before`)
      const result = next(state, message)
      log.push(`inner-after`)
      return result
    }

    const def: ActorDef<string, null> = {
      interceptors: [outer, inner],
      handler: (state, message) => {
        log.push(`handler:${message}`)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('multi', def, null)
    await tick()

    ref.send('msg')
    await tick()

    expect(log).toEqual([
      'outer-before',
      'inner-before',
      'handler:msg',
      'inner-after',
      'outer-after',
    ])
    await system.shutdown()
  })

  test('actor without interceptors works normally (zero overhead)', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      handler: (state, message) => {
        received.push(message)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('no-interceptors', def, null)
    await tick()

    ref.send('a')
    ref.send('b')
    await tick()

    expect(received).toEqual(['a', 'b'])
    await system.shutdown()
  })

  test('interceptor receives correct state from previous message', async () => {
    const stateSnapshots: number[] = []

    const stateInspector: Interceptor<'inc', { count: number }> = (state, message, _ctx, next) => {
      stateSnapshots.push(state.count)
      return next(state, message)
    }

    const def: ActorDef<'inc', { count: number }> = {
      interceptors: [stateInspector],
      handler: (state) => {
        return { state: { count: state.count + 1 } }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('state-inspect', def, { count: 0 })
    await tick()

    ref.send('inc')
    ref.send('inc')
    ref.send('inc')
    await tick()

    // State evolves: 0 → 1 → 2 → 3 ; interceptor sees 0, 1, 2
    expect(stateSnapshots).toEqual([0, 1, 2])
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Interceptors: Short-Circuit
// ═══════════════════════════════════════════════════════════════════

describe('Interceptors: short-circuit', () => {
  test('interceptor can short-circuit without calling next', async () => {
    const handlerCalls: string[] = []

    const filterInterceptor: Interceptor<string, null> = (state, message, _ctx, next) => {
      if (message === 'blocked') {
        return { state } // Short-circuit — handler never sees this
      }
      return next(state, message)
    }

    const def: ActorDef<string, null> = {
      interceptors: [filterInterceptor],
      handler: (state, message) => {
        handlerCalls.push(message)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('filter', def, null)
    await tick()

    ref.send('allowed')
    ref.send('blocked')
    ref.send('also-allowed')
    await tick()

    expect(handlerCalls).toEqual(['allowed', 'also-allowed'])
    await system.shutdown()
  })

  test('short-circuit in outer interceptor prevents inner interceptor from running', async () => {
    const log: string[] = []

    const gatekeeper: Interceptor<string, null> = (state, message, _ctx, next) => {
      if (message === 'stop') {
        log.push('gatekeeper-blocked')
        return { state }
      }
      return next(state, message)
    }

    const logger: Interceptor<string, null> = (state, message, _ctx, next) => {
      log.push('logger-called')
      return next(state, message)
    }

    const def: ActorDef<string, null> = {
      interceptors: [gatekeeper, logger],
      handler: (state) => {
        log.push('handler-called')
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('gate', def, null)
    await tick()

    ref.send('stop')
    ref.send('go')
    await tick()

    expect(log).toEqual([
      'gatekeeper-blocked',
      'logger-called',
      'handler-called',
    ])
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Interceptors: Message Transformation
// ═══════════════════════════════════════════════════════════════════

describe('Interceptors: message transformation', () => {
  test('interceptor can transform the message before passing to next', async () => {
    const received: string[] = []

    const uppercaseInterceptor: Interceptor<string, null> = (state, message, _ctx, next) => {
      return next(state, message.toUpperCase())
    }

    const def: ActorDef<string, null> = {
      interceptors: [uppercaseInterceptor],
      handler: (state, message) => {
        received.push(message)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('transform', def, null)
    await tick()

    ref.send('hello')
    ref.send('world')
    await tick()

    expect(received).toEqual(['HELLO', 'WORLD'])
    await system.shutdown()
  })

  test('interceptor can modify the result after the handler', async () => {
    const def: ActorDef<'get', { count: number }> = {
      interceptors: [
        // Interceptor that doubles the state count after the handler
        (state, message, _ctx, next) => {
          const result = next(state, message)
          return { ...result, state: { count: result.state.count * 2 } }
        },
      ],
      handler: (state) => {
        return { state: { count: state.count + 1 } }
      },
    }

    const snapshots: number[] = []

    // Use a second interceptor to observe the final state
    const observer: Interceptor<'get', { count: number }> = (state, message, _ctx, next) => {
      const result = next(state, message)
      snapshots.push(result.state.count)
      return result
    }

    const defWithObserver: ActorDef<'get', { count: number }> = {
      interceptors: [
        observer,
        // Doubles the count after handler
        (state, message, _ctx, next) => {
          const result = next(state, message)
          return { ...result, state: { count: result.state.count * 2 } }
        },
      ],
      handler: (state) => {
        return { state: { count: state.count + 1 } }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('modify-result', defWithObserver, { count: 0 })
    await tick()

    ref.send('get')
    ref.send('get')
    ref.send('get')
    await tick()

    // count: 0 → handler(+1)=1 → doubler(*2)=2 → observer sees 2
    // count: 2 → handler(+1)=3 → doubler(*2)=6 → observer sees 6
    // count: 6 → handler(+1)=7 → doubler(*2)=14 → observer sees 14
    expect(snapshots).toEqual([2, 6, 14])
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Interceptors: Context Access
// ═══════════════════════════════════════════════════════════════════

describe('Interceptors: context access', () => {
  test('interceptor can use context.log', async () => {
    const logMessages: string[] = []

    const loggingInterceptor: Interceptor<string, null> = (state, message, ctx, next) => {
      ctx.log.info(`interceptor saw: ${message}`)
      return next(state, message)
    }

    const def: ActorDef<string, null> = {
      interceptors: [loggingInterceptor],
      handler: (state) => ({ state }),
    }

    const system = await createPluginSystem()

    // Subscribe to log topic to capture interceptor logs
    const { LogTopic } = await import('../system/types.ts')
    system.subscribe('test-observer', LogTopic, (event) => {
      if (event.source === 'system/logging-ctx' && event.message.startsWith('interceptor saw:')) {
        logMessages.push(event.message)
      }
    })

    const ref = system.spawn('logging-ctx', def, null)
    await tick()

    ref.send('test-msg')
    await tick()

    expect(logMessages).toEqual(['interceptor saw: test-msg'])
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Interceptors: Behavior Switching (become)
// ═══════════════════════════════════════════════════════════════════

describe('Interceptors: behavior switching', () => {
  test('interceptors survive become — new handler is also wrapped', async () => {
    const log: string[] = []

    const trackingInterceptor: Interceptor<string, null> = (state, message, _ctx, next) => {
      log.push(`intercept:${message}`)
      return next(state, message)
    }

    const alternateHandler: MessageHandler<string, null> = (state, message) => {
      log.push(`alternate:${message}`)
      return { state }
    }

    const def: ActorDef<string, null> = {
      interceptors: [trackingInterceptor],
      handler: (state, message) => {
        log.push(`initial:${message}`)
        if (message === 'switch') {
          return { state, become: alternateHandler }
        }
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('become-test', def, null)
    await tick()

    ref.send('before')
    ref.send('switch')
    ref.send('after')
    await tick()

    expect(log).toEqual([
      'intercept:before',
      'initial:before',
      'intercept:switch',
      'initial:switch',
      'intercept:after',      // Interceptor still active after become!
      'alternate:after',      // But handler has switched
    ])
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Interceptors: Supervision (restart)
// ═══════════════════════════════════════════════════════════════════

describe('Interceptors: supervision restart', () => {
  test('interceptors are reapplied after restart', async () => {
    const log: string[] = []
    let interceptCallCount = 0

    const countingInterceptor: Interceptor<string, null> = (state, message, _ctx, next) => {
      interceptCallCount++
      log.push(`intercept:${message}`)
      return next(state, message)
    }

    const def: ActorDef<string, null> = {
      supervision: { type: 'restart' },
      interceptors: [countingInterceptor],
      handler: (state, message) => {
        if (message === 'POISON') throw new Error('boom')
        log.push(`handler:${message}`)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('restart-test', def, null)
    await tick()

    ref.send('before')
    ref.send('POISON')      // triggers restart
    ref.send('after')       // processed after restart
    await tick(200)

    // Interceptor runs for all three messages (including the poison one)
    expect(log).toContain('intercept:before')
    expect(log).toContain('handler:before')
    expect(log).toContain('intercept:POISON')
    expect(log).toContain('intercept:after')
    expect(log).toContain('handler:after')

    // Interceptor was called 3 times (before, POISON, after)
    expect(interceptCallCount).toBe(3)
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Interceptors: Error Propagation
// ═══════════════════════════════════════════════════════════════════

describe('Interceptors: error propagation', () => {
  test('error thrown in handler propagates through interceptors to supervision', async () => {
    const log: string[] = []

    const errorObserver: Interceptor<string, null> = (state, message, _ctx, next) => {
      try {
        return next(state, message)
      } catch (e) {
        log.push(`interceptor caught: ${(e as Error).message}`)
        throw e // Re-throw so supervision sees it
      }
    }

    const def: ActorDef<string, null> = {
      interceptors: [errorObserver],
      handler: (state, message) => {
        if (message === 'fail') throw new Error('handler failed')
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('error-prop', def, null)
    await tick()

    ref.send('fail')
    await tick(200)

    expect(log).toEqual(['interceptor caught: handler failed'])
    await system.shutdown()
  })

  test('error thrown in interceptor itself triggers supervision', async () => {
    const events: LifecycleEvent[] = []

    const failingInterceptor: Interceptor<string, null> = (_state, message, _ctx, _next) => {
      if (message === 'boom') throw new Error('interceptor boom')
      return _next(_state, message)
    }

    const def: ActorDef<string, null> = {
      interceptors: [failingInterceptor],
      handler: (state) => ({ state }),
    }

    const system = await createPluginSystem()
    system.subscribe('test', SystemLifecycleTopic, (e) => events.push(e as LifecycleEvent))

    const ref = system.spawn('interceptor-fail', def, null)
    await tick()

    ref.send('boom')
    await tick(200)

    const terminated = events.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(1)
    if (terminated[0]!.type === 'terminated') {
      expect(terminated[0]!.reason).toBe('failed')
    }
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Interceptors: Rate Limiting (practical example)
// ═══════════════════════════════════════════════════════════════════

describe('Interceptors: practical examples', () => {
  test('rate-limiting interceptor drops excess messages', async () => {
    const processed: string[] = []
    let dropCount = 0

    // Simple counter-based "rate limiter" for testing — allows N messages total
    const limitInterceptor = (maxMessages: number): Interceptor<string, null> => {
      let count = 0
      return (state, message, _ctx, next) => {
        if (count >= maxMessages) {
          dropCount++
          return { state } // drop
        }
        count++
        return next(state, message)
      }
    }

    const def: ActorDef<string, null> = {
      interceptors: [limitInterceptor(3)],
      handler: (state, message) => {
        processed.push(message)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('rate-limit', def, null)
    await tick()

    ref.send('a')
    ref.send('b')
    ref.send('c')
    ref.send('d')  // should be dropped
    ref.send('e')  // should be dropped
    await tick()

    expect(processed).toEqual(['a', 'b', 'c'])
    expect(dropCount).toBe(2)
    await system.shutdown()
  })

  test('validation interceptor rejects invalid messages', async () => {
    type Msg = { type: 'data'; value: number }
    const processed: number[] = []

    const validatePositive: Interceptor<Msg, null> = (state, message, ctx, next) => {
      if (message.value < 0) {
        ctx.log.warn('rejected negative value')
        return { state }
      }
      return next(state, message)
    }

    const def: ActorDef<Msg, null> = {
      interceptors: [validatePositive],
      handler: (state, message) => {
        processed.push(message.value)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('validator', def, null)
    await tick()

    ref.send({ type: 'data', value: 10 })
    ref.send({ type: 'data', value: -5 })
    ref.send({ type: 'data', value: 20 })
    await tick()

    expect(processed).toEqual([10, 20])
    await system.shutdown()
  })
})
