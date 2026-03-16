import { describe, test, expect } from 'bun:test'
import { createPluginSystem, ask } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'

// ─── Helpers ───

/** Small delay to let async actor processing settle */
const tick = (ms = 50) => Bun.sleep(ms)

// ═══════════════════════════════════════════════════════════════════
// Ask Pattern
// ═══════════════════════════════════════════════════════════════════

describe('Ask pattern', () => {
  test('basic ask resolves with the response', async () => {
    type Msg =
      | { type: 'increment' }
      | { type: 'get-count'; replyTo: ActorRef<number> }

    const def: ActorDef<Msg, { count: number }> = {
      handler: (state, msg) => {
        switch (msg.type) {
          case 'increment':
            return { state: { count: state.count + 1 } }
          case 'get-count':
            msg.replyTo.send(state.count)
            return { state }
        }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('counter', def, { count: 0 })
    await tick()

    ref.send({ type: 'increment' })
    ref.send({ type: 'increment' })
    ref.send({ type: 'increment' })

    const count = await ask<Msg, number>(
      ref,
      (replyTo) => ({ type: 'get-count', replyTo }),
    )

    expect(count).toBe(3)
    await system.shutdown()
  })

  test('ask with timeout rejects when actor does not reply', async () => {
    // Actor that silently ignores the message — never replies
    const def: ActorDef<{ replyTo: ActorRef<string> }, null> = {
      handler: (state) => ({ state }),
    }

    const system = await createPluginSystem()
    const ref = system.spawn('silent', def, null)
    await tick()

    await expect(
      ask(ref, (replyTo) => ({ replyTo }), { timeoutMs: 100 }),
    ).rejects.toThrow('timed out')

    await system.shutdown()
  })

  test('late reply after timeout is silently dropped (no double-resolve)', async () => {
    let capturedReplyTo: ActorRef<string> | null = null

    type Msg =
      | { type: 'request'; replyTo: ActorRef<string> }
      | { type: 'do-reply' }

    const def: ActorDef<Msg, { replyTo: ActorRef<string> | null }> = {
      handler: (state, msg, ctx) => {
        switch (msg.type) {
          case 'request':
            capturedReplyTo = msg.replyTo
            // Delay the reply via pipeToSelf
            ctx.pipeToSelf(
              Bun.sleep(200),
              () => ({ type: 'do-reply' as const }),
              () => ({ type: 'do-reply' as const }),
            )
            return { state: { replyTo: msg.replyTo } }
          case 'do-reply':
            state.replyTo?.send('late response')
            return { state }
        }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('slow-replier', def, { replyTo: null })
    await tick()

    // Ask with a short timeout — will reject before the actor replies
    await expect(
      ask<Msg, string>(ref, (replyTo) => ({ type: 'request', replyTo }), { timeoutMs: 50 }),
    ).rejects.toThrow('timed out')

    // Wait for the actor to eventually send the late reply
    await tick(300)

    // The capturedReplyTo should exist — the actor did receive the message
    expect(capturedReplyTo).not.toBeNull()

    // Sending again on the same replyTo should be harmless (no-op)
    capturedReplyTo!.send('extra late response')

    await system.shutdown()
  })

  test('multiple asks to the same actor resolve independently', async () => {
    type Msg = { type: 'echo'; value: string; replyTo: ActorRef<string> }

    const def: ActorDef<Msg, null> = {
      handler: (state, msg) => {
        msg.replyTo.send(`echo:${msg.value}`)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('echoer', def, null)
    await tick()

    const [r1, r2, r3] = await Promise.all([
      ask<Msg, string>(ref, (replyTo) => ({ type: 'echo', value: 'a', replyTo })),
      ask<Msg, string>(ref, (replyTo) => ({ type: 'echo', value: 'b', replyTo })),
      ask<Msg, string>(ref, (replyTo) => ({ type: 'echo', value: 'c', replyTo })),
    ])

    expect(r1).toBe('echo:a')
    expect(r2).toBe('echo:b')
    expect(r3).toBe('echo:c')

    await system.shutdown()
  })

  test('ask works with pipeToSelf for delayed computation', async () => {
    type Msg =
      | { type: 'compute'; x: number; y: number; replyTo: ActorRef<number> }
      | { type: 'computed'; result: number; replyTo: ActorRef<number> }

    const def: ActorDef<Msg, null> = {
      handler: (state, msg, ctx) => {
        switch (msg.type) {
          case 'compute':
            ctx.pipeToSelf(
              Bun.sleep(30).then(() => msg.x + msg.y),
              (result) => ({ type: 'computed', result, replyTo: msg.replyTo }),
              () => ({ type: 'computed', result: -1, replyTo: msg.replyTo }),
            )
            return { state }
          case 'computed':
            msg.replyTo.send(msg.result)
            return { state }
        }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('calculator', def, null)
    await tick()

    const result = await ask<Msg, number>(
      ref,
      (replyTo) => ({ type: 'compute', x: 17, y: 25, replyTo }),
      { timeoutMs: 5000 },
    )

    expect(result).toBe(42)
    await system.shutdown()
  })

  test('ask without timeout waits indefinitely for a reply', async () => {
    type Msg =
      | { type: 'delayed-reply'; replyTo: ActorRef<string> }
      | { type: 'do-reply'; replyTo: ActorRef<string> }

    const def: ActorDef<Msg, null> = {
      handler: (state, msg, ctx) => {
        switch (msg.type) {
          case 'delayed-reply':
            ctx.pipeToSelf(
              Bun.sleep(200),
              () => ({ type: 'do-reply' as const, replyTo: msg.replyTo }),
              () => ({ type: 'do-reply' as const, replyTo: msg.replyTo }),
            )
            return { state }
          case 'do-reply':
            msg.replyTo.send('finally')
            return { state }
        }
      },
    }

    const system = await createPluginSystem()
    const ref = system.spawn('delayed', def, null)
    await tick()

    const result = await ask<Msg, string>(
      ref,
      (replyTo) => ({ type: 'delayed-reply', replyTo }),
    )

    expect(result).toBe('finally')
    await system.shutdown()
  })
})
