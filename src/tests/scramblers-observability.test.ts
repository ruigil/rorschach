import { describe, test, expect } from 'bun:test'
import {
  AgentSystem,
  staticSource,
} from '../system/index.ts'
import {
  HttpWsFrameTopic,
  OutboundAdminBroadcastTopic,
  OutboundUserMessageTopic,
} from '../types/events.ts'
import { SCRRegistrationTopic } from '../types/scr.ts'
import observabilityPlugin from '../plugins/observability/observability.plugin.ts'
import { MockPersistenceActor } from './mock-persistence.ts'

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

describe('Scramblers Observability Actor', () => {
  test('tracks registration and deregistration events and broadcasts them', async () => {
    const adminEvents: any[] = []
    const userEvents: any[] = []

    const system = await AgentSystem({
      source: staticSource({
        plugins: [MockPersistenceActor(), observabilityPlugin],
        config: { observability: {} },
      }),
    })

    system.subscribe(OutboundAdminBroadcastTopic, (e) => {
      adminEvents.push(e)
    })

    system.subscribe(OutboundUserMessageTopic, (e) => {
      userEvents.push(e)
    })

    await tick()

    // 1. Publish a registration event
    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor: {
        urn: 'scr:leaf:test.summarizer',
        kind: 'leaf',
        description: 'Summarizer descriptor',
        schema: { inputSchema: { type: 'string' } },
        target: {} as any, // Mock ref
      },
    })
    await tick()

    // Assert that OutboundAdminBroadcastTopic received a 'scramblers.registered' event
    const regEvent = adminEvents.find((e) => e.type === 'scramblers.registered')
    expect(regEvent).toBeDefined()
    expect(regEvent.key).toBe('scr:leaf:test.summarizer')
    const payload = JSON.parse(regEvent.payload)
    expect(payload.type).toBe('scramblers.registered')
    expect(payload.descriptor.urn).toBe('scr:leaf:test.summarizer')
    expect(payload.descriptor.kind).toBe('leaf')
    expect(payload.descriptor.target).toBeUndefined() // target must be omitted

    // 2. Request scramblers list via HttpWsFrameTopic
    system.publish(HttpWsFrameTopic, {
      clientId: 'client-1',
      userId: 'user-1',
      roles: ['admin'],
      frame: { type: 'scramblers.list.request' },
    })
    await tick()

    // Assert that OutboundUserMessageTopic received the list item
    const userMsg = userEvents.find((e) => e.userId === 'user-1')
    expect(userMsg).toBeDefined()
    const userPayload = JSON.parse(userMsg.text)
    expect(userPayload.type).toBe('scramblers.registered')
    expect(userPayload.descriptor.urn).toBe('scr:leaf:test.summarizer')

    // 3. Publish deregistration
    system.publish(SCRRegistrationTopic, {
      type: 'deregister',
      urn: 'scr:leaf:test.summarizer',
    })
    await tick()

    const deregEvent = adminEvents.find((e) => e.type === 'scramblers.unregistered')
    expect(deregEvent).toBeDefined()
    expect(deregEvent.key).toBe('scr:leaf:test.summarizer')
    const deregPayload = JSON.parse(deregEvent.payload)
    expect(deregPayload.type).toBe('scramblers.unregistered')
    expect(deregPayload.urn).toBe('scr:leaf:test.summarizer')

    await system.shutdown()
  })
})
