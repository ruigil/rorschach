import { describe, test, expect } from 'bun:test'
import { createActorSystem } from '../system/index.ts'
import type { ActorDef } from '../system/index.ts'

/** Small delay to let async actor processing settle */
const tick = (ms = 50) => Bun.sleep(ms)

// ═══════════════════════════════════════════════════════════════════
// pipeToSelf: Async Effects
// ═══════════════════════════════════════════════════════════════════

describe('pipeToSelf', () => {
  test('delivers the adapted success message when the promise resolves', async () => {
    const received: string[] = []

    type Msg =
      | { type: 'fetch' }
      | { type: 'result'; data: string }

    const def: ActorDef<Msg, null> = {
      handler: (state, msg, ctx) => {
        switch (msg.type) {
          case 'fetch':
            ctx.pipeToSelf(
              Promise.resolve('hello from async'),
              (data) => ({ type: 'result', data }),
              (err) => ({ type: 'result', data: `error: ${err}` }),
            )
            return { state }
          case 'result':
            received.push(msg.data)
            return { state }
        }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('pipe-success', def, null)
    await tick()

    ref.send({ type: 'fetch' })
    await tick()

    expect(received).toEqual(['hello from async'])
    await system.shutdown()
  })

  test('delivers the adapted failure message when the promise rejects', async () => {
    const received: string[] = []

    type Msg =
      | { type: 'fetch' }
      | { type: 'success'; data: string }
      | { type: 'failure'; error: string }

    const def: ActorDef<Msg, null> = {
      handler: (state, msg, ctx) => {
        switch (msg.type) {
          case 'fetch':
            ctx.pipeToSelf(
              Promise.reject(new Error('network down')),
              (data) => ({ type: 'success', data }),
              (err) => ({ type: 'failure', error: (err as Error).message }),
            )
            return { state }
          case 'success':
            received.push(`ok: ${msg.data}`)
            return { state }
          case 'failure':
            received.push(`fail: ${msg.error}`)
            return { state }
        }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('pipe-failure', def, null)
    await tick()

    ref.send({ type: 'fetch' })
    await tick()

    expect(received).toEqual(['fail: network down'])
    await system.shutdown()
  })

  test('does not block the actor — messages sent after pipeToSelf are processed first', async () => {
    const order: string[] = []

    type Msg =
      | { type: 'startAsync' }
      | { type: 'sync'; label: string }
      | { type: 'asyncDone'; value: number }

    const def: ActorDef<Msg, null> = {
      handler: (state, msg, ctx) => {
        switch (msg.type) {
          case 'startAsync':
            ctx.pipeToSelf(
              // Delay so the piped result arrives after sync messages
              new Promise<number>((resolve) => setTimeout(() => resolve(42), 80)),
              (v) => ({ type: 'asyncDone', value: v }),
              () => ({ type: 'asyncDone', value: -1 }),
            )
            order.push('startAsync')
            return { state }
          case 'sync':
            order.push(`sync:${msg.label}`)
            return { state }
          case 'asyncDone':
            order.push(`asyncDone:${msg.value}`)
            return { state }
        }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('non-blocking', def, null)
    await tick()

    ref.send({ type: 'startAsync' })
    ref.send({ type: 'sync', label: 'a' })
    ref.send({ type: 'sync', label: 'b' })
    await tick(200)

    // Sync messages must be processed before the delayed async result
    expect(order).toEqual(['startAsync', 'sync:a', 'sync:b', 'asyncDone:42'])
    await system.shutdown()
  })

  test('silently drops the piped result if the actor has stopped', async () => {
    const received: string[] = []

    type Msg =
      | { type: 'startAsync' }
      | { type: 'result'; data: string }

    const def: ActorDef<Msg, null> = {
      handler: (state, msg, ctx) => {
        switch (msg.type) {
          case 'startAsync':
            ctx.pipeToSelf(
              new Promise<string>((resolve) => setTimeout(() => resolve('late'), 100)),
              (data) => ({ type: 'result', data }),
              () => ({ type: 'result', data: 'error' }),
            )
            return { state }
          case 'result':
            received.push(msg.data)
            return { state }
        }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('stop-before-resolve', def, null)
    await tick()

    ref.send({ type: 'startAsync' })
    await tick(20) // Let pipeToSelf fire, but not resolve yet

    // Stop the actor before the promise resolves
    system.stop({ name: 'system/stop-before-resolve' })
    await tick(200) // Wait well past the promise resolution

    // The result should NOT have been delivered
    expect(received).toEqual([])
    await system.shutdown()
  })

  test('handles multiple concurrent pipeToSelf calls sequentially', async () => {
    const results: number[] = []

    type Msg =
      | { type: 'startAll' }
      | { type: 'result'; value: number }

    const def: ActorDef<Msg, null> = {
      handler: (state, msg, ctx) => {
        switch (msg.type) {
          case 'startAll':
            // Fire three concurrent async effects with different delays
            ctx.pipeToSelf(
              new Promise<number>((r) => setTimeout(() => r(1), 60)),
              (v) => ({ type: 'result', value: v }),
              () => ({ type: 'result', value: -1 }),
            )
            ctx.pipeToSelf(
              new Promise<number>((r) => setTimeout(() => r(2), 20)),
              (v) => ({ type: 'result', value: v }),
              () => ({ type: 'result', value: -1 }),
            )
            ctx.pipeToSelf(
              new Promise<number>((r) => setTimeout(() => r(3), 40)),
              (v) => ({ type: 'result', value: v }),
              () => ({ type: 'result', value: -1 }),
            )
            return { state }
          case 'result':
            results.push(msg.value)
            return { state }
        }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('multi-pipe', def, null)
    await tick()

    ref.send({ type: 'startAll' })
    await tick(200)

    // All three results arrive — in order of resolution (shortest delay first)
    expect(results).toEqual([2, 3, 1])
    await system.shutdown()
  })

  test('state evolves correctly through the loading → result cycle', async () => {
    type Msg =
      | { type: 'load' }
      | { type: 'loaded'; data: string }
      | { type: 'failed'; error: string }
      | { type: 'snapshot'; reply: (state: State) => void }

    type State = {
      loading: boolean
      data: string | null
      error: string | null
    }

    const def: ActorDef<Msg, State> = {
      handler: (state, msg, ctx) => {
        switch (msg.type) {
          case 'load':
            ctx.pipeToSelf(
              new Promise<string>((resolve) => setTimeout(() => resolve('payload'), 30)),
              (data) => ({ type: 'loaded', data }),
              (err) => ({ type: 'failed', error: String(err) }),
            )
            return { state: { ...state, loading: true } }
          case 'loaded':
            return { state: { ...state, loading: false, data: msg.data } }
          case 'failed':
            return { state: { ...state, loading: false, error: msg.error } }
          case 'snapshot':
            msg.reply(state)
            return { state }
        }
      },
    }

    const system = createActorSystem()
    const ref = system.spawn('state-cycle', def, { loading: false, data: null, error: null })
    await tick()

    // Capture state before load
    let snapshot: State | null = null
    ref.send({ type: 'snapshot', reply: (s) => { snapshot = s } })
    await tick()
    expect(snapshot).toEqual({ loading: false, data: null, error: null })

    // Start loading
    ref.send({ type: 'load' })
    await tick(10)

    // Capture state during loading (before promise resolves)
    ref.send({ type: 'snapshot', reply: (s) => { snapshot = s } })
    await tick(10)
    expect(snapshot!.loading).toBe(true)

    // Wait for resolution
    await tick(100)

    // Capture final state
    ref.send({ type: 'snapshot', reply: (s) => { snapshot = s } })
    await tick()
    expect(snapshot!).toEqual({ loading: false, data: 'payload', error: null })

    await system.shutdown()
  })
})
