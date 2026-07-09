import { describe, expect, test } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import workflowsPlugin  from '../plugins/workflows/workflows.plugin.ts'
import { AgentRegistrationTopic, type AgentDescriptor } from '../types/agents.ts'
import { RouteRegistrationTopic, type RouteRegistration } from '../types/routes.ts'
import type { WorkflowsConfig } from '../plugins/workflows/types.ts'
import { MockPersistenceActor } from './mock-persistence.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const loadWorkflows = async (workflows: WorkflowsConfig): Promise<AgentDescriptor[]> => {
  const registrations: AgentDescriptor[] = []
  const system = await AgentSystem({ plugins: [MockPersistenceActor()], config: { workflows } })
  system.subscribe(AgentRegistrationTopic, (event) => {
    if (event.type === 'register') registrations.push(event.descriptor)
  })

  const result = await system.use(workflowsPlugin)
  expect(result.ok).toBe(true)
  await tick()
  await system.shutdown()

  return registrations
}

describe('workflows config', () => {
  test('uses default workflow config when agent is configured', async () => {
    const registrations: AgentDescriptor[] = []
    const routes: RouteRegistration[] = []
    const system = await AgentSystem({ plugins: [MockPersistenceActor()], config: { workflows: { agent: { model: 'z-ai/glm-5.1', maxToolLoops: 10 } } } })
    
    system.subscribe(AgentRegistrationTopic, (event) => {
      if (event.type === 'register') registrations.push(event.descriptor)
    })
    system.subscribe(RouteRegistrationTopic, (event) => {
      if (event.id === 'config.workflows') routes.push(event)
    })

    const result = await system.use(workflowsPlugin)
    expect(result.ok).toBe(true)
    await tick()

    expect(registrations.map(d => d.mode)).toEqual(['workflows'])

    const route = routes.find(r => r.id === 'config.workflows')
    expect(route?.handler).not.toBeNull()
    if (!route || route.handler === null) throw new Error('expected workflows config route handler')
    
    const response = await route.handler(new Request('http://localhost/config/workflows'), new URL('http://localhost/config/workflows'), null)
    expect(await response.json()).toMatchObject({
      agent: { model: 'z-ai/glm-5.1', maxToolLoops: 10 },
    })

    await system.shutdown()
  })

  test('registers workflows agent with configured model', async () => {
    const registrations = await loadWorkflows({
      agent: {
        model: 'test-workflow-model',
        maxToolLoops: 3,
      },
    })

    expect(registrations.map(d => d.mode)).toEqual(['workflows'])
  })
})
