import { describe, test, expect } from 'bun:test'
import { AgentSystem, onMessage, ask } from '../system/index.ts'
import { createPluginFactory } from '../system/index.ts'
import { OutboundAdminBroadcastTopic } from '../types/events.ts'

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

    const system = await AgentSystem({ plugins: [mockPlugin], config: {} })

    // Verify baseline health is degraded
    const status = system.getPluginStatus('mock-health-degraded')
    expect(status).toBeDefined()
    // Verify native LoadedPlugin.health is populated directly
    expect(status?.health).toBeDefined()
    expect(status?.health?.status).toBe('degraded')
    expect(status?.health?.detail).toContain('optionalSlot slot(s) inactive')

    // Inspect the root actor's state via a spy actor
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
    const rootState = snapshotObj?.state as any
    expect(rootState?.health).toBeDefined()
    expect(rootState?.health.status).toBe('degraded')
    expect(rootState?.health.detail).toContain('optionalSlot slot(s) inactive')

    await system.shutdown()
  })

  test('handles dynamic health updates and broadcasts', async () => {
    const mockPlugin2 = createPluginFactory({
      id: 'mock-health-dynamic',
      version: '1.0.0',
      description: 'health dynamic',
      configDescriptor: { key: 'mock-health-dynamic', defaults: {} } as any,
      slots: {},
    })

    const system = await AgentSystem({ plugins: [mockPlugin2], config: {} })

    // Listen to OutboundAdminBroadcastTopic for health changes
    const healthEvents: any[] = []
    system.subscribe(OutboundAdminBroadcastTopic, (event) => {
      if (event.type === 'plugin.health.changed') {
        healthEvents.push(event)
      }
    })

    // Send a healthStatus message to the plugin root actor
    const rootActorRef = system.getPluginStatus('mock-health-dynamic')?.ref
    expect(rootActorRef).toBeDefined()

    rootActorRef?.send({
      type: 'healthStatus',
      status: 'unavailable',
      detail: 'Database connection failed',
    })

    // Wait for actor mailbox processing
    await Bun.sleep(50)

    // Verify system.getPluginStatus() natively returns the updated health
    const updatedStatus = system.getPluginStatus('mock-health-dynamic')
    expect(updatedStatus?.health?.status).toBe('unavailable')
    expect(updatedStatus?.health?.detail).toBe('Database connection failed')

    // Verify health report updated via spy actor
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
    const rootState = snapObj?.state as any
    expect(rootState?.health.status).toBe('unavailable')
    expect(rootState?.health.detail).toBe('Database connection failed')

    // Verify event was broadcasted
    expect(healthEvents.length).toBe(1)
    expect(healthEvents[0].key).toBe('mock-health-dynamic')
    expect(healthEvents[0].payload.health.status).toBe('unavailable')
    expect(healthEvents[0].payload.health.detail).toBe('Database connection failed')

    await system.shutdown()
  })
})
