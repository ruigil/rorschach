import { describe, expect, test } from 'bun:test'
import { AgentSystem, staticSource } from '../system/index.ts'
import workflowsPlugin from '../plugins/workflows/workflows.plugin.ts'
import { AgentRegistrationTopic, type AgentDescriptor } from '../types/agents.ts'
import type { WorkflowsConfig } from '../plugins/workflows/types.ts'
import { MockPersistenceActor } from './mock-persistence.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const loadWorkflows = async (workflows: WorkflowsConfig): Promise<AgentDescriptor[]> => {
  const registrations: AgentDescriptor[] = []
  const system = await AgentSystem({
    source: staticSource({
      plugins: [MockPersistenceActor(), workflowsPlugin],
      config: { workflows },
    }),
  })
  system.subscribe(AgentRegistrationTopic, (event) => {
    if (event.type === 'register') registrations.push(event.descriptor)
  })
  await tick()
  await system.shutdown()
  return registrations
}

describe('workflows config', () => {
  test('uses default workflow config when agent is configured', async () => {
    const registrations: AgentDescriptor[] = []
    const system = await AgentSystem({
      source: staticSource({
        plugins: [MockPersistenceActor(), workflowsPlugin],
        config: {
          workflows: { agent: { model: 'z-ai/glm-5.1', maxToolLoops: 10 } },
        },
      }),
    })

    system.subscribe(AgentRegistrationTopic, (event) => {
      if (event.type === 'register') registrations.push(event.descriptor)
    })
    await tick()

    expect(registrations.map((d) => d.mode)).toEqual(['workflows'])

    const desc = registrations.find((d) => d.mode === 'workflows')
    expect(desc).toBeDefined()
    expect(desc?.model).toBe('z-ai/glm-5.1')
    expect(desc?.maxToolLoops).toBe(10)

    await system.shutdown()
  })

  test('registers workflows agent with configured model', async () => {
    const registrations = await loadWorkflows({
      agent: {
        model: 'test-workflow-model',
        maxToolLoops: 3,
      },
    })

    expect(registrations.map((d) => d.mode)).toEqual(['workflows'])
  })
})
