import { describe, test, expect } from 'bun:test'
import { AgentSystem, onLifecycle, watchTopic } from '../system/index.ts'
import type { ActorDef, LifecycleEvent, WatchStatusEvent } from '../system/index.ts'
import { createEventStream } from '../system/actor/services.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const isAliveStatus = (e: LifecycleEvent): e is WatchStatusEvent =>
  e.type === 'watchStatus' && e.status !== 'terminated'

const isTerminated = (e: LifecycleEvent): e is WatchStatusEvent =>
  e.type === 'watchStatus' && e.status === 'terminated'

// ═══════════════════════════════════════════════════════════════════
// Actor Health: reportStatus + watch channel
// ═══════════════════════════════════════════════════════════════════

describe('Actor health: reportStatus delivery', () => {
  test('child reportStatus delivers watchStatus to parent lifecycle', async () => {
    const parentEvents: LifecycleEvent[] = []

    type ChildMsg = { type: 'report'; status: 'degraded'; detail: string }

    const childDef: ActorDef<ChildMsg, null> = {
      handler: (state, msg, ctx) => {
        if (msg.type === 'report') {
          ctx.reportStatus({ status: msg.status, detail: msg.detail })
        }
        return { state }
      },
    }

    type ParentMsg = { type: 'spawn' } | { type: 'tell-child' }

    const parentDef: ActorDef<ParentMsg, { child: ReturnType<typeof Object> | null }> = {
      handler: (state, msg, ctx) => {
        if (msg.type === 'spawn') {
          const child = ctx.spawn('kid', childDef)
          return { state: { child } }
        }
        if (msg.type === 'tell-child' && state.child) {
          ;(state.child as { send: (m: ChildMsg) => void }).send({
            type: 'report',
            status: 'degraded',
            detail: 'API key missing',
          })
        }
        return { state }
      },
      lifecycle: (state, event) => {
        if (event.type === 'watchStatus') parentEvents.push(event)
        return { state }
      },
    }

    const system = await AgentSystem()
    const parent = system.spawn('parent', parentDef, { state: { child: null } })
    await tick()

    parent.send({ type: 'spawn' })
    await tick()

    parent.send({ type: 'tell-child' })
    await tick()

    const degraded = parentEvents.filter(
      (e) => e.type === 'watchStatus' && e.status === 'degraded',
    )
    expect(degraded.length).toBe(1)
    if (degraded[0]!.type === 'watchStatus') {
      expect(degraded[0]!.ref.name).toBe('system/parent/kid')
      expect(degraded[0]!.detail).toBe('API key missing')
    }

    await system.shutdown()
  })

  test('watcher receives status updates then terminated on one stream', async () => {
    type TargetMsg = { type: 'degrade' } | { type: 'recover' }

    const targetDef: ActorDef<TargetMsg, null> = {
      handler: (state, msg, ctx) => {
        if (msg.type === 'degrade') ctx.reportStatus({ status: 'degraded', detail: 'slow' })
        if (msg.type === 'recover') ctx.reportStatus({ status: 'ok' })
        return { state }
      },
    }

    type CoordMsg =
      | { type: 'setup' }
      | { type: 'degrade' }
      | { type: 'recover' }
      | { type: 'stop-target' }

    const events: LifecycleEvent[] = []
    const coordDef: ActorDef<CoordMsg, { target: any }> = {
      handler: (state, msg, ctx) => {
        if (msg.type === 'setup') {
          const t = ctx.spawn('t', targetDef)
          ctx.watch(t)
          return { state: { target: t } }
        }
        if (msg.type === 'degrade') {
          state.target?.send({ type: 'degrade' })
          return { state }
        }
        if (msg.type === 'recover') {
          state.target?.send({ type: 'recover' })
          return { state }
        }
        if (msg.type === 'stop-target') {
          if (state.target) ctx.stop(state.target)
          return { state }
        }
        return { state }
      },
      lifecycle: (state, event) => {
        if (event.type === 'watchStatus') events.push(event)
        return { state }
      },
    }

    const system = await AgentSystem()
    const coord = system.spawn('coord', coordDef, { state: { target: null } })
    await tick()
    coord.send({ type: 'setup' })
    await tick()
    coord.send({ type: 'degrade' })
    await tick()
    coord.send({ type: 'recover' })
    await tick()
    coord.send({ type: 'stop-target' })
    await tick()

    const statuses = events
      .filter((e) => e.type === 'watchStatus')
      .map((e) => (e.type === 'watchStatus' ? e.status : ''))

    // auto-ok (child start), degrade, recover, terminated
    expect(statuses).toContain('ok')
    expect(statuses).toContain('degraded')
    expect(statuses[statuses.length - 1]).toBe('terminated')

    const lastAliveIdx = [...statuses].map((s, i) => (s !== 'terminated' ? i : -1)).filter((i) => i >= 0).pop()
    const termIdx = statuses.lastIndexOf('terminated')
    expect(termIdx).toBeGreaterThan(lastAliveIdx ?? -1)

    await system.shutdown()
  })

  test('late watcher replays retained alive status', async () => {
    const replayed: WatchStatusEvent[] = []

    type TargetMsg = { type: 'degrade' }
    const targetDef: ActorDef<TargetMsg, null> = {
      handler: (state, msg, ctx) => {
        if (msg.type === 'degrade') {
          ctx.reportStatus({ status: 'unavailable', detail: 'down' })
        }
        return { state }
      },
    }

    type ParentMsg = { type: 'spawn' } | { type: 'degrade' } | { type: 'late-watch' }

    const parentDef: ActorDef<ParentMsg, { child: any }> = {
      handler: (state, msg, ctx) => {
        if (msg.type === 'spawn') {
          return { state: { child: ctx.spawn('late-target', targetDef) } }
        }
        if (msg.type === 'degrade' && state.child) {
          state.child.send({ type: 'degrade' })
          return { state }
        }
        if (msg.type === 'late-watch') {
          // Spawn peer that watches after status is already set
          ctx.spawn('late-watcher', {
            initialState: null,
            handler: (s: null) => ({ state: s }),
            lifecycle: onLifecycle({
              start(s, c) {
                if (state.child) c.watch(state.child)
                return { state: s }
              },
              watchStatus(s, event) {
                if (event.status !== 'terminated') replayed.push(event)
                return { state: s }
              },
            }),
          } as ActorDef<unknown, null>)
          return { state }
        }
        return { state }
      },
    }

    const system = await AgentSystem()
    const parent = system.spawn('late-parent', parentDef, { state: { child: null } })
    await tick()
    parent.send({ type: 'spawn' })
    await tick()
    parent.send({ type: 'degrade' })
    await tick()
    parent.send({ type: 'late-watch' })
    await tick()

    expect(replayed.some((e) => e.status === 'unavailable' && e.detail === 'down')).toBe(true)

    await system.shutdown()
  })

  test('identical reportStatus calls are deduped', async () => {
    const statuses: string[] = []

    type ChildMsg = { type: 'report' }
    const childDef: ActorDef<ChildMsg, null> = {
      // Report degraded in start so no auto-ok, then identical reports from handler
      lifecycle: onLifecycle({
        start(state, ctx) {
          ctx.reportStatus({ status: 'degraded', detail: 'same' })
          return { state }
        },
      }),
      handler: (state, _msg, ctx) => {
        ctx.reportStatus({ status: 'degraded', detail: 'same' })
        return { state }
      },
    }

    type ParentMsg = { type: 'spawn' } | { type: 'nudge' }
    const parentDef: ActorDef<ParentMsg, { child: any }> = {
      handler: (state, msg, ctx) => {
        if (msg.type === 'spawn') {
          return { state: { child: ctx.spawn('dup', childDef) } }
        }
        if (msg.type === 'nudge' && state.child) {
          state.child.send({ type: 'report' })
          state.child.send({ type: 'report' })
          return { state }
        }
        return { state }
      },
      lifecycle: (state, event) => {
        if (event.type === 'watchStatus' && event.ref.name.endsWith('/dup')) {
          statuses.push(event.status)
        }
        return { state }
      },
    }

    const system = await AgentSystem()
    const parent = system.spawn('dedupe-parent', parentDef, { state: { child: null } })
    await tick()
    parent.send({ type: 'spawn' })
    await tick()
    parent.send({ type: 'nudge' })
    await tick()

    // Only one degraded from start; identical handler reports deduped
    expect(statuses.filter((s) => s === 'degraded')).toHaveLength(1)

    await system.shutdown()
  })

  test('same status with new detail emits a second event', async () => {
    const details: (string | undefined)[] = []

    type ChildMsg = { type: 'a' } | { type: 'b' }
    const childDef: ActorDef<ChildMsg, null> = {
      lifecycle: onLifecycle({
        start(state, ctx) {
          ctx.reportStatus({ status: 'degraded', detail: 'first' })
          return { state }
        },
      }),
      handler: (state, msg, ctx) => {
        if (msg.type === 'b') ctx.reportStatus({ status: 'degraded', detail: 'second' })
        return { state }
      },
    }

    type ParentMsg = { type: 'spawn' } | { type: 'update' }
    const parentDef: ActorDef<ParentMsg, { child: any }> = {
      handler: (state, msg, ctx) => {
        if (msg.type === 'spawn') return { state: { child: ctx.spawn('d', childDef) } }
        if (msg.type === 'update' && state.child) {
          state.child.send({ type: 'b' })
          return { state }
        }
        return { state }
      },
      lifecycle: (state, event) => {
        if (event.type === 'watchStatus' && event.status === 'degraded') {
          details.push(event.detail)
        }
        return { state }
      },
    }

    const system = await AgentSystem()
    const parent = system.spawn('detail-parent', parentDef, { state: { child: null } })
    await tick()
    parent.send({ type: 'spawn' })
    await tick()
    parent.send({ type: 'update' })
    await tick()

    expect(details).toEqual(['first', 'second'])

    await system.shutdown()
  })
})

