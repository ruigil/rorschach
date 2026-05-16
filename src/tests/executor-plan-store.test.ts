import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentSystem, ask } from '../system/index.ts'
import { PlanStore } from '../plugins/executor/plan-store.ts'
import { buildExecutorRoutes } from '../plugins/executor/routes.ts'
import { ExecutorTools, listPlansTool, showPlanGraphTool } from '../plugins/executor/tools.ts'
import type { Plan } from '../plugins/cognitive/types.ts'
import type { PlanStoreMsg, PlanStoreReply } from '../plugins/executor/types.ts'
import type { ToolInvokeMsg, ToolReply } from '../types/tools.ts'
import { OutboundMessageTopic } from '../types/events.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const makeDir = async (): Promise<string> => {
  const dir = join(tmpdir(), `rorschach-executor-${crypto.randomUUID()}`)
  tempDirs.push(dir)
  await mkdir(dir, { recursive: true })
  return dir
}

const samplePlan = (): Plan => ({
  id:        'plan-1',
  goal:      'Ship executor workspace',
  context:   'User accepted a plan for executor UI.',
  createdAt: '2026-05-16T10:00:00.000Z',
  tasks: [
    {
      id:                 'design',
      name:               'Design UI',
      description:        'Define the split chat workspace.',
      validationCriteria: 'Plan describes chat and graph together.',
      dependencies:       [],
    },
    {
      id:                 'build',
      name:               'Build UI',
      description:        'Implement the workspace rail.',
      validationCriteria: 'The graph opens beside chat.',
      dependencies:       ['design'],
    },
  ],
})

describe('executor plan store', () => {
  test('lists valid plans and ignores malformed files', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'plan.json'), JSON.stringify(samplePlan()))
    await writeFile(join(dir, 'bad.json'), '{nope')

    const system = await AgentSystem()
    const store = system.spawn('plan-store', PlanStore(dir))

    const reply = await ask<PlanStoreMsg, PlanStoreReply>(store, replyTo => ({ type: 'list', replyTo }))
    expect(reply.ok).toBe(true)
    if (reply.ok && 'plans' in reply) {
      expect(reply.plans).toHaveLength(1)
      expect(reply.plans[0]).toMatchObject({ id: 'plan-1', taskCount: 2 })
    }

    await system.shutdown()
  })

  test('returns graph edges from prerequisite to dependent task', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'plan.json'), JSON.stringify(samplePlan()))

    const system = await AgentSystem()
    const store = system.spawn('plan-store', PlanStore(dir))

    const reply = await ask<PlanStoreMsg, PlanStoreReply>(store, replyTo => ({ type: 'graph', planId: 'plan-1', replyTo }))
    expect(reply.ok).toBe(true)
    if (reply.ok && 'graph' in reply) {
      expect(reply.graph.nodes.map(node => node.id)).toEqual(['design', 'build'])
      expect(reply.graph.edges).toEqual([{ source: 'design', target: 'build', type: 'depends_on' }])
    }

    await system.shutdown()
  })

  test('routes return summaries and graph JSON', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'plan.json'), JSON.stringify(samplePlan()))

    const system = await AgentSystem()
    const store = system.spawn('plan-store', PlanStore(dir))
    const routes = buildExecutorRoutes(null, store)

    const listRoute = routes.find(route => route.id === 'executor.plans.list')
    expect(listRoute?.handler).not.toBeNull()
    if (!listRoute || listRoute.handler === null) throw new Error('missing list route')
    const listRes = await listRoute.handler(new Request('http://localhost/plans'), new URL('http://localhost/plans'))
    expect(await listRes.json()).toMatchObject([{ id: 'plan-1', taskCount: 2 }])

    const itemRoute = routes.find(route => route.id === 'executor.plans.item')
    expect(itemRoute?.handler).not.toBeNull()
    if (!itemRoute || itemRoute.handler === null) throw new Error('missing item route')
    const graphRes = await itemRoute.handler(new Request('http://localhost/plans/plan-1/graph'), new URL('http://localhost/plans/plan-1/graph'))
    const graph = await graphRes.json()
    expect(graph.edges).toEqual([{ source: 'design', target: 'build', type: 'depends_on' }])

    await system.shutdown()
  })

  test('executor tools list plans and publish plan graph UI events', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'plan.json'), JSON.stringify(samplePlan()))

    const system = await AgentSystem()
    const events: Array<{ clientId: string; text: string }> = []
    system.subscribe(OutboundMessageTopic, event => events.push(event))

    const store = system.spawn('plan-store', PlanStore(dir))
    const tools = system.spawn('executor-tools', ExecutorTools(store))

    const listReply = await ask<ToolInvokeMsg, ToolReply>(tools, replyTo => ({
      type:      'invoke',
      toolName:  listPlansTool.name,
      arguments: '{}',
      replyTo,
      userId:    'u1',
      clientId:  'c1',
    }))
    expect(listReply.type).toBe('toolResult')
    if (listReply.type === 'toolResult') expect(listReply.result.text).toContain('Ship executor workspace')

    const graphReply = await ask<ToolInvokeMsg, ToolReply>(tools, replyTo => ({
      type:      'invoke',
      toolName:  showPlanGraphTool.name,
      arguments: JSON.stringify({ planId: 'plan-1' }),
      replyTo,
      userId:    'u1',
      clientId:  'c1',
    }))
    expect(graphReply.type).toBe('toolResult')
    expect(events.map(event => JSON.parse(event.text))).toContainEqual({ type: 'planGraph', planId: 'plan-1' })

    await system.shutdown()
  })
})
