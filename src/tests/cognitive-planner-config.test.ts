import { describe, expect, test } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import cognitivePlugin, { type CognitiveConfig } from '../plugins/cognitive/cognitive.plugin.ts'
import { AgentRegistrationTopic, type AgentDescriptor } from '../plugins/cognitive/types.ts'
import { RouteRegistrationTopic, type RouteRegistration } from '../types/routes.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const loadCognitive = async (cognitive: CognitiveConfig): Promise<AgentDescriptor[]> => {
  const registrations: AgentDescriptor[] = []
  const system = await AgentSystem({ config: { cognitive } })
  system.subscribe(AgentRegistrationTopic, (event) => {
    if (event.type === 'register') registrations.push(event.descriptor)
  })

  const result = await system.use(cognitivePlugin)
  expect(result.ok).toBe(true)
  await tick()
  await system.shutdown()

  return registrations
}

describe('cognitive planner config', () => {
  test('uses default chatbot and session config when only llmProvider is configured', async () => {
    const registrations: AgentDescriptor[] = []
    const routes: RouteRegistration[] = []
    const system = await AgentSystem({ config: { cognitive: { llmProvider: { apiKey: 'test-key' } } } })
    system.subscribe(AgentRegistrationTopic, (event) => {
      if (event.type === 'register') registrations.push(event.descriptor)
    })
    system.subscribe(RouteRegistrationTopic, (event) => {
      if (event.id === 'config.cognitive') routes.push(event)
    })

    const result = await system.use(cognitivePlugin)
    expect(result.ok).toBe(true)
    await tick()

    expect(registrations.map(d => d.mode)).toEqual(['chatbot'])

    const route = routes.at(-1)
    expect(route?.handler).not.toBeNull()
    if (!route || route.handler === null) throw new Error('expected cognitive config route handler')
    const response = await route.handler(new Request('http://localhost/config/cognitive'), new URL('http://localhost/config/cognitive'))
    expect(await response.json()).toMatchObject({
      chatbot: { model: 'deepseek/deepseek-v4-flash' },
      session: { defaultMode: 'chatbot', historyWindowHours: 4 },
    })

    await system.shutdown()
  })

  test('does not register planner when planner config is absent', async () => {
    const registrations = await loadCognitive({
      llmProvider: { apiKey: 'test-key' },
      chatbot:     { model: 'test-chat-model' },
    })

    expect(registrations.map(d => d.mode)).toEqual(['chatbot'])
  })

  test('registers planner when planner config is present', async () => {
    const registrations = await loadCognitive({
      llmProvider: { apiKey: 'test-key' },
      chatbot:     { model: 'test-chat-model' },
      planner: {
        model:        'test-planner-model',
        plansDir:     'workspace/test-plans',
        maxToolLoops: 3,
      },
    })

    expect(registrations.map(d => d.mode)).toEqual(['chatbot', 'planner'])
  })
})
