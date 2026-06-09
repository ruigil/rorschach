import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentSystem, ask } from '../system/index.ts'
import { WorkflowStore } from '../plugins/workflows/workflow-store.ts'
import { buildWorkflowsRoutes } from '../plugins/workflows/routes.ts'
import { WorkflowTools, listWorkflowsTool, saveWorkflowTool, showWorkflowGraphTool } from '../plugins/workflows/tools.ts'
import type { Workflow, WorkflowRunnerMsg, WorkflowRunnerReply, WorkflowStoreMsg, WorkflowStoreReply } from '../plugins/workflows/types.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import type { ToolInvokeMsg, ToolReply } from '../types/tools.ts'
import { OutboundMessageTopic } from '../types/events.ts'
import { ANONYMOUS_IDENTITY } from '../plugins/interfaces/types.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const makeDir = async (): Promise<string> => {
  const dir = join(tmpdir(), `rorschach-workflows-${crypto.randomUUID()}`)
  tempDirs.push(dir)
  await mkdir(dir, { recursive: true })
  return dir
}

const sampleWorkflow = (userId = 'u1'): Workflow => ({
  id: 'workflow-1',
  userId,
  goal: 'Ship workflow workspace',
  context: 'User accepted a workflow for execution UI.',
  createdAt: '2026-05-16T10:00:00.000Z',
  executionTools: ['read'],
  tasks: [
    {
      id: 'design',
      name: 'Design UI',
      description: 'Define the split chat workspace.',
      validationCriteria: 'Workflow describes chat and graph together.',
      dependencies: [],
    },
    {
      id: 'build',
      name: 'Build UI',
      description: 'Implement the workspace rail.',
      validationCriteria: 'The graph opens beside chat.',
      dependencies: ['design'],
    },
  ],
})

const FakeRunner = (): ActorDef<WorkflowRunnerMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if ('replyTo' in msg) {
      const reply: WorkflowRunnerReply = { ok: false, error: 'not implemented' }
      msg.replyTo.send(reply)
    }
    return { state }
  },
})

describe('workflow store', () => {
  test('lists valid workflows for the user and ignores malformed or other-user files', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'workflow.json'), JSON.stringify(sampleWorkflow('u1')))
    await writeFile(join(dir, 'other.json'), JSON.stringify(sampleWorkflow('u2')))
    await writeFile(join(dir, 'bad.json'), '{nope')

    const system = await AgentSystem()
    const store = system.spawn('workflow-store', WorkflowStore(dir))

    const reply = await ask<WorkflowStoreMsg, WorkflowStoreReply>(store, replyTo => ({ type: 'list', userId: 'u1', replyTo }))
    expect(reply.ok).toBe(true)
    if (reply.ok && 'workflows' in reply) {
      expect(reply.workflows).toHaveLength(1)
      expect(reply.workflows[0]).toMatchObject({ id: 'workflow-1', taskCount: 2, userId: 'u1' })
    }

    await system.shutdown()
  })

  test('returns graph edges from prerequisite to dependent task', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'workflow.json'), JSON.stringify(sampleWorkflow()))

    const system = await AgentSystem()
    const store = system.spawn('workflow-store', WorkflowStore(dir))

    const reply = await ask<WorkflowStoreMsg, WorkflowStoreReply>(store, replyTo => ({ type: 'graph', userId: 'u1', workflowId: 'workflow-1', replyTo }))
    expect(reply.ok).toBe(true)
    if (reply.ok && 'graph' in reply) {
      expect(reply.graph.nodes.map((node) => node.id)).toEqual(['design', 'build'])
      expect(reply.graph.edges).toEqual([{ source: 'design', target: 'build', type: 'depends_on' }])
    }

    await system.shutdown()
  })

  test('routes return summaries and graph JSON', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'workflow.json'), JSON.stringify(sampleWorkflow('anonymous')))

    const system = await AgentSystem()
    const store = system.spawn('workflow-store', WorkflowStore(dir))
    const runner = system.spawn('workflow-runner', FakeRunner())
    const routes = buildWorkflowsRoutes(store, runner)

    const listRoute = routes.find(route => route.id === 'workflows.list')
    expect(listRoute?.handler).not.toBeNull()
    if (!listRoute || listRoute.handler === null) throw new Error('missing list route')
    const listRes = await listRoute.handler(new Request('http://localhost/workflows'), new URL('http://localhost/workflows'), ANONYMOUS_IDENTITY)
    expect(await listRes.json()).toMatchObject([{ id: 'workflow-1', taskCount: 2 }])

    const itemRoute = routes.find(route => route.id === 'workflows.item')
    expect(itemRoute?.handler).not.toBeNull()
    if (!itemRoute || itemRoute.handler === null) throw new Error('missing item route')
    const graphRes = await itemRoute.handler(new Request('http://localhost/workflows/workflow-1/graph'), new URL('http://localhost/workflows/workflow-1/graph'), ANONYMOUS_IDENTITY)
    const graph = await graphRes.json()
    expect(graph.edges).toEqual([{ source: 'design', target: 'build', type: 'depends_on' }])

    await system.shutdown()
  })

  test('workflow tools list workflows and publish workflow graph UI events', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'workflow.json'), JSON.stringify(sampleWorkflow()))

    const system = await AgentSystem()
    const events: Array<{ clientId: string; text: string }> = []
    system.subscribe(OutboundMessageTopic, event => events.push(event))

    const store = system.spawn('workflow-store', WorkflowStore(dir))
    const runner = system.spawn('workflow-runner', FakeRunner())
    const tools = system.spawn('workflow-tools', WorkflowTools(store, runner as ActorRef<WorkflowRunnerMsg>))

    const listReply = await ask<ToolInvokeMsg, ToolReply>(tools, replyTo => ({
      type: 'invoke',
      toolName: listWorkflowsTool.name,
      arguments: '{}',
      replyTo,
      userId: 'u1',
      clientId: 'c1',
    }))
    expect(listReply.type).toBe('toolResult')
    if (listReply.type === 'toolResult') expect(listReply.result.text).toContain('Ship workflow workspace')

    const graphReply = await ask<ToolInvokeMsg, ToolReply>(tools, replyTo => ({
      type: 'invoke',
      toolName: showWorkflowGraphTool.name,
      arguments: JSON.stringify({ workflowId: 'workflow-1' }),
      replyTo,
      userId: 'u1',
      clientId: 'c1',
    }))
    expect(graphReply.type).toBe('toolResult')
    expect(events.map(event => JSON.parse(event.text))).toContainEqual({ type: 'workflowGraph', workflowId: 'workflow-1' })

    await system.shutdown()
  })

  test('workflow tools can save workflow with executionTools', async () => {
    const dir = await makeDir()
    const system = await AgentSystem()

    const store = system.spawn('workflow-store', WorkflowStore(dir))
    const runner = system.spawn('workflow-runner', FakeRunner())
    const tools = system.spawn('workflow-tools', WorkflowTools(store, runner as ActorRef<WorkflowRunnerMsg>))

    const reply = await ask<ToolInvokeMsg, ToolReply>(tools, replyTo => ({
      type: 'invoke',
      toolName: saveWorkflowTool.name,
      arguments: JSON.stringify({
        goal: 'Learn antigravity',
        summary: 'Decided to use Gemini 3.5.',
        executionTools: ['read'],
        tasks: [],
      }),
      replyTo,
      userId: 'u1',
      clientId: 'c1',
    }))

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result.text).toContain('Workflow saved')
      expect(reply.result.text).toContain('0 tasks')
    }

    await system.shutdown()
  })
})
