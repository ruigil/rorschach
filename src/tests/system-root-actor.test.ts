import { describe, test, expect } from 'bun:test'
import { createPluginSystem, SystemLifecycleTopic } from '../system/index.ts'
import type {
  ActorDef,
  LifecycleEvent,
} from '../system/index.ts'

// ─── Helpers ───

/** Small delay to let async actor processing settle */
const tick = (ms = 50) => Bun.sleep(ms)

// ═══════════════════════════════════════════════════════════════════
// System-as-Root-Actor: Symmetry Tests
// ═══════════════════════════════════════════════════════════════════

describe('System-as-root-actor: structural symmetry', () => {
  test('top-level actors are children of the root — same spawn mechanism as nested actors', async () => {
    const childNames: string[] = []

    const parentDef: ActorDef<'go', null> = {
      handler: (state, _msg, ctx) => {
        const child = ctx.spawn('nested', {
          handler: (s: null) => ({ state: s }),
        }, null)
        childNames.push(child.name)
        return { state }
      },
    }

    const system = await createPluginSystem()
    const parent = system.spawn('parent', parentDef, null)
    await tick()

    parent.send('go')
    await tick()

    // Both top-level and nested use the same naming convention
    expect(parent.name).toBe('system/parent')
    expect(childNames[0]).toBe('system/parent/nested')

    await system.shutdown()
  })

  test('shutdown cascades through the root actor — same as stopping any parent', async () => {
    const stopOrder: string[] = []

    const makeLeaf = (label: string): ActorDef<string, null> => ({
      handler: (state) => ({ state }),
      lifecycle: (state, event) => {
        if (event.type === 'stopped') stopOrder.push(label)
        return { state }
      },
    })

    const parentDef: ActorDef<string, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          ctx.spawn('child-a', makeLeaf('child-a'), null)
          ctx.spawn('child-b', makeLeaf('child-b'), null)
        }
        if (event.type === 'stopped') stopOrder.push('parent')
        return { state }
      },
      handler: (state) => ({ state }),
    }

    const system = await createPluginSystem()
    system.spawn('parent', parentDef, null)
    await tick(100)

    await system.shutdown()

    // All actors received their stopped lifecycle event
    expect(stopOrder).toContain('child-a')
    expect(stopOrder).toContain('child-b')
    expect(stopOrder).toContain('parent')
  })

  test('implicit child watch works for root — terminated events delivered on shutdown', async () => {
    const events: LifecycleEvent[] = []

    const system = await createPluginSystem()
    system.subscribe(SystemLifecycleTopic, (e) => events.push(e as LifecycleEvent))

    system.spawn('a', { handler: (state: null) => ({ state }) }, null)
    system.spawn('b', { handler: (state: null) => ({ state }) }, null)
    await tick()

    await system.shutdown()

    const terminated = events.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(2)

    const names = terminated
      .map((e) => (e.type === 'terminated' ? e.ref.name : ''))
      .sort()
    expect(names).toEqual(['system/a', 'system/b'])
  })

  test('root lifecycle handler receives terminated events when children fail', async () => {
    const events: LifecycleEvent[] = []

    const failingDef: ActorDef<'fail', null> = {
      handler: () => {
        throw new Error('boom')
      },
    }

    const system = await createPluginSystem()
    system.subscribe(SystemLifecycleTopic, (e) => events.push(e as LifecycleEvent))
    const ref = system.spawn('doomed', failingDef, null)
    await tick()

    ref.send('fail')
    await tick(200)

    const terminated = events.filter((e) => e.type === 'terminated')
    expect(terminated.length).toBe(1)
    if (terminated[0]!.type === 'terminated') {
      expect(terminated[0]!.ref.name).toBe('system/doomed')
      expect(terminated[0]!.reason).toBe('failed')
    }

    await system.shutdown()
  })

  test('auto-cleanup: can re-spawn actor with same name after it terminates', async () => {
    const received: string[] = []

    const def: ActorDef<string, null> = {
      handler: (state, msg) => {
        received.push(msg)
        return { state }
      },
    }

    const failDef: ActorDef<string, null> = {
      handler: () => { throw new Error('fail') },
    }

    const system = await createPluginSystem()

    // Spawn an actor that will fail
    const ref1 = system.spawn('worker', failDef, null)
    await tick()
    ref1.send('trigger')
    await tick(200)

    // Re-spawn with the same name (terminated child was auto-cleaned from root's children map)
    const ref2 = system.spawn('worker', def, null)
    await tick()

    ref2.send('hello')
    await tick()

    expect(ref2.name).toBe('system/worker')
    expect(received).toEqual(['hello'])

    await system.shutdown()
  })
})
