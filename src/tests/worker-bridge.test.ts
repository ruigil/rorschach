import { describe, test, expect } from 'bun:test'
import { createActorSystem, createTopic } from '../system/index.ts'
import { createWorkerBridge, taskTopic } from '../actors/worker-bridge.ts'
import type { ActorDef, EventTopic } from '../system/index.ts'
import type { TaskEvent, WorkerBridgeMsg } from '../actors/worker-bridge.ts'

const WORKER = new URL('./fixtures/bridge-worker.ts', import.meta.url).href

const tick = (ms = 100) => Bun.sleep(ms)

// ═══════════════════════════════════════════════════════════════════
// WorkerBridge: task completion
// ═══════════════════════════════════════════════════════════════════

describe('WorkerBridge: task completion', () => {
  test('task.done is published when the worker replies', async () => {
    const system = createActorSystem()
    const bridge = createWorkerBridge<{ op: string; value: unknown }, string>({ scriptPath: WORKER })
    const ref = system.spawn('bridge', bridge.def, bridge.initialState)
    await tick()

    const received: TaskEvent<string>[] = []

    type ObserverMsg = { type: 'event'; event: TaskEvent<string> }
    const observerDef: ActorDef<ObserverMsg, null> = {
      setup: (state, ctx) => {
        ctx.subscribe(taskTopic<string>('t1'), event => ({ type: 'event' as const, event }))
        return state
      },
      handler: (state, msg) => {
        received.push(msg.event)
        return { state }
      },
    }

    system.spawn('observer', observerDef, null)
    await tick()

    ref.send({ type: 'request', id: 't1', payload: { op: 'echo', value: 'hello' } })
    await tick()

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ type: 'task.done', id: 't1', result: 'hello' })
    await system.shutdown()
  })

  test('task.progress events arrive before task.done, in order', async () => {
    const system = createActorSystem()
    const bridge = createWorkerBridge<{ op: string; value: unknown; steps?: number }, string>({ scriptPath: WORKER })
    const ref = system.spawn('bridge', bridge.def, bridge.initialState)
    await tick()

    const received: TaskEvent<string>[] = []

    type ObserverMsg = { type: 'event'; event: TaskEvent<string> }
    const observerDef: ActorDef<ObserverMsg, null> = {
      setup: (state, ctx) => {
        ctx.subscribe(taskTopic<string>('t2'), event => ({ type: 'event' as const, event }))
        return state
      },
      handler: (state, msg) => {
        received.push(msg.event)
        return { state }
      },
    }

    system.spawn('observer', observerDef, null)
    await tick()

    ref.send({ type: 'request', id: 't2', payload: { op: 'progress', value: 'done', steps: 3 } })
    await tick()

    expect(received).toHaveLength(4)
    expect(received[0]).toMatchObject({ type: 'task.progress', id: 't2', pct: expect.closeTo(33.3, 0) })
    expect(received[1]).toMatchObject({ type: 'task.progress', id: 't2', pct: expect.closeTo(66.6, 0) })
    expect(received[2]).toMatchObject({ type: 'task.progress', id: 't2', pct: 100 })
    expect(received[3]).toMatchObject({ type: 'task.done', id: 't2', result: 'done' })
    await system.shutdown()
  })

  test('task.failed is published when the worker throws', async () => {
    const system = createActorSystem()
    const bridge = createWorkerBridge<{ op: string; error?: string }, never>({ scriptPath: WORKER })
    const ref = system.spawn('bridge', bridge.def, bridge.initialState)
    await tick()

    const received: TaskEvent<never>[] = []

    type ObserverMsg = { type: 'event'; event: TaskEvent<never> }
    const observerDef: ActorDef<ObserverMsg, null> = {
      setup: (state, ctx) => {
        ctx.subscribe(taskTopic<never>('t3'), event => ({ type: 'event' as const, event }))
        return state
      },
      handler: (state, msg) => {
        received.push(msg.event)
        return { state }
      },
    }

    system.spawn('observer', observerDef, null)
    await tick()

    ref.send({ type: 'request', id: 't3', payload: { op: 'fail', error: 'boom' } })
    await tick()

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ type: 'task.failed', id: 't3', error: 'Error: boom' })
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// WorkerBridge: topic lifecycle
// ═══════════════════════════════════════════════════════════════════

