import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentSystem, type ActorDef, type ActorRef } from '../system/index.ts'
import { listWorkflows, getWorkflow, getWorkflowGraph, saveWorkflow } from '../plugins/workflows/workflow-store.ts'
import { buildWorkflowsRoutes } from '../plugins/workflows/routes.ts'
import { handleWorkflowTool, listExecutionToolsTool, listWorkflowsTool, saveWorkflowTool, showWorkflowGraphTool, startWorkflowRunTool, updateWorkflowTool } from '../plugins/workflows/workflow-tools.ts'
import { WorkflowEventTopic } from '../plugins/workflows/types.ts'
import type { Workflow, WorkflowRunnerMsg, WorkflowRunnerReply, WorkflowRunState } from '../plugins/workflows/types.ts'
import { ANONYMOUS_IDENTITY } from '../plugins/interfaces/types.ts'
import { OutboundUserMessageTopic, HttpWsFrameTopic } from '../types/events.ts'
import { WorkflowRunner } from '../plugins/workflows/workflow-runner.ts'
import type { ToolReply } from '../types/tools.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const makeDir = async (): Promise<string> => {
  const dir = join(tmpdir(), `rorschach-workflows-store-${crypto.randomUUID()}`)
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
  inputs: { topic: { type: 'string', required: true, description: 'Workflow topic' } },
  outputs: { summary: { type: 'string', required: true, description: 'Final summary' } },
  tasks: [
    {
      id: 'design',
      name: 'Design task',
      description: 'Design it.',
      validationCriteria: 'Done.',
      dependencies: [],
    },
    {
      id: 'build',
      name: 'Build task',
      description: 'Build it.',
      validationCriteria: 'Done.',
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
  taskStates: {
    design: { status: 'completed', attempts: 1, startedAt: '2026-05-16T10:00:01.000Z', completedAt: '2026-05-16T10:00:02.000Z', summary: 'Designed.' },
    build: { status: 'running', attempts: 1, startedAt: '2026-05-16T10:00:03.000Z' },
  },
  activeTasks: {},
  pendingJobs: {
    'job-1': { taskId: 'build', toolName: 'read', startedAt: '2026-05-16T10:00:04.000Z' },
  },
  events: [{ timestamp: '2026-05-16T10:00:00.000Z', type: 'runStarted', message: 'Run started.' }],
  workflow: sampleWorkflow(),
})

