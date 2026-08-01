import { describe, test, expect } from 'bun:test'
import {
  AgentSystem,
  onMessage,
  onLifecycle,
  ask,
  createPluginFactory,
  staticSource} from '../system/index.ts'
import type { ActorDef } from '../system/index.ts'
import { OutboundAdminBroadcastTopic } from '../types/events.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const statusOf = (system: any, id: string) =>
  system.control().snapshotActual().plugins.find((p: any) => p.id === id)

describe('Plugin Health Reporting', () => {
  test('derives baseline health status correctly', async () => {
    const mockPlugin = createPluginFactory({
      id: 'mock-health-degraded',
      version: '1.0.0',
      description: 'health degraded',
      configDescriptor: { key: 'mock-health-degraded', defaults: {} } as any,
      slots: {
        requiredSlot: {
          factory: () => ({
            initialState: null,
            handler: (s) => ({ state: s }),
          }),
        },
        optionalSlot: {
          factory: () => null, // simulating unspawned/degraded optional slot
        },
      },
    })

    const system = await AgentSystem({ source: staticSource({ plugins: [mockPlugin], config: {} }) })

    const status = statusOf(system, 'mock-health-degraded')
    expect(status).toBeDefined()
    expect(status?.health).toBeDefined()
    expect(status?.health?.status).toBe('degraded')
    expect(status?.health?.detail).toContain('optionalSlot slot(s) inactive')

    const rootName = 'system/mock-health-degraded'
    const spy = system.spawn('test-spy', {
      initialState: null,
      handler: onMessage<any, null>({
        getSnapshots: (state, { replyTo }, ctx) => {
          replyTo.send(ctx.actorSnapshots())
          return { state }
        },
      }),
    })

    const snapshots = await ask<any, any>(spy, (replyTo) => ({ type: 'getSnapshots', replyTo }))
    const snapshotObj = snapshots.find((s: any) => s.name === rootName)
    expect(snapshotObj).toBeDefined()
    expect(snapshotObj?.health).toBeDefined()
    expect(snapshotObj?.health.status).toBe('degraded')
    expect(snapshotObj?.health.detail).toContain('optionalSlot slot(s) inactive')
    // Health is on snapshot, not factory state
    expect((snapshotObj?.state as any)?.health).toBeUndefined()

    await system.shutdown()
  })

  test('slot child reportStatus worsens plugin health and fires admin frame', async () => {
    type ChildMsg = { type: 'go' }
    let childRef: { send: (m: ChildMsg) => void } | null = null

    const mockPlugin = createPluginFactory({
      id: 'mock-health-dynamic',
      version: '1.0.0',
      description: 'health dynamic',
      configDescriptor: { key: 'mock-health-dynamic', defaults: {} } as any,
      slots: {
        db: {
          factory: () => ({
            initialState: null,
            lifecycle: onLifecycle({
              start(state, ctx) {
                childRef = ctx.self as any
                return { state }
              },
            }),
            handler: (state: null, msg: ChildMsg, ctx) => {
              if (msg.type === 'go') {
                ctx.reportStatus({ status: 'unavailable', detail: 'Database connection failed' })
              }
              return { state }
            },
          } as ActorDef<ChildMsg, null>),
        },
      },
    })

    const system = await AgentSystem({ source: staticSource({ plugins: [mockPlugin], config: {} }) })

    const healthEvents: any[] = []
    system.subscribe(OutboundAdminBroadcastTopic, (event) => {
      if (event.type === 'plugin.health.changed') {
        healthEvents.push(event)
      }
    })

    await tick(50)
    expect(childRef).not.toBeNull()
    childRef!.send({ type: 'go' })
    await tick(100)

    const updatedStatus = statusOf(system, 'mock-health-dynamic')
    expect(updatedStatus?.health?.status).toBe('unavailable')
    expect(updatedStatus?.health?.detail).toContain('Database connection failed')

    const rootName = 'system/mock-health-dynamic'
    const spy = system.spawn('test-spy-2', {
      initialState: null,
      handler: onMessage<any, null>({
        getSnapshots: (state, { replyTo }, ctx) => {
          replyTo.send(ctx.actorSnapshots())
          return { state }
        },
      }),
    })

    const snapshots = await ask<any, any>(spy, (replyTo) => ({ type: 'getSnapshots', replyTo }))
    const snapObj = snapshots.find((s: any) => s.name === rootName)
    expect(snapObj?.health?.status).toBe('unavailable')
    expect(snapObj?.health?.detail).toContain('Database connection failed')

    const unavailable = healthEvents.filter((e) => e.payload?.health?.status === 'unavailable')
    expect(unavailable.length).toBeGreaterThanOrEqual(1)
    expect(unavailable[0].key).toBe('mock-health-dynamic')
    expect(unavailable[0].payload.health.detail).toContain('Database connection failed')
    expect(unavailable[0].payload.health.updatedAt).toBeUndefined()

    await system.shutdown()
  })

  test('child ok does not clear missing-slot degraded baseline', async () => {
    const mockPlugin = createPluginFactory({
      id: 'mock-health-worsen',
      version: '1.0.0',
      description: 'children only worsen',
      configDescriptor: { key: 'mock-health-worsen', defaults: {} } as any,
      slots: {
        present: {
          factory: () => ({
            initialState: null,
            handler: (s) => ({ state: s }),
          }),
        },
        missing: {
          factory: () => null,
        },
      },
    })

    const system = await AgentSystem({ source: staticSource({ plugins: [mockPlugin], config: {} }) })
    await tick(50)

    const status = statusOf(system, 'mock-health-worsen')
    expect(status?.health?.status).toBe('degraded')
    expect(status?.health?.detail).toContain('missing slot(s) inactive')

    await system.shutdown()
  })
})