describe('Actor health: auto-ok and failure', () => {
  test('child with no report during start yields auto-ok to parent', async () => {
    const statuses: string[] = []

    const childDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
    }

    type ParentMsg = { type: 'spawn' }
    const parentDef: ActorDef<ParentMsg, null> = {
      handler: (state, msg, ctx) => {
        if (msg.type === 'spawn') ctx.spawn('simple', childDef)
        return { state }
      },
      lifecycle: (state, event) => {
        if (event.type === 'watchStatus' && event.ref.name.endsWith('/simple')) {
          statuses.push(event.status)
        }
        return { state }
      },
    }

    const system = await AgentSystem()
    const parent = system.spawn('auto-ok-parent', parentDef)
    await tick()
    parent.send({ type: 'spawn' })
    await tick()

    expect(statuses[0]).toBe('ok')

    await system.shutdown()
  })

  test('start failure publishes watchStatus terminated failed with no green health', async () => {
    const events: LifecycleEvent[] = []

    const boomDef: ActorDef<string, null> = {
      handler: (state) => ({ state }),
      lifecycle: onLifecycle({
        start() {
          throw new Error('start boom')
        },
      }),
    }

    type ParentMsg = { type: 'spawn' }
    const parentDef: ActorDef<ParentMsg, null> = {
      handler: (state, msg, ctx) => {
        if (msg.type === 'spawn') ctx.spawn('boom', boomDef)
        return { state }
      },
      lifecycle: (state, event) => {
        if (event.type === 'watchStatus' && event.ref.name.endsWith('/boom')) {
          events.push(event)
        }
        return { state }
      },
    }

    const system = await AgentSystem()
    const parent = system.spawn('fail-parent', parentDef)
    await tick()
    parent.send({ type: 'spawn' })
    await tick(100)

    expect(events.some(isAliveStatus)).toBe(false)
    const term = events.filter(isTerminated)
    expect(term.length).toBe(1)
    expect(term[0]!.reason).toBe('failed')

    await system.shutdown()
  })

  test('after supervised restart without report, parent sees auto-ok again', async () => {
    const statuses: string[] = []

    type ChildMsg = { type: 'fail' }
    const childDef: ActorDef<ChildMsg, null> = {
      supervision: { type: 'restart', maxRetries: 3 },
      handler: (state, msg) => {
        if (msg.type === 'fail') throw new Error('boom')
        return { state }
      },
    }

    type ParentMsg = { type: 'spawn' } | { type: 'poke' }
    const parentDef: ActorDef<ParentMsg, { child: any }> = {
      handler: (state, msg, ctx) => {
        if (msg.type === 'spawn') return { state: { child: ctx.spawn('fragile', childDef) } }
        if (msg.type === 'poke' && state.child) {
          state.child.send({ type: 'fail' })
          return { state }
        }
        return { state }
      },
      lifecycle: (state, event) => {
        if (event.type === 'watchStatus' && event.ref.name.endsWith('/fragile')) {
          statuses.push(event.status)
        }
        return { state }
      },
    }

    const system = await AgentSystem()
    const parent = system.spawn('restart-parent', parentDef, { state: { child: null } })
    await tick()
    parent.send({ type: 'spawn' })
    await tick()
    parent.send({ type: 'poke' })
    await tick(200)

    // initial auto-ok, then auto-ok after restart (no terminated for restart)
    const oks = statuses.filter((s) => s === 'ok')
    expect(oks.length).toBeGreaterThanOrEqual(2)

    await system.shutdown()
  })
})

