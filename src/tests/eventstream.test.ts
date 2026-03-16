import { describe, test, expect } from 'bun:test'
import {
  createPluginSystem,
  createTopic,
  emit,
  DeadLetterTopic,
  LogTopic,
} from '../system/index.ts'
import type {
  ActorDef,
  DeadLetter,
  LogEvent,
} from '../system/index.ts'

// ─── Helpers ───

/** Small delay to let async actor processing settle */
const tick = (ms = 50) => Bun.sleep(ms)

// ═══════════════════════════════════════════════════════════════════
// EventStream: Pub-Sub
// ═══════════════════════════════════════════════════════════════════

describe('EventStream: pub-sub', () => {
  test('actor can publish and another actor can subscribe to events', async () => {
    const system = await createPluginSystem()
    const received: string[] = []

    // Subscriber actor
    type SubMsg = { type: 'event'; value: string }
    const subscriberDef: ActorDef<SubMsg, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          ctx.subscribe('test.topic', (e) => ({
            type: 'event' as const,
            value: (e as { value: string }).value,
          }))
        }
        return { state }
      },
      handler: (state, msg) => {
        if (msg.type === 'event') {
          received.push(msg.value)
        }
        return { state }
      },
    }

    // Publisher actor
    type PubMsg = { type: 'emit'; value: string }
    const publisherDef: ActorDef<PubMsg, null> = {
      handler: (state, msg, ctx) => {
        if (msg.type === 'emit') {
          ctx.publish('test.topic', { value: msg.value })
        }
        return { state }
      },
    }

    system.spawn('subscriber', subscriberDef, null)
    const pub = system.spawn('publisher', publisherDef, null)
    await tick()

    pub.send({ type: 'emit', value: 'hello' })
    pub.send({ type: 'emit', value: 'world' })
    await tick()

    expect(received).toEqual(['hello', 'world'])
    await system.shutdown()
  })

  test('multiple subscribers receive the same event', async () => {
    const system = await createPluginSystem()
    const receivedA: string[] = []
    const receivedB: string[] = []

    type SubMsg = { type: 'got'; value: string }
    const makeSub = (log: string[]): ActorDef<SubMsg, null> => ({
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          ctx.subscribe('shared.topic', (e) => ({
            type: 'got' as const,
            value: (e as { value: string }).value,
          }))
        }
        return { state }
      },
      handler: (state, msg) => {
        log.push(msg.value)
        return { state }
      },
    })

    system.spawn('sub-a', makeSub(receivedA), null)
    system.spawn('sub-b', makeSub(receivedB), null)
    await tick()

    // Publish from system level
    system.publish('shared.topic', { value: 'broadcast' })
    await tick()

    expect(receivedA).toEqual(['broadcast'])
    expect(receivedB).toEqual(['broadcast'])
    await system.shutdown()
  })

  test('unsubscribe stops delivery', async () => {
    const system = await createPluginSystem()
    const received: string[] = []

    type Msg = { type: 'got'; value: string } | { type: 'unsub' }
    const subDef: ActorDef<Msg, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          ctx.subscribe('topic', (e) => ({
            type: 'got' as const,
            value: (e as { value: string }).value,
          }))
        }
        return { state }
      },
      handler: (state, msg, ctx) => {
        if (msg.type === 'got') {
          received.push(msg.value)
        } else if (msg.type === 'unsub') {
          ctx.unsubscribe('topic')
        }
        return { state }
      },
    }

    const ref = system.spawn('sub', subDef, null)
    await tick()

    system.publish('topic', { value: 'before' })
    await tick()

    ref.send({ type: 'unsub' })
    await tick()

    system.publish('topic', { value: 'after' })
    await tick()

    expect(received).toEqual(['before'])
    await system.shutdown()
  })

  test('subscriptions are cleaned up when actor stops', async () => {
    const system = await createPluginSystem()
    const received: string[] = []

    type Msg = { type: 'got'; value: string }
    const subDef: ActorDef<Msg, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          ctx.subscribe('topic', (e) => ({
            type: 'got' as const,
            value: (e as { value: string }).value,
          }))
        }
        return { state }
      },
      handler: (state, msg) => {
        received.push(msg.value)
        return { state }
      },
    }

    system.spawn('sub', subDef, null)
    await tick()

    system.publish('topic', { value: 'alive' })
    await tick()

    system.stop({ name: 'system/sub' })
    await tick()

    system.publish('topic', { value: 'dead' })
    await tick()

    expect(received).toEqual(['alive'])
    await system.shutdown()
  })

  test('system.subscribe returns an unsubscribe function', async () => {
    const system = await createPluginSystem()
    const received: unknown[] = []

    const unsub = system.subscribe('external', 'test', (event) => {
      received.push(event)
    })

    system.publish('test', 'a')
    expect(received).toEqual(['a'])

    unsub()

    system.publish('test', 'b')
    expect(received).toEqual(['a']) // 'b' not received

    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// EventStream: Handler-returned events (auto-publish)
// ═══════════════════════════════════════════════════════════════════

describe('EventStream: handler-returned events', () => {
  test('events returned from handler are published to their declared topic', async () => {
    const system = await createPluginSystem()
    const published: unknown[] = []

    type Msg = { type: 'produce'; value: string }
    type Evt = { type: 'produced'; value: string }
    const ProducedTopic = createTopic<Evt>('producer.events')

    // Subscribe to the typed topic
    system.subscribe('test-listener', ProducedTopic, (event) => {
      published.push(event)
    })

    const producerDef: ActorDef<Msg, null> = {
      handler: (state, msg) => {
        if (msg.type === 'produce') {
          return {
            state,
            events: [emit(ProducedTopic, { type: 'produced', value: msg.value })],
          }
        }
        return { state }
      },
    }

    const ref = system.spawn('producer', producerDef, null)
    await tick()

    ref.send({ type: 'produce', value: 'item-1' })
    ref.send({ type: 'produce', value: 'item-2' })
    await tick()

    expect(published).toEqual([
      { type: 'produced', value: 'item-1' },
      { type: 'produced', value: 'item-2' },
    ])
    await system.shutdown()
  })

  test('handler with no events does not publish', async () => {
    const system = await createPluginSystem()
    const published: unknown[] = []

    const SomeTopic = createTopic<unknown>('some.topic')
    system.subscribe('listener', SomeTopic, (event) => {
      published.push(event)
    })

    const def: ActorDef<string, null> = {
      handler: (state) => ({ state }), // no events
    }

    const ref = system.spawn('actor', def, null)
    await tick()

    ref.send('hello')
    await tick()

    expect(published).toEqual([])
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Dead Letters
// ═══════════════════════════════════════════════════════════════════

describe('Dead letters', () => {
  test('message sent to a stopped actor produces a dead letter', async () => {
    const system = await createPluginSystem()
    const deadLetters: DeadLetter[] = []

    system.subscribe('dl-listener', DeadLetterTopic, (event) => {
      deadLetters.push(event)
    })

    const ref = system.spawn('target', {
      handler: (state: null) => ({ state }),
    }, null)
    await tick()

    system.stop({ name: 'system/target' })
    await tick()

    ref.send('lost-message')
    await tick()

    expect(deadLetters.length).toBe(1)
    expect(deadLetters[0]!.recipient).toBe('system/target')
    expect(deadLetters[0]!.message).toBe('lost-message')
    expect(typeof deadLetters[0]!.timestamp).toBe('number')
    await system.shutdown()
  })

  test('messages to live actors do not produce dead letters', async () => {
    const system = await createPluginSystem()
    const deadLetters: DeadLetter[] = []

    system.subscribe('dl-listener', DeadLetterTopic, (event) => {
      deadLetters.push(event)
    })

    const ref = system.spawn('alive', {
      handler: (state: null) => ({ state }),
    }, null)
    await tick()

    ref.send('hello')
    await tick()

    expect(deadLetters).toEqual([])
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Logging
// ═══════════════════════════════════════════════════════════════════

describe('Logging', () => {
  test('actor lifecycle emits started and stopped log events', async () => {
    const system = await createPluginSystem()
    const logs: LogEvent[] = []

    system.subscribe('log-listener', LogTopic, (event) => {
      logs.push(event)
    })

    system.spawn('logger-test', {
      handler: (state: null) => ({ state }),
    }, null)
    await tick()

    system.stop({ name: 'system/logger-test' })
    await tick()

    const startLog = logs.find((l) => l.source === 'system/logger-test' && l.message === 'started')
    const stopLog = logs.find((l) => l.source === 'system/logger-test' && l.message === 'stopped')

    expect(startLog).toBeDefined()
    expect(startLog!.level).toBe('info')
    expect(stopLog).toBeDefined()
    expect(stopLog!.level).toBe('info')
    await system.shutdown()
  })

  test('actor failure emits an error log event', async () => {
    const system = await createPluginSystem()
    const logs: LogEvent[] = []

    system.subscribe('log-listener', LogTopic, (event) => {
      logs.push(event)
    })

    const def: ActorDef<string, null> = {
      handler: () => {
        throw new Error('boom')
      },
    }

    const ref = system.spawn('failer', def, null)
    await tick()

    ref.send('trigger')
    await tick(100)

    const failLog = logs.find((l) => l.source === 'system/failer' && l.level === 'error')
    expect(failLog).toBeDefined()
    expect(failLog!.message).toBe('failed')
    await system.shutdown()
  })

  test('actor restart emits a warning log event', async () => {
    const system = await createPluginSystem()
    const logs: LogEvent[] = []

    system.subscribe('log-listener', LogTopic, (event) => {
      logs.push(event)
    })

    let callCount = 0
    const def: ActorDef<string, null> = {
      handler: (state, msg) => {
        callCount++
        if (callCount === 1) throw new Error('first fail')
        return { state }
      },
      supervision: { type: 'restart', maxRetries: 3 },
    }

    const ref = system.spawn('restarter', def, null)
    await tick()

    ref.send('trigger')
    await tick(100)

    const restartLog = logs.find((l) => l.source === 'system/restarter' && l.message === 'restarting')
    expect(restartLog).toBeDefined()
    expect(restartLog!.level).toBe('warn')
    await system.shutdown()
  })

  test('ctx.log.info publishes a log event to the log topic', async () => {
    const system = await createPluginSystem()
    const logs: LogEvent[] = []

    system.subscribe('log-listener', LogTopic, (event) => {
      logs.push(event)
    })

    type Msg = { type: 'do-log' }
    const def: ActorDef<Msg, null> = {
      handler: (state, msg, ctx) => {
        if (msg.type === 'do-log') {
          ctx.log.info('custom message', { detail: 42 })
        }
        return { state }
      },
    }

    const ref = system.spawn('custom-logger', def, null)
    await tick()

    ref.send({ type: 'do-log' })
    await tick()

    const customLog = logs.find(
      (l) => l.source === 'system/custom-logger' && l.message === 'custom message',
    )
    expect(customLog).toBeDefined()
    expect(customLog!.level).toBe('info')
    expect(customLog!.data).toEqual({ detail: 42 })
    await system.shutdown()
  })

  test('all log levels work (debug, info, warn, error)', async () => {
    const system = await createPluginSystem()
    const logs: LogEvent[] = []

    system.subscribe('log-listener', LogTopic, (event) => {
      logs.push(event)
    })

    type Msg = 'log-all'
    const def: ActorDef<Msg, null> = {
      handler: (state, _msg, ctx) => {
        ctx.log.debug('d')
        ctx.log.info('i')
        ctx.log.warn('w')
        ctx.log.error('e')
        return { state }
      },
    }

    const ref = system.spawn('multi-log', def, null)
    await tick()

    ref.send('log-all')
    await tick()

    const actorLogs = logs.filter((l) => l.source === 'system/multi-log')
    const levels = actorLogs.map((l) => l.level)

    expect(levels).toContain('debug')
    expect(levels).toContain('info')
    expect(levels).toContain('warn')
    expect(levels).toContain('error')
    await system.shutdown()
  })
})
