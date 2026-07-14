import { describe, test, expect } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import { MockPersistenceActor } from './mock-persistence.ts'
import { CostTopic } from '../types/llm.ts'
import { OutboundAdminBroadcastTopic } from '../types/events.ts'
import observabilityPlugin from '../plugins/observability/observability.plugin.ts'

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

describe('Cost Tracker', () => {
  test('broadcasts cost event as usage frame to admin WS clients', async () => {
    const broadcasts: any[] = []
    const system = await AgentSystem({
      config: {
        observability: {
          costTracker: {
            costsDir: 'workspace/observability/costs',
            flushIntervalMs: 0, // unbuffered
          },
        },
      },
      plugins: [MockPersistenceActor(), observabilityPlugin],
    })

    system.subscribe(OutboundAdminBroadcastTopic, (e) => {
      broadcasts.push(e)
    })

    // Publish a cost event
    const costEvent = {
      timestamp: Date.now(),
      role: 'reasoning',
      model: 'gemini-3.5-flash',
      inputTokens: 100,
      outputTokens: 200,
      cost: 0.0015,
      userId: 'test-user',
    }
    system.publish(CostTopic, costEvent)

    await tick(100)

    // Check that we received the usage frame broadcast
    const usageBroadcast = broadcasts.find((b) => b.type === 'usage')
    expect(usageBroadcast).toBeDefined()
    expect(usageBroadcast.type).toBe('usage')
    expect(usageBroadcast.key).toStartWith('usage-')
    const payload = JSON.parse(usageBroadcast.payload)
    expect(payload).toEqual({
      type: 'usage',
      ...costEvent,
    })

    await system.shutdown()
  })
})
