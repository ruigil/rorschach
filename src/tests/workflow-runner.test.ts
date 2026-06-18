import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentSystem, ask, defineTool, type ActorDef } from '../system/index.ts'
import { WorkflowRunner } from '../plugins/workflows/workflow-runner.ts'
import { WorkflowRunUpdateTopic, type Workflow, type WorkflowRunnerMsg, type WorkflowRunnerReply, type WorkflowRunState } from '../plugins/workflows/types.ts'
import { startWorkflowRunTool } from '../plugins/workflows/workflow-tools.ts'
import { ToolRegistrationTopic, type ToolMsg, type ToolReply } from '../types/tools.ts'
import { ClientPresenceTopic, OutboundMessageTopic } from '../types/events.ts'
import { initialRunState } from '../plugins/workflows/workflow-store.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const makeDir = async (prefix: string): Promise<string> => {
  const dir = join(tmpdir(), `${prefix}-${crypto.randomUUID()}`)
  tempDirs.push(dir)
  await mkdir(dir, { recursive: true })
  return dir
}

const readTool = defineTool('read', 'Read a file.', {
  type: 'object',
  properties: {
    path: { type: 'string' },
  },
})

const switchModeTool = defineTool('switch_mode', 'Switch to another agent mode.', {
  type: 'object',
  required: ['mode', 'reason'],
  properties: {
    mode: { type: 'string' },
    reason: { type: 'string' },
  },
})

const FakeTool = (): ActorDef<ToolMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    const reply: ToolReply = { type: 'toolResult', result: { text: `called ${msg.toolName}` } }
    msg.replyTo.send(reply)
    return { state }
  },
})

const workflow = (executionTools: string[]): Workflow => ({
  id: 'workflow-1',
  userId: 'u1',
  goal: 'Run one task',
  context: 'Runner execution-tool boundary test.',
  createdAt: '2026-06-10T10:00:00.000Z',
  executionTools,
  tasks: [
    {
      id: 'task-1',
      name: 'Use tool',
      description: 'Use the configured tool.',
      validationCriteria: 'The task starts.',
      dependencies: [],
    },
  ],
})

const spawnRunner = async (runWorkflow: Workflow) => {
  const workflowsDir = await makeDir('rorschach-workflows')
  const runsDir = await makeDir('rorschach-workflow-runs')
  await writeFile(join(workflowsDir, 'workflow.json'), JSON.stringify(runWorkflow))
  const system = await AgentSystem()
  const runner = system.spawn('workflow-runner', WorkflowRunner({ workflowsDir, workflowRunsDir: runsDir, llmRef: null, model: 'test-model', maxToolLoops: 1 }))
  return { system, runner, runsDir, workflowsDir }
}

