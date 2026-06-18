import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentSystem, ask, type ActorDef } from '../system/index.ts'
import { listWorkflows, getWorkflow, getWorkflowGraph, saveWorkflow } from '../plugins/workflows/workflow-store.ts'
import { buildWorkflowsRoutes } from '../plugins/workflows/routes.ts'
import { handleWorkflowTool, listExecutionToolsTool, listWorkflowsTool, saveWorkflowTool, showWorkflowGraphTool, startWorkflowRunTool } from '../plugins/workflows/workflow-tools.ts'
import type { Workflow, WorkflowRunnerMsg, WorkflowRunnerReply, WorkflowRunState } from '../plugins/workflows/types.ts'
import type { ActorRef } from '../system/index.ts'
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
  inputs: {
    topic: { type: 'string', required: true, description: 'Workflow topic' },
  },
  outputs: {
    summary: { type: 'string', required: true, description: 'Final summary' },
  },
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

const sampleRun = (): WorkflowRunState => ({
  schemaVersion: 1,
  runId: 'run-1',
  workflowId: 'workflow-1',
  userId: 'u1',
  status: 'running',
  inputs: { topic: 'workspace' },
  outputs: {},
  activeTaskIds: ['build'],
  activeTasks: {
    build: { actorName: 'workflow-task-run-1-build-1', startedAt: '2026-05-16T10:01:00.000Z' },
  },
  pendingJobs: {
    'job-1': { taskId: 'build', toolName: 'read', startedAt: '2026-05-16T10:01:05.000Z' },
  },
  taskStates: {
    design: {
      status: 'completed',
      attempts: 1,
      startedAt: '2026-05-16T10:00:00.000Z',
      completedAt: '2026-05-16T10:00:30.000Z',
      summary: 'Designed the UI.',
      outputs: { summary: 'Design done.' },
    },
    build: {
      status: 'running',
      attempts: 1,
      startedAt: '2026-05-16T10:01:00.000Z',
    },
  },
  events: [
    { timestamp: '2026-05-16T10:00:00.000Z', type: 'runStarted', message: 'Run started.' },
    { timestamp: '2026-05-16T10:01:00.000Z', type: 'taskStarted', taskId: 'build', message: 'Task build started.' },
  ],
  workflow: sampleWorkflow('u1'),
})

