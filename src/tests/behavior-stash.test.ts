import { describe, test, expect } from 'bun:test'
import { createPluginSystem, DeadLetterTopic } from '../system/index.ts'
import type {
  ActorDef,
  ActorRef,
  ActorResult,
  MessageHandler,
} from '../system/index.ts'

// ─── Helpers ───

const tick = (ms = 50) => Bun.sleep(ms)

// ═══════════════════════════════════════════════════════════════════
// Behavior Switching (become)
// ═══════════════════════════════════════════════════════════════════

describe('Behavior switching (become)', () => {
  test('become replaces the current message handler', async () => {
    const log: string[] = []

    const secondHandler: MessageHandler<string, null> = (state, msg) => {
      log.push(`second:${msg}`)
      return { state }
    }

    const def: ActorDef<string, null> = {
      handler: (state, msg) => {
        log.push(`first:${msg}`)
        if (msg === 'switch') {
          return { state, become: secondHandler }
        }
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('become-basic', def, null)
    await tick()

    ref.send('a')
    ref.send('switch')
    ref.send('b')
    await tick()

    expect(log).toEqual(['first:a', 'first:switch', 'second:b'])
    await system.shutdown()
  })

  test('become can switch multiple times', async () => {
    const log: string[] = []

    const handlerC: MessageHandler<string, null> = (state, msg) => {
      log.push(`C:${msg}`)
      return { state }
    }

    const handlerB: MessageHandler<string, null> = (state, msg) => {
      log.push(`B:${msg}`)
      if (msg === 'to-c') return { state, become: handlerC }
      return { state }
    }

    const def: ActorDef<string, null> = {
      handler: (state, msg) => {
        log.push(`A:${msg}`)
        if (msg === 'to-b') return { state, become: handlerB }
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('become-chain', def, null)
    await tick()

    ref.send('1')
    ref.send('to-b')
    ref.send('2')
    ref.send('to-c')
    ref.send('3')
    await tick()

    expect(log).toEqual(['A:1', 'A:to-b', 'B:2', 'B:to-c', 'C:3'])
    await system.shutdown()
  })

  test('become handler can return to the original handler explicitly', async () => {
    const log: string[] = []

    const def: ActorDef<string, null> = {
      handler: (state, msg) => {
        log.push(`main:${msg}`)
        if (msg === 'pause') return { state, become: pausedHandler }
        return { state }
      },
    }

    const pausedHandler: MessageHandler<string, null> = (state, msg) => {
      log.push(`paused:${msg}`)
      if (msg === 'resume') return { state, become: def.handler }
      return { state }
    }

    const system = await createPluginSystem()
    const ref = system.spawn('become-return', def, null)
    await tick()

    ref.send('a')
    ref.send('pause')
    ref.send('b')
    ref.send('resume')
    ref.send('c')
    await tick()

    expect(log).toEqual(['main:a', 'main:pause', 'paused:b', 'paused:resume', 'main:c'])
    await system.shutdown()
  })

  test('become preserves state across handler switches', async () => {
    const snapshots: number[] = []

    const countingHandler: MessageHandler<string, { count: number }> = (state, msg) => {
      if (msg === 'snapshot') {
        snapshots.push(state.count)
        return { state }
      }
      return { state: { count: state.count + 10 } }
    }

    const def: ActorDef<string, { count: number }> = {
      handler: (state, msg) => {
        if (msg === 'switch') return { state, become: countingHandler }
        return { state: { count: state.count + 1 } }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('become-state', def, { count: 0 })
    await tick()

    ref.send('inc')    // count: 1
    ref.send('inc')    // count: 2
    ref.send('switch') // switch (count stays 2)
    ref.send('inc')    // count: 12
    ref.send('snapshot')
    await tick()

    expect(snapshots).toEqual([12])
    await system.shutdown()
  })

  test('restart resets handler back to def.handler', async () => {
    const log: string[] = []

    const altHandler: MessageHandler<string, null> = (state, msg) => {
      log.push(`alt:${msg}`)
      if (msg === 'fail') throw new Error('boom')
      return { state }
    }

    const def: ActorDef<string, null> = {
      handler: (state, msg) => {
        log.push(`main:${msg}`)
        if (msg === 'switch') return { state, become: altHandler }
        return { state }
      },
      supervision: { type: 'restart', maxRetries: 3 },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('become-restart', def, null)
    await tick()

    ref.send('switch')
    ref.send('x')
    ref.send('fail')  // crash in altHandler → restart → back to def.handler
    await tick(100)

    ref.send('y')
    await tick()

    expect(log).toEqual(['main:switch', 'alt:x', 'alt:fail', 'main:y'])
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Stash
// ═══════════════════════════════════════════════════════════════════

describe('Stash', () => {
  test('stashed messages are replayed on unstashAll', async () => {
    const log: string[] = []

    type Msg = { type: 'ready' } | { type: 'data'; value: string }

    const readyHandler: MessageHandler<Msg, null> = (state, msg) => {
      if (msg.type === 'data') log.push(`processed:${msg.value}`)
      return { state }
    }

    const def: ActorDef<Msg, null> = {
      handler: (state, msg) => {
        if (msg.type === 'ready') {
          log.push('ready')
          return { state, become: readyHandler, unstashAll: true }
        }
        // Not ready yet — stash everything else
        log.push(`stashed:${msg.value}`)
        return { state, stash: true }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('stash-basic', def, null)
    await tick()

    ref.send({ type: 'data', value: 'a' })
    ref.send({ type: 'data', value: 'b' })
    ref.send({ type: 'ready' })
    await tick()

    expect(log).toEqual([
      'stashed:a',
      'stashed:b',
      'ready',
      'processed:a',
      'processed:b',
    ])
    await system.shutdown()
  })

  test('stash works with messages arriving after unstashAll', async () => {
    const log: string[] = []

    type Msg = 'init-done' | string

    const normalHandler: MessageHandler<Msg, null> = (state, msg) => {
      log.push(`normal:${msg}`)
      return { state }
    }

    const def: ActorDef<Msg, null> = {
      handler: (state, msg) => {
        if (msg === 'init-done') {
          return { state, become: normalHandler, unstashAll: true }
        }
        return { state, stash: true }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('stash-mixed', def, null)
    await tick()

    ref.send('early-1')
    ref.send('early-2')
    ref.send('init-done')
    ref.send('late-1')
    await tick()

    // All messages processed by normalHandler after transition
    expect(log).toContain('normal:early-1')
    expect(log).toContain('normal:early-2')
    expect(log).toContain('normal:late-1')
    await system.shutdown()
  })

  test('empty stash: unstashAll is a no-op', async () => {
    const log: string[] = []

    const otherHandler: MessageHandler<string, null> = (state, msg) => {
      log.push(`other:${msg}`)
      return { state }
    }

    const def: ActorDef<string, null> = {
      handler: (state, msg) => {
        log.push(`main:${msg}`)
        // unstashAll with nothing stashed
        return { state, become: otherHandler, unstashAll: true }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('stash-empty', def, null)
    await tick()

    ref.send('trigger')
    ref.send('after')
    await tick()

    expect(log).toEqual(['main:trigger', 'other:after'])
    await system.shutdown()
  })

  test('stash overflow drops oldest to dead letters', async () => {
    const deadLetters: unknown[] = []

    type Msg = 'flush' | string

    const readyHandler: MessageHandler<Msg, null> = (state, msg) => {
      return { state }
    }

    const def: ActorDef<Msg, null> = {
      handler: (state, msg) => {
        if (msg === 'flush') {
          return { state, become: readyHandler, unstashAll: true }
        }
        return { state, stash: true }
      },
      stashCapacity: 3,
    }

    const system = await createPluginSystem()
    system.subscribe('test-dl', DeadLetterTopic, (e) => deadLetters.push(e))

    const ref = system.spawn('stash-overflow', def, null)
    await tick()

    // Send 5 messages — capacity is 3, so 2 oldest will be dropped
    ref.send('m1')
    ref.send('m2')
    ref.send('m3')
    ref.send('m4')
    ref.send('m5')
    ref.send('flush')
    await tick()

    // 2 dead letters (m1 and m2 dropped as oldest)
    expect(deadLetters.length).toBe(2)
    expect((deadLetters[0] as any).message).toBe('m1')
    expect((deadLetters[1] as any).message).toBe('m2')

    await system.shutdown()
  })

  test('stashed messages are dead-lettered on stop', async () => {
    const deadLetters: unknown[] = []

    const def: ActorDef<string, null> = {
      handler: (state, msg) => {
        // Stash everything
        return { state, stash: true }
      },
    }

    const system = await createPluginSystem()
    system.subscribe('test-dl', DeadLetterTopic, (e) => deadLetters.push(e))

    const ref = system.spawn('stash-stop', def, null)
    await tick()

    ref.send('a')
    ref.send('b')
    ref.send('c')
    await tick()

    await system.shutdown()

    expect(deadLetters.length).toBe(3)
    expect((deadLetters[0] as any).message).toBe('a')
    expect((deadLetters[1] as any).message).toBe('b')
    expect((deadLetters[2] as any).message).toBe('c')
  })

  test('stashed messages are dead-lettered on restart', async () => {
    const deadLetters: unknown[] = []
    let callCount = 0

    type Msg = 'stash-me' | 'crash'

    const def: ActorDef<Msg, null> = {
      handler: (state, msg) => {
        callCount++
        if (msg === 'crash') throw new Error('boom')
        return { state, stash: true }
      },
      supervision: { type: 'restart', maxRetries: 3 },
    }

    const system = await createPluginSystem()
    system.subscribe('test-dl', DeadLetterTopic, (e) => deadLetters.push(e))

    const ref = system.spawn('stash-restart', def, null)
    await tick()

    ref.send('stash-me')
    ref.send('stash-me')
    ref.send('crash')
    await tick(100)

    // 2 stashed messages should be dead-lettered on restart
    expect(deadLetters.some((d: any) => d.message === 'stash-me')).toBe(true)
    expect(deadLetters.filter((d: any) => d.message === 'stash-me').length).toBe(2)

    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Combined: Become + Stash (real-world pattern)
// ═══════════════════════════════════════════════════════════════════

describe('Become + Stash: initialization pattern', () => {
  test('actor stashes during init, replays after becoming ready', async () => {
    const processed: string[] = []

    type Msg =
      | { type: 'connected'; connId: string }
      | { type: 'query'; value: string }

    type State = { connId: string | null }

    const connectedHandler: MessageHandler<Msg, State> = (state, msg) => {
      if (msg.type === 'query') {
        processed.push(`${state.connId}:${msg.value}`)
      }
      return { state }
    }

    const def: ActorDef<Msg, State> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          // Simulate async connection: send self a connected message after delay
          setTimeout(() => ctx.self.send({ type: 'connected', connId: 'conn-42' }), 30)
        }
        return { state }
      },

      handler: (state, msg) => {
        if (msg.type === 'connected') {
          return {
            state: { connId: msg.connId },
            become: connectedHandler,
            unstashAll: true,
          }
        }
        // Not connected yet — defer
        return { state, stash: true }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('init-pattern', def, { connId: null })
    await tick()

    // These arrive before 'connected'
    ref.send({ type: 'query', value: 'q1' })
    ref.send({ type: 'query', value: 'q2' })
    await tick(200)

    // After connected, stashed queries should be replayed
    expect(processed).toEqual(['conn-42:q1', 'conn-42:q2'])

    // New messages also work
    ref.send({ type: 'query', value: 'q3' })
    await tick()

    expect(processed).toEqual(['conn-42:q1', 'conn-42:q2', 'conn-42:q3'])
    await system.shutdown()
  })
})