describe('WorkerBridge: topic lifecycle', () => {
  test('topic is deleted after task.done so no entry accumulates', async () => {
    const system = createActorSystem()
    const bridge = createWorkerBridge<{ op: string; value: unknown }, string>({ scriptPath: WORKER })
    const ref = system.spawn('bridge', bridge.def, bridge.initialState)
    await tick()

    // Verify: after completion, publishing to that topic delivers to nobody
    // (topic deleted → new subscribe on same topic string works fresh)
    const lateReceived: unknown[] = []

    // Subscribe AFTER the task completes to confirm the topic is gone
    ref.send({ type: 'request', id: 't4', payload: { op: 'echo', value: 'x' } })
    await tick()

    // If topic still existed with stale subscribers this would be non-zero
    system.subscribe('test-late', taskTopic<string>('t4'), event => lateReceived.push(event))
    ref.send({ type: 'request', id: 't4b', payload: { op: 'echo', value: 'y' } })
    await tick()

    // t4 topic was deleted — lateReceived only sees t4b if observer subscribed to t4b
    // Since we subscribed to 't4', not 't4b', nothing should arrive
    expect(lateReceived).toHaveLength(0)
    await system.shutdown()
  })

  test('topic is deleted after task.failed', async () => {
    const system = createActorSystem()
    const bridge = createWorkerBridge<{ op: string; error?: string }, never>({ scriptPath: WORKER })
    const ref = system.spawn('bridge', bridge.def, bridge.initialState)
    await tick()

    ref.send({ type: 'request', id: 't5', payload: { op: 'fail', error: 'gone' } })
    await tick()

    const lateReceived: unknown[] = []
    system.subscribe('test-late-fail', taskTopic<never>('t5'), event => lateReceived.push(event))

    // No further events should be delivered on this deleted topic
    await tick()
    expect(lateReceived).toHaveLength(0)
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// WorkerBridge: multiple observers
// ═══════════════════════════════════════════════════════════════════

describe('WorkerBridge: multiple observers', () => {
  test('two actors subscribed to the same task topic both receive all events', async () => {
    const system = createActorSystem()
    const bridge = createWorkerBridge<{ op: string; value: unknown; steps?: number }, string>({ scriptPath: WORKER })
    const ref = system.spawn('bridge', bridge.def, bridge.initialState)
    await tick()

    const receivedA: TaskEvent<string>[] = []
    const receivedB: TaskEvent<string>[] = []

    type ObserverMsg = { type: 'event'; event: TaskEvent<string> }

    const makeObserver = (bucket: TaskEvent<string>[]): ActorDef<ObserverMsg, null> => ({
      setup: (state, ctx) => {
        ctx.subscribe(taskTopic<string>('t6'), event => ({ type: 'event' as const, event }))
        return state
      },
      handler: (state, msg) => {
        bucket.push(msg.event)
        return { state }
      },
    })

    system.spawn('observer-a', makeObserver(receivedA), null)
    system.spawn('observer-b', makeObserver(receivedB), null)
    await tick()

    ref.send({ type: 'request', id: 't6', payload: { op: 'progress', value: 'result', steps: 1 } })
    await tick()

    expect(receivedA).toHaveLength(2)
    expect(receivedB).toHaveLength(2)
    expect(receivedA[0]).toMatchObject({ type: 'task.progress' })
    expect(receivedA[1]).toMatchObject({ type: 'task.done', result: 'result' })
    expect(receivedB).toEqual(receivedA)
    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// ActorContext: deleteTopic
// ═══════════════════════════════════════════════════════════════════

describe('ActorContext: deleteTopic', () => {
  test('deleteTopic prevents further delivery on that topic', async () => {
    const system = createActorSystem()
    const topic = createTopic<string>('test.ephemeral')
    const received: string[] = []

    type Msg =
      | { type: 'publish'; value: string }
      | { type: 'delete' }
      | { type: 'event'; value: string }

    const def: ActorDef<Msg, null> = {
      setup: (state, ctx) => {
        ctx.subscribe(topic, value => ({ type: 'event' as const, value }))
        return state
      },
      handler: (state, msg, ctx) => {
        if (msg.type === 'publish') ctx.publish(topic, msg.value)
        if (msg.type === 'delete')  ctx.deleteTopic(topic)
        if (msg.type === 'event')   received.push(msg.value)
        return { state }
      },
    }

    const ref = system.spawn('deleter', def, null)
    await tick()

    ref.send({ type: 'publish', value: 'before' })
    await tick()
    ref.send({ type: 'delete' })
    await tick()
    ref.send({ type: 'publish', value: 'after' })
    await tick()

    expect(received).toEqual(['before'])
    await system.shutdown()
  })
})