const FakeRunner = (): ActorDef<WorkflowRunnerMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if ('replyTo' in msg) {
      const reply: WorkflowRunnerReply = msg.type === 'listExecutionTools'
        ? { ok: true, executionTools: [{ name: 'read', description: 'Read a file.' }] }
        : { ok: false, error: 'not implemented' }
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

    const workflows = await listWorkflows(dir, 'u1')
    expect(workflows).toHaveLength(1)
    expect(workflows[0]).toMatchObject({ id: 'workflow-1', taskCount: 2, userId: 'u1' })
  })

  test('returns graph edges from prerequisite to dependent task', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'workflow.json'), JSON.stringify(sampleWorkflow()))

    const result = await getWorkflowGraph(dir, 'u1', 'workflow-1', sampleRun())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.graph.nodes.map((node) => node.id)).toEqual(['design', 'build'])
      expect(result.data.graph.edges).toEqual([{ source: 'design', target: 'build', type: 'depends_on' }])
      expect(result.data.graph.workflow).toMatchObject({
        context: 'User accepted a workflow for execution UI.',
        executionTools: ['read'],
        inputs: { topic: { type: 'string', required: true, description: 'Workflow topic' } },
        outputs: { summary: { type: 'string', required: true, description: 'Final summary' } },
      })
      expect(result.data.graph.run?.runId).toBe('run-1')
      expect(result.data.graph.run?.status).toBe('running')
      expect(result.data.graph.run?.inputs).toEqual({ topic: 'workspace' })
      expect(result.data.graph.run?.activeTaskIds).toEqual(['build'])
      expect(result.data.graph.run?.pendingJobs['job-1']).toMatchObject({ taskId: 'build', toolName: 'read' })
      expect(result.data.graph.run?.events[0]).toEqual({ timestamp: '2026-05-16T10:00:00.000Z', type: 'runStarted', message: 'Run started.' })
      expect(result.data.graph.nodes[0]).toMatchObject({
        status: 'completed',
        startedAt: '2026-05-16T10:00:00.000Z',
        completedAt: '2026-05-16T10:00:30.000Z',
        outputs: { summary: 'Design done.' },
      })
    }
  })

  test('routes return summaries and graph JSON', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'workflow.json'), JSON.stringify(sampleWorkflow('anonymous')))

    const system = await AgentSystem()
    const runner = system.spawn('workflow-runner', FakeRunner())
    const routes = buildWorkflowsRoutes(dir, runner)

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

  test('control tools list workflows and publish workflow graph UI events', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'workflow.json'), JSON.stringify(sampleWorkflow()))

    const system = await AgentSystem()
    const events: Array<{ clientId: string; text: string }> = []
    system.subscribe(OutboundMessageTopic, event => events.push(event))

    const runner = system.spawn('workflow-runner', FakeRunner())
    const publishGraph = (clientId: string | undefined, workflowId: string, runId?: string) => {
      if (clientId) events.push({ clientId, text: JSON.stringify({ type: 'workflowGraph', workflowId, ...(runId ? { runId } : {}) }) })
    }

    const listReply = await handleWorkflowTool(
      { type: 'invoke', toolName: listWorkflowsTool.name, arguments: '{}', replyTo: null as unknown as ActorRef<ToolReply>, userId: 'u1', clientId: 'c1' },
      { workflowsDir: dir, workflowRunnerRef: runner, publishGraph },
    )
    expect(listReply.type).toBe('toolResult')
    if (listReply.type === 'toolResult') expect(listReply.result.text).toContain('Ship workflow workspace')

    const graphReply = await handleWorkflowTool(
      { type: 'invoke', toolName: showWorkflowGraphTool.name, arguments: JSON.stringify({ workflowId: 'workflow-1' }), replyTo: null as unknown as ActorRef<ToolReply>, userId: 'u1', clientId: 'c1' },
      { workflowsDir: dir, workflowRunnerRef: runner, publishGraph },
    )
    expect(graphReply.type).toBe('toolResult')
    expect(events.map(event => JSON.parse(event.text))).toContainEqual({ type: 'workflowGraph', workflowId: 'workflow-1' })

    await system.shutdown()
  })

  test('control tools can save workflow with executionTools', async () => {
    const dir = await makeDir()
    const system = await AgentSystem()
    const runner = system.spawn('workflow-runner', FakeRunner())

    const reply = await handleWorkflowTool(
      { type: 'invoke', toolName: saveWorkflowTool.name, arguments: JSON.stringify({
        goal: 'Learn antigravity',
        summary: 'Decided to use Gemini 3.5.',
        executionTools: ['read', startWorkflowRunTool.name],
        tasks: [{
          id: 'research',
          name: 'Research',
          description: 'Read the source material.',
          validationCriteria: 'A summary exists.',
          dependencies: [],
        }],
      }), replyTo: null as unknown as ActorRef<ToolReply>, userId: 'u1', clientId: 'c1' },
      { workflowsDir: dir, workflowRunnerRef: runner, publishGraph: () => {} },
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result.text).toContain('Workflow saved')
      expect(reply.result.text).toContain('1 tasks')
    }

    await system.shutdown()
  })

  test('list_execution_tools reads execution tools from workflow runner', async () => {
    const dir = await makeDir()
    const system = await AgentSystem()
    const runner = system.spawn('workflow-runner', FakeRunner())

    const reply = await handleWorkflowTool(
      { type: 'invoke', toolName: listExecutionToolsTool.name, arguments: '{}', replyTo: null as unknown as ActorRef<ToolReply>, userId: 'u1', clientId: 'c1' },
      { workflowsDir: dir, workflowRunnerRef: runner, publishGraph: () => {} },
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      const listed = JSON.parse(reply.result.text) as Array<{ name: string; description: string }>
      expect(listed).toEqual([{ name: 'read', description: 'Read a file.' }])
    }

    await system.shutdown()
  })
})