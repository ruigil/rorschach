import { describe, expect, test } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import workflowsPlugin  from '../plugins/workflows/workflows.plugin.ts'
import { AgentRegistrationTopic, type AgentDescriptor } from '../types/agents.ts'
import { RouteRegistrationTopic, type RouteRegistration } from '../types/routes.ts'
import type { WorkflowsConfig } from '../plugins/workflows/types.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const loadWorkflows = async (workflows: WorkflowsConfig): Promise<AgentDescriptor[]> => {
  const registrations: AgentDescriptor[] = []
  const system = await AgentSystem({ config: { workflows } })
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
  test('uses default executor and planner config when only plansDir is configured', async () => {
    const registrations: AgentDescriptor[] = []
    const routes: RouteRegistration[] = []
    const system = await AgentSystem({ config: { workflows: { plansDir: 'workspace/custom-plans' } } })
    
    system.subscribe(AgentRegistrationTopic, (event) => {
      if (event.type === 'register') registrations.push(event.descriptor)
    })
    system.subscribe(RouteRegistrationTopic, (event) => {
      if (event.id === 'config.workflows') routes.push(event)
    })

    const result = await system.use(workflowsPlugin)
    expect(result.ok).toBe(true)
    await tick()

    // Assert that both 'executor' and 'planner' agents are registered
    expect(registrations.map(d => d.mode).sort()).toEqual(['executor', 'planner'])

    const route = routes.find(r => r.id === 'config.workflows')
    expect(route?.handler).not.toBeNull()
    if (!route || route.handler === null) throw new Error('expected workflows config route handler')
    
    const response = await route.handler(new Request('http://localhost/config/workflows'), new URL('http://localhost/config/workflows'), null)
    expect(await response.json()).toMatchObject({
      plansDir: 'workspace/custom-plans',
      executor: { model: 'z-ai/glm-5.1', maxToolLoops: 10 },
      planner: { model: 'z-ai/glm-5.1', maxToolLoops: 10 },
    })

    await system.shutdown()
  })

  test('registers both agents with default configurations', async () => {
    const registrations = await loadWorkflows({
      plansDir: 'workspace/plans-test',
      executor: {
        model: 'test-exec-model',
        maxToolLoops: 5,
      },
      planner: {
        model: 'test-plan-model',
        maxToolLoops: 3,
      },
    })

    expect(registrations.map(d => d.mode).sort()).toEqual(['executor', 'planner'])
  })
})