const FakeRunner = (): ActorDef<WorkflowRunnerMsg, { executionTools: Record<string, any> }> => ({
  initialState: () => ({ executionTools: { read: { name: 'read', schema: { function: { description: 'Read a file.' } } } } }),
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
        attempts: 1,
        startedAt: '2026-05-16T10:00:01.000Z',
        completedAt: '2026-05-16T10:00:02.000Z',
        summary: 'Designed.',
      })
    }
  })

  test('routes return summaries and graph JSON', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'workflow.json'), JSON.stringify(sampleWorkflow('u1')))

    const system = await AgentSystem()
    const events: Array<{ userId: string; text: string }> = []
    system.subscribe(OutboundUserMessageTopic, event => {
      const e = event as { userId: string; text: string }
      events.push(e)
    })

    const runner = system.spawn('workflow-runner', WorkflowRunner({
      workflowsDir: dir,
      workflowRunsDir: join(dir, 'runs'),
      llmRef: null,
      model: 'deepseek/deepseek-v4-flash',
      maxToolLoops: 10,
    }))

    const waitEvents = async (count: number, timeout = 1000) => {
      const start = Date.now()
      while (events.length < count && Date.now() - start < timeout) {
        await new Promise(r => setTimeout(r, 10))
      }
    }

    // 1. Request workflow list
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'u1',
      roles: [],
      frame: { type: 'workflow.list.request' }
    })
    await waitEvents(1)
    expect(events).toHaveLength(1)
    const listRes = JSON.parse(events[0]!.text)
    expect(listRes).toMatchObject({
      type: 'workflowsList',
      workflows: [{ id: 'workflow-1', taskCount: 2 }]
    })

    // 2. Request workflow graph
    events.length = 0 // clear
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'u1',
      roles: [],
      frame: { type: 'workflow.graph.request', workflowId: 'workflow-1' }
    })
    await waitEvents(1)
    expect(events).toHaveLength(1)
    const graphRes = JSON.parse(events[0]!.text)
    expect(graphRes.type).toBe('workflowGraph')
    expect(graphRes.edges).toEqual([{ source: 'design', target: 'build', type: 'depends_on' }])

    await system.shutdown()
  })

  test('control tools list workflows and publish workflow graph UI events', async () => {
    const dir = await makeDir()
    await writeFile(join(dir, 'workflow.json'), JSON.stringify(sampleWorkflow()))

    const system = await AgentSystem()
    const events: Array<{ userId: string; text: string }> = []
    system.subscribe(OutboundUserMessageTopic, event => {
      const e = event as { userId: string; text: string }
      events.push(e)
    })

    const runner = system.spawn('workflow-runner', FakeRunner())
    const ctx = {
      publish: (topic: any, event: any) => {
        if (topic === WorkflowEventTopic) {
          events.push({
            userId: event.userId,
            text: JSON.stringify({ type: 'workflowGraph', workflowId: event.workflowId, ...(event.runId ? { runId: event.runId } : {}) })
          })
        }
      }
    }

    const listReply = await handleWorkflowTool(
      { type: 'invoke', toolName: listWorkflowsTool.name, arguments: '{}', replyTo: null as unknown as ActorRef<ToolReply>, userId: 'u1' },
      { workflowsDir: dir, workflowRunnerRef: runner, ctx },
    )
    expect(listReply.type).toBe('toolResult')
    if (listReply.type === 'toolResult') expect(listReply.result.text).toContain('Ship workflow workspace')

    const graphReply = await handleWorkflowTool(
      { type: 'invoke', toolName: showWorkflowGraphTool.name, arguments: JSON.stringify({ workflowId: 'workflow-1' }), replyTo: null as unknown as ActorRef<ToolReply>, userId: 'u1' },
      { workflowsDir: dir, workflowRunnerRef: runner, ctx },
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
      }), replyTo: null as unknown as ActorRef<ToolReply>, userId: 'u1' },
      { workflowsDir: dir, workflowRunnerRef: runner, ctx: { publish: () => {} } },
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result.text).toContain('Workflow saved')
      expect(reply.result.text).toContain('1 tasks')
    }

    await system.shutdown()
  })

  test('control tools can update workflow and publish workflow event', async () => {
    const dir = await makeDir()
    const system = await AgentSystem()
    const runner = system.spawn('workflow-runner', FakeRunner())
    const events: any[] = []
    const ctx = {
      publish: (topic: any, event: any) => {
        if (topic === WorkflowEventTopic) {
          events.push(event)
        }
      }
    }

    const initialWorkflow = sampleWorkflow('u1')
    initialWorkflow.outputs = {}
    await writeFile(join(dir, 'workflow.json'), JSON.stringify(initialWorkflow))

    const reply = await handleWorkflowTool(
      { type: 'invoke', toolName: updateWorkflowTool.name, arguments: JSON.stringify({
        workflowId: initialWorkflow.id,
        goal: 'Updated Goal',
      }), replyTo: null as unknown as ActorRef<ToolReply>, userId: 'u1' },
      { workflowsDir: dir, workflowRunnerRef: runner, ctx },
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result.text).toContain('updated successfully')
    }
    expect(events).toContainEqual({ userId: 'u1', workflowId: initialWorkflow.id })

    await system.shutdown()
  })

  test('list_execution_tools reads execution tools from workflow runner', async () => {
    const dir = await makeDir()
    const system = await AgentSystem()
    const runner = system.spawn('workflow-runner', FakeRunner())

    const reply = await handleWorkflowTool(
      { type: 'invoke', toolName: listExecutionToolsTool.name, arguments: '{}', replyTo: null as unknown as ActorRef<ToolReply>, userId: 'u1' },
      { workflowsDir: dir, workflowRunnerRef: runner, ctx: { publish: () => {} } },
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      const listed = JSON.parse(reply.result.text) as Array<{ name: string; description: string }>
      expect(listed).toEqual([{ name: 'read', description: 'Read a file.' }])
    }

    await system.shutdown()
  })
})