import { describe, test, expect } from 'bun:test'
import { createMailbox } from '../system/mailbox.ts'
import { createActorSystem } from '../system/index.ts'
import { DeadLetterTopic } from '../system/types.ts'
import type { ActorDef, DeadLetter, LifecycleEvent } from '../system/index.ts'

// ─── Helpers ───

const tick = (ms = 50) => Bun.sleep(ms)

// ═══════════════════════════════════════════════════════════════════
// Mailbox: Bounded — drop-newest (default)
// ═══════════════════════════════════════════════════════════════════

describe('Mailbox: bounded — drop-newest', () => {
  test('unbounded mailbox accepts all messages (backward compat)', async () => {
    const mb = createMailbox<number>()
    for (let i = 0; i < 1000; i++) mb.enqueue(i)
    expect(mb.size()).toBe(1000)
    expect(await mb.take()).toBe(0)
    expect(mb.size()).toBe(999)
  })

  test('bounded mailbox drops newest when full', async () => {
    const dropped: unknown[] = []

    const mb = createMailbox<string>({
      capacity: 3,
      overflowStrategy: 'drop-newest',
      onOverflow: (item) => dropped.push(item),
    })

    mb.enqueue('a')
    mb.enqueue('b')
    mb.enqueue('c')
    // Queue is full — next one should be dropped
    mb.enqueue('d')
    mb.enqueue('e')

    expect(mb.size()).toBe(3)
    expect(dropped).toEqual(['d', 'e'])

    expect(await mb.take()).toBe('a')
    expect(await mb.take()).toBe('b')
    expect(await mb.take()).toBe('c')
  })

  test('drop-newest is the default overflow strategy', async () => {
    const dropped: unknown[] = []

    const mb = createMailbox<string>({
      capacity: 2,
      onOverflow: (item) => dropped.push(item),
    })

    mb.enqueue('a')
    mb.enqueue('b')
    mb.enqueue('c') // should be dropped (newest)

    expect(dropped).toEqual(['c'])
    expect(await mb.take()).toBe('a')
    expect(await mb.take()).toBe('b')
  })

  test('immediate delivery when consumer is suspended bypasses capacity check', async () => {
    const dropped: unknown[] = []

    const mb = createMailbox<string>({
      capacity: 1,
      onOverflow: (item) => dropped.push(item),
    })

    // Start consumer waiting — next enqueue delivers directly, no queue growth
    const promise = mb.take()
    mb.enqueue('direct')

    expect(await promise).toBe('direct')
    expect(mb.size()).toBe(0)
    expect(dropped).toEqual([])
  })

  test('capacity is only checked when buffering', async () => {
    const dropped: unknown[] = []

    const mb = createMailbox<string>({
      capacity: 1,
      onOverflow: (item) => dropped.push(item),
    })

    // Consumer waiting — delivered directly (no queue)
    const p1 = mb.take()
    mb.enqueue('direct1')
    expect(await p1).toBe('direct1')

    // Now buffer one
    mb.enqueue('buffered')
    expect(mb.size()).toBe(1)

    // This one should be dropped (queue full)
    mb.enqueue('overflow')
    expect(dropped).toEqual(['overflow'])

    // Consume the buffered one
    expect(await mb.take()).toBe('buffered')

    // Consumer waiting again — direct delivery works
    const p2 = mb.take()
    mb.enqueue('direct2')
    expect(await p2).toBe('direct2')
    expect(dropped).toEqual(['overflow']) // no additional drops
  })
})

// ═══════════════════════════════════════════════════════════════════
// Mailbox: Bounded — drop-oldest
// ═══════════════════════════════════════════════════════════════════

describe('Mailbox: bounded — drop-oldest', () => {
  test('bounded mailbox drops oldest when full', async () => {
    const dropped: unknown[] = []

    const mb = createMailbox<string>({
      capacity: 3,
      overflowStrategy: 'drop-oldest',
      onOverflow: (item) => dropped.push(item),
    })

    mb.enqueue('a')
    mb.enqueue('b')
    mb.enqueue('c')
    // Queue full — 'a' should be dropped to make room for 'd'
    mb.enqueue('d')

    expect(mb.size()).toBe(3)
    expect(dropped).toEqual(['a'])

    expect(await mb.take()).toBe('b')
    expect(await mb.take()).toBe('c')
    expect(await mb.take()).toBe('d')
  })

  test('multiple overflows drop oldest messages in order', async () => {
    const dropped: unknown[] = []

    const mb = createMailbox<string>({
      capacity: 2,
      overflowStrategy: 'drop-oldest',
      onOverflow: (item) => dropped.push(item),
    })

    mb.enqueue('a')
    mb.enqueue('b')
    mb.enqueue('c') // drops 'a'
    mb.enqueue('d') // drops 'b'

    expect(dropped).toEqual(['a', 'b'])
    expect(await mb.take()).toBe('c')
    expect(await mb.take()).toBe('d')
  })
})

// ═══════════════════════════════════════════════════════════════════
// Mailbox: enqueueSystem
// ═══════════════════════════════════════════════════════════════════

describe('Mailbox: enqueueSystem', () => {
  test('enqueueSystem bypasses capacity limits', async () => {
    const dropped: unknown[] = []

    const mb = createMailbox<string>({
      capacity: 2,
      onOverflow: (item) => dropped.push(item),
    })

    mb.enqueue('a')
    mb.enqueue('b')
    // Queue full — but enqueueSystem should still add
    mb.enqueueSystem('forced')

    expect(mb.size()).toBe(3) // exceeds capacity
    expect(dropped).toEqual([]) // nothing dropped

    expect(await mb.take()).toBe('a')
    expect(await mb.take()).toBe('b')
    expect(await mb.take()).toBe('forced')
  })

  test('enqueueSystem delivers directly when consumer is suspended', async () => {
    const mb = createMailbox<string>({ capacity: 1 })

    const promise = mb.take()
    mb.enqueueSystem('direct')

    expect(await promise).toBe('direct')
    expect(mb.size()).toBe(0)
  })

  test('enqueueSystem is silently dropped after close', async () => {
    const mb = createMailbox<string>({ capacity: 2 })

    mb.enqueueSystem('before')
    mb.close()
    mb.enqueueSystem('after')

    expect(await mb.take()).toBe('before')
  })
})

// ═══════════════════════════════════════════════════════════════════
// Mailbox: size property
// ═══════════════════════════════════════════════════════════════════

describe('Mailbox: size', () => {
  test('size reflects the current queue depth', async () => {
    const mb = createMailbox<string>()

    expect(mb.size()).toBe(0)

    mb.enqueue('a')
    mb.enqueue('b')
    expect(mb.size()).toBe(2)

    await mb.take()
    expect(mb.size()).toBe(1)

    await mb.take()
    expect(mb.size()).toBe(0)
  })

  test('size is 0 when consumer is suspended (direct delivery)', async () => {
    const mb = createMailbox<string>()

    const promise = mb.take()
    mb.enqueue('msg')
    await promise

    expect(mb.size()).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Actor integration: bounded mailbox with dead letters
// ═══════════════════════════════════════════════════════════════════

describe('Actor: bounded mailbox integration', () => {
  test('dropped messages are routed to dead letters', async () => {
    const deadLetters: DeadLetter[] = []
    const received: string[] = []

    const def: ActorDef<string, null> = {
      mailbox: { capacity: 2 },

      handler: async (state, message) => {
        // Slow handler — messages will pile up in the mailbox
        await Bun.sleep(30)
        received.push(message)
        return { state }
      },
    }

    const system = createActorSystem()

    system.subscribe('test-observer', DeadLetterTopic, (event) => {
      deadLetters.push(event as DeadLetter)
    })

    const ref = system.spawn('bounded', def, null)
    await tick()

    // Send a burst — the actor is processing msg1 (slow), so msg2+msg3 fill the mailbox,
    // msg4 and msg5 should overflow
    ref.send('msg1')
    await tick(5) // let msg1 start processing
    ref.send('msg2')
    ref.send('msg3')
    ref.send('msg4') // should overflow (drop-newest)
    ref.send('msg5') // should overflow (drop-newest)

    await tick(300) // wait for all processing

    // msg1 was delivered directly (consumer was waiting), msg2+msg3 fit in capacity=2
    expect(received).toEqual(['msg1', 'msg2', 'msg3'])

    // msg4 and msg5 should have been routed to dead letters
    expect(deadLetters.length).toBe(2)
    expect(deadLetters[0]!.message).toBe('msg4')
    expect(deadLetters[1]!.message).toBe('msg5')
    expect(deadLetters[0]!.recipient).toBe('system/bounded')

    await system.shutdown()
  })

  test('drop-oldest strategy keeps most recent messages', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      mailbox: { capacity: 2, overflowStrategy: 'drop-oldest' },

      handler: async (state, message) => {
        await Bun.sleep(30)
        received.push(message)
        return { state }
      },
    }

    const system = createActorSystem()

    const ref = system.spawn('drop-oldest', def, null)
    await tick()

    // msg1 is being processed (consumer was waiting), msg2+msg3 fill mailbox
    ref.send('msg1')
    await tick(5)
    ref.send('msg2')
    ref.send('msg3')
    ref.send('msg4') // drops msg2 (oldest)
    ref.send('msg5') // drops msg3 (oldest)

    await tick(300)

    // msg1 delivered directly, then msg4+msg5 (msg2+msg3 were dropped)
    expect(received).toEqual(['msg1', 'msg4', 'msg5'])

    await system.shutdown()
  })

  test('actors without mailbox config remain unbounded', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      handler: async (state, message) => {
        await Bun.sleep(10)
        received.push(message)
        return { state }
      },
    }

    const system = createActorSystem()

    const ref = system.spawn('unbounded', def, null)
    await tick()

    // Send many messages — all should be buffered and eventually processed
    for (let i = 0; i < 20; i++) {
      ref.send(`msg${i}`)
    }

    await tick(500)

    expect(received.length).toBe(20)

    await system.shutdown()
  })

  test('lifecycle events are not dropped when mailbox is full', async () => {
    const lifecycleEvents: LifecycleEvent[] = []

    const childDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    type ParentMsg = 'spawn' | 'stop-child' | 'fill' | 'snapshot'

    const parentDef: ActorDef<ParentMsg, { events: string[] }> = {
      mailbox: { capacity: 1 },

      handler: async (state, msg, ctx) => {
        if (msg === 'spawn') {
          ctx.spawn('child', childDef, null)
          return { state }
        }
        if (msg === 'stop-child') {
          ctx.stop({ name: ctx.self.name + '/child' })
          return { state }
        }
        if (msg === 'fill') {
          // Just slow processing to fill the mailbox
          await Bun.sleep(30)
          return { state }
        }
        if (msg === 'snapshot') {
          return { state }
        }
        return { state }
      },

      lifecycle: (state, event) => {
        lifecycleEvents.push(event)
        return { state: { events: [...state.events, event.type] } }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('parent', parentDef, { events: [] })
    await tick(100)

    // Spawn a child
    ref.send('spawn')
    await tick(100)

    // Stop the child — the terminated lifecycle event should arrive
    // even if the mailbox is "full"
    ref.send('stop-child')
    await tick(200)

    // The terminated event should have been received via enqueueSystem
    const terminated = lifecycleEvents.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(1)

    await system.shutdown()
  })

  test('timer messages bypass capacity limits', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      mailbox: { capacity: 1 },

      setup: (state, ctx) => {
        // Schedule a timer message
        ctx.timers.startSingleTimer('tick', 'timer-msg', 80)
        return state
      },

      handler: async (state, message) => {
        if (message === 'blocker') {
          // Slow processing to fill the mailbox
          await Bun.sleep(50)
        }
        received.push(message)
        return { state }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('timer-test', def, null)
    await tick()

    // Fill the mailbox while a message is being processed
    ref.send('blocker')
    await tick(5)
    ref.send('fill-1') // fills the 1-slot mailbox

    // The timer will fire at ~80ms and should bypass capacity via enqueueSystem
    await tick(200)

    expect(received).toContain('timer-msg')

    await system.shutdown()
  })
})