describe('Actor health: snapshot and teardown', () => {
  test('actorSnapshots includes health after reportStatus', async () => {
    type Msg = { type: 'snap'; reply: (s: unknown) => void } | { type: 'degrade' }

    const def: ActorDef<Msg, null> = {
      lifecycle: onLifecycle({
        start(state, ctx) {
          ctx.reportStatus({ status: 'degraded', detail: 'partial' })
          return { state }
        },
      }),
      handler: (state, msg, ctx) => {
        if (msg.type === 'snap') {
          msg.reply(ctx.actorSnapshots().find((s) => s.name === ctx.self.name))
        }
        if (msg.type === 'degrade') {
          ctx.reportStatus({ status: 'unavailable', detail: 'worse' })
        }
        return { state }
      },
    }

    const system = await AgentSystem()
    const ref = system.spawn('snap-actor', def)
    await tick()

    let snapshot: any
    ref.send({
      type: 'snap',
      reply: (s) => {
        snapshot = s
      },
    })
    await tick()

    expect(snapshot?.health?.status).toBe('degraded')
    expect(snapshot?.health?.detail).toBe('partial')

    await system.shutdown()
  })

  test('snapshot health is cleared after stop', async () => {
    const def: ActorDef<never, null> = {
      lifecycle: onLifecycle({
        start(state, ctx) {
          ctx.reportStatus({ status: 'ok', detail: 'fine' })
          return { state }
        },
      }),
      handler: (state) => ({ state }),
    }

    type ObsMsg = { type: 'go' } | { type: 'stop-victim' }
    let afterStop: { present: boolean; health?: unknown } | null = null

    const observerDef: ActorDef<ObsMsg, { target: any }> = {
      handler: (state, msg, ctx) => {
        if (msg.type === 'go') {
          const target = ctx.spawn('victim', def)
          return { state: { target } }
        }
        if (msg.type === 'stop-victim' && state.target) {
          ctx.stop(state.target)
          return { state }
        }
        return { state }
      },
      lifecycle: (state, event, ctx) => {
        if (
          event.type === 'watchStatus' &&
          event.status === 'terminated' &&
          event.ref.name.endsWith('/victim')
        ) {
          const snap = ctx.actorSnapshots().find((s) => s.name.endsWith('/victim'))
          afterStop = { present: !!snap, health: snap?.health }
        }
        return { state }
      },
    }

    const system = await AgentSystem()
    const obs = system.spawn('obs', observerDef, { state: { target: null } })
    await tick()
    obs.send({ type: 'go' })
    await tick()
    obs.send({ type: 'stop-victim' })
    await tick(100)

    expect(afterStop).not.toBeNull()
    // Actor may still be in registry briefly as stopping/stopped without health, or fully gone
    expect(afterStop!.health).toBeUndefined()

    await system.shutdown()
  })

  test('deleteTopic clears retained values', () => {
    const stream = createEventStream()
    const topic = watchTopic('test-actor') as any
    stream.publishRetained(topic, 'test-actor', {
      type: 'watchStatus',
      ref: { name: 'test-actor' },
      status: 'ok',
    })
    expect(stream.getRetainedValue(topic, 'test-actor')).toBeDefined()
    stream.deleteTopic(topic)
    expect(stream.getRetainedValue(topic, 'test-actor')).toBeUndefined()
  })

  test('after stop, late watch synthesizes terminated without retained green', async () => {
    const lateEvents: LifecycleEvent[] = []

    type TargetMsg = never
    const targetDef: ActorDef<TargetMsg, null> = {
      lifecycle: onLifecycle({
        start(state, ctx) {
          ctx.reportStatus({ status: 'ok' })
          return { state }
        },
      }),
      handler: (state) => ({ state }),
    }

    type ParentMsg = { type: 'spawn-and-stop' } | { type: 'late' }
    const parentDef: ActorDef<ParentMsg, { child: any }> = {
      handler: (state, msg, ctx) => {
        if (msg.type === 'spawn-and-stop') {
          const child = ctx.spawn('gone', targetDef)
          ctx.stop(child)
          return { state: { child } }
        }
        if (msg.type === 'late') {
          ctx.spawn('late', {
            initialState: null,
            handler: (s: null) => ({ state: s }),
            lifecycle: onLifecycle({
              start(s, c) {
                if (state.child) c.watch(state.child)
                return { state: s }
              },
              watchStatus(s, event) {
                lateEvents.push(event)
                return { state: s }
              },
            }),
          } as ActorDef<unknown, null>)
          return { state }
        }
        return { state }
      },
    }

    const system = await AgentSystem()
    const parent = system.spawn('teardown-parent', parentDef, { state: { child: null } })
    await tick()
    parent.send({ type: 'spawn-and-stop' })
    await tick()
    parent.send({ type: 'late' })
    await tick()

    expect(lateEvents.every((e) => e.type === 'watchStatus' && e.status === 'terminated')).toBe(true)
    expect(lateEvents.some(isAliveStatus)).toBe(false)

    await system.shutdown()
  })
})
