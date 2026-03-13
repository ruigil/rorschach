import { describe, test, expect } from 'bun:test'
import { createMailbox } from '../system/mailbox.ts'
import { STOP } from '../system/types.ts'

// ─── Helpers ───

/** Small delay to let async actor processing settle */
const tick = (ms = 50) => Bun.sleep(ms)

// ═══════════════════════════════════════════════════════════════════
// Mailbox Tests
// ═══════════════════════════════════════════════════════════════════

describe('Mailbox', () => {
  test('enqueue and take deliver messages in FIFO order', async () => {
    const mb = createMailbox<string>()
    mb.enqueue('a')
    mb.enqueue('b')
    mb.enqueue('c')

    expect(await mb.take()).toBe('a')
    expect(await mb.take()).toBe('b')
    expect(await mb.take()).toBe('c')
  })

  test('take suspends until a message is enqueued', async () => {
    const mb = createMailbox<string>()
    let received = ''

    const promise = mb.take().then((v) => { received = String(v) })

    // Nothing yet — the consumer should be suspended
    await tick(10)
    expect(received).toBe('')

    mb.enqueue('hello')
    await promise

    expect(received).toBe('hello')
  })

  test('close returns STOP to a suspended consumer', async () => {
    const mb = createMailbox<string>()
    const promise = mb.take()

    mb.close()

    expect(await promise).toBe(STOP)
  })

  test('close returns STOP for subsequent takes on an empty mailbox', async () => {
    const mb = createMailbox<string>()
    mb.close()

    expect(await mb.take()).toBe(STOP)
    expect(await mb.take()).toBe(STOP)
  })

  test('messages enqueued after close are silently dropped', async () => {
    const mb = createMailbox<string>()
    mb.enqueue('before-close')
    mb.close()
    mb.enqueue('after-close')

    // Should get the buffered message, then STOP
    expect(await mb.take()).toBe('before-close')
    expect(await mb.take()).toBe(STOP)
  })

  test('STOP is queued when consumer is busy processing', async () => {
    const mb = createMailbox<string>()
    mb.enqueue('msg1')
    mb.close()

    // msg1 is in queue, and close should have enqueued STOP after it
    expect(await mb.take()).toBe('msg1')
    expect(await mb.take()).toBe(STOP)
  })

  test('immediate delivery when consumer is already waiting', async () => {
    const mb = createMailbox<string>()

    // Start waiting before enqueueing
    const promise = mb.take()

    // Enqueue while consumer is suspended — should resolve immediately
    mb.enqueue('immediate')

    expect(await promise).toBe('immediate')
  })
})