describe('workflow runner', () => {
  test('hydrates retained execution tools and starts a valid run', async () => {
    const system = await AgentSystem()
    const toolRef = system.spawn('fake-read-tool', FakeTool())
    system.publishRetained(ToolRegistrationTopic, readTool.name, { ...readTool, ref: toolRef })

    const workflowsDir = await makeDir('rorschach-workflows')
    const runsDir = await makeDir('rorschach-workflow-runs')
    const wf = workflow(['read'])
    await writeFile(join(workflowsDir, 'workflow.json'), JSON.stringify(wf))
    const runner = system.spawn('workflow-runner', WorkflowRunner({ workflowsDir, workflowRunsDir: runsDir, llmRef: null, model: 'test-model', maxToolLoops: 1 }))

    const run = initialRunState(wf, 'run-id-1')
    await writeFile(join(runsDir, 'run-id-1.json'), JSON.stringify(run))

    const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(
      runner,
      replyTo => ({ type: 'start', run, workflow: wf, replyTo }),
      { timeoutMs: 1_000 },
    )

    expect(reply.ok).toBe(true)
    if (reply.ok && 'run' in reply) {
      expect(reply.run.status).toBe('running')
      expect(reply.run.taskStates['task-1']?.status).toBe('running')
    }

    await system.shutdown()
  })

  test('blocks before spawning when a required execution tool is missing', async () => {
    const wf = workflow(['missing_tool'])
    const { system, runner, runsDir } = await spawnRunner(wf)
    const updates: Array<{ userId: string; runId: string; runStatus: string }> = []
    system.subscribe(WorkflowRunUpdateTopic, event => updates.push({ userId: event.userId, runId: event.runId, runStatus: event.run.status }))

    const run = initialRunState(wf, 'run-id-2')
    await writeFile(join(runsDir, 'run-id-2.json'), JSON.stringify(run))

    const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(
      runner,
      replyTo => ({ type: 'start', run, workflow: wf, replyTo }),
      { timeoutMs: 1_000 },
    )

    expect(reply.ok).toBe(true)
    if (reply.ok && 'run' in reply) {
      expect(reply.run.status).toBe('blocked')
      expect(reply.run.taskStates['task-1']?.status).toBe('blocked')
      expect(reply.run.taskStates['task-1']?.error).toBe('Required execution tool is unavailable: missing_tool')
    }
    expect(updates.at(-1)?.userId).toBe('u1')
    expect(updates.at(-1)?.runStatus).toBe('blocked')

    await system.shutdown()
  })

  test('bridges workflow run updates to all connected clients for the same user', async () => {
    const { system } = await spawnRunner(workflow(['read']))
    const outbound: Array<{ clientId: string; frame: any }> = []
    system.subscribe(OutboundMessageTopic, event => outbound.push({ clientId: event.clientId, frame: JSON.parse(event.text) }))

    system.publishRetained(ClientPresenceTopic, 'c1', { status: 'connected', clientId: 'c1', userId: 'u1', roles: [] })
    system.publishRetained(ClientPresenceTopic, 'c2', { status: 'connected', clientId: 'c2', userId: 'u1', roles: [] })
    system.publishRetained(ClientPresenceTopic, 'c3', { status: 'connected', clientId: 'c3', userId: 'u2', roles: [] })
    await Bun.sleep(30)

    system.publish(WorkflowRunUpdateTopic, {
      userId: 'u1',
      workflowId: 'workflow-1',
      runId: 'run-bridge',
      run: {
        schemaVersion: 1,
        runId: 'run-bridge',
        workflowId: 'workflow-1',
        userId: 'u1',
        status: 'running',
        inputs: {},
        outputs: {},
        activeTaskIds: [],
        activeTasks: {},
        pendingJobs: {},
        taskStates: {},
        events: [],
        workflow: workflow(['read']),
      },
    })
    await Bun.sleep(30)

    expect(outbound.map(event => event.clientId).sort()).toEqual(['c1', 'c2'])
    expect(outbound[0]?.frame).toMatchObject({ type: 'workflowRunUpdated', workflowId: 'workflow-1', runId: 'run-bridge' })

    outbound.length = 0
    system.publishRetained(ClientPresenceTopic, 'c2', { status: 'disconnected', clientId: 'c2' })
    await Bun.sleep(30)
    system.publish(WorkflowRunUpdateTopic, {
      userId: 'u1',
      workflowId: 'workflow-1',
      runId: 'run-bridge-2',
      run: {
        schemaVersion: 1,
        runId: 'run-bridge-2',
        workflowId: 'workflow-1',
        userId: 'u1',
        status: 'running',
        inputs: {},
        outputs: {},
        activeTaskIds: [],
        activeTasks: {},
        pendingJobs: {},
        taskStates: {},
        events: [],
        workflow: workflow(['read']),
      },
    })
    await Bun.sleep(30)

    expect(outbound.map(event => event.clientId)).toEqual(['c1'])

    await system.shutdown()
  })

  test('allows workflow control tools and switch_mode as execution tools', async () => {
    const system = await AgentSystem()
    const toolRef = system.spawn('fake-control-tool', FakeTool())
    system.publishRetained(ToolRegistrationTopic, startWorkflowRunTool.name, { ...startWorkflowRunTool, ref: toolRef })
    system.publishRetained(ToolRegistrationTopic, switchModeTool.name, { ...switchModeTool, ref: toolRef })

    const workflowsDir = await makeDir('rorschach-workflows')
    const runsDir = await makeDir('rorschach-workflow-runs')
    const wf = workflow([startWorkflowRunTool.name, switchModeTool.name])
    await writeFile(join(workflowsDir, 'workflow.json'), JSON.stringify(wf))
    const runner = system.spawn('workflow-runner-control', WorkflowRunner({ workflowsDir, workflowRunsDir: runsDir, llmRef: null, model: 'test-model', maxToolLoops: 1 }))

    const listed = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(
      runner,
      replyTo => ({ type: 'listExecutionTools', replyTo }),
      { timeoutMs: 1_000 },
    )
    expect(listed.ok).toBe(true)
    if (listed.ok && 'executionTools' in listed) {
      expect(listed.executionTools.map(tool => tool.name).sort()).toEqual([startWorkflowRunTool.name, switchModeTool.name].sort())
    }

    const run = initialRunState(wf, 'run-id-3')
    await writeFile(join(runsDir, 'run-id-3.json'), JSON.stringify(run))

    const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(
      runner,
      replyTo => ({ type: 'start', run, workflow: wf, replyTo }),
      { timeoutMs: 1_000 },
    )

    expect(reply.ok).toBe(true)
    if (reply.ok && 'run' in reply) {
      expect(reply.run.status).toBe('running')
      expect(reply.run.taskStates['task-1']?.status).toBe('running')
    }

    await system.shutdown()
  })

  test('resume returns not found for an unknown run id', async () => {
    const { system, runner } = await spawnRunner(workflow(['read']))

    const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(
      runner,
      replyTo => ({ type: 'resume', userId: 'u1', runId: 'missing-run', replyTo }),
      { timeoutMs: 1_000 },
    )

    expect(reply.ok).toBe(false)
    if (!reply.ok) {
      expect(reply.status).toBe(404)
      expect(reply.error).toBe('Workflow run not found: missing-run')
    }

    await system.shutdown()
  })
})
