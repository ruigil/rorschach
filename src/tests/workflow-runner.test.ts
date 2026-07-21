import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentSystem, ask, defineTool, type ActorDef, type ActorRef } from '../system/index.ts'
import { WorkflowRunner } from '../plugins/workflows/workflow-runner.ts'
import { WorkflowEventTopic, type Workflow, type WorkflowRunnerMsg, type WorkflowRunnerReply, type WorkflowRunState } from '../plugins/workflows/types.ts'
import { startWorkflowRunTool } from '../plugins/workflows/workflow-tools.ts'
import { ToolRegistrationTopic, type ToolMsg, type ToolReply } from '../types/tools.ts'
import { OutboundUserMessageTopic } from '../types/events.ts'
import { initialRunState, saveWorkflowRun } from '../plugins/workflows/workflow-store.ts'
import { MockPersistenceActor } from './mock-persistence.ts'
import { PersistenceProviderTopic } from '../types/persistence.ts'

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
  title: 'Run one task',
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
  const runsDir = await makeDir('rorschach-workflow-runs')
  const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
  const runner = system.spawn('workflow-runner', WorkflowRunner({ llmRef: null, model: 'test-model', maxToolLoops: 1 }))
  return { system, runner, runsDir }
}

const seedRun = async (system: any, run: any) => {
  let persistenceRef: any = null
  const unsub = system.subscribe(PersistenceProviderTopic, (e: any) => {
    if (e?.ref) {
      persistenceRef = e.ref
    }
  })
  unsub()
  if (!persistenceRef) {
    throw new Error('Persistence provider not ready')
  }
  await saveWorkflowRun(persistenceRef, run)
}

describe('workflow runner', () => {
  test('hydrates retained execution tools and starts a valid run', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const toolRef = system.spawn('fake-read-tool', FakeTool())
    system.publishRetained(ToolRegistrationTopic, readTool.name, { ...readTool, ref: toolRef })

    const runsDir = await makeDir('rorschach-workflow-runs')
    const wf = workflow(['read'])
    const runner = system.spawn('workflow-runner', WorkflowRunner({ llmRef: null, model: 'test-model', maxToolLoops: 1 }))

    const run = initialRunState(wf, 'run-id-1')
    await seedRun(system, run)

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
    const { system, runner } = await spawnRunner(wf)
    const updates: Array<{ userId: string; runId: string; runStatus: string }> = []
    system.subscribe(WorkflowEventTopic, event => updates.push({ userId: event.userId, runId: event.runId!, runStatus: event.run!.status }))

    const run = initialRunState(wf, 'run-id-2')
    await seedRun(system, run)

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

  test('publishes workflow run updates to OutboundUserMessageTopic for the user', async () => {
    const { system } = await spawnRunner(workflow(['read']))
    const outbound: Array<{ userId: string; frame: any }> = []
    system.subscribe(OutboundUserMessageTopic, event => {
      const e = event as { userId: string; text: string }
      outbound.push({ userId: e.userId, frame: JSON.parse(e.text) })
    })

    system.publish(WorkflowEventTopic, {
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

    expect(outbound).toHaveLength(1)
    expect(outbound[0]?.userId).toBe('u1')
    expect(outbound[0]?.frame).toMatchObject({ type: 'workflow.run.updated', workflowId: 'workflow-1', runId: 'run-bridge' })

    await system.shutdown()
  })

  test('allows workflow control tools and switch_mode as execution tools', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const toolRef = system.spawn('fake-control-tool', FakeTool())
    system.publishRetained(ToolRegistrationTopic, startWorkflowRunTool.name, { ...startWorkflowRunTool, ref: toolRef })
    system.publishRetained(ToolRegistrationTopic, switchModeTool.name, { ...switchModeTool, ref: toolRef })

    const runsDir = await makeDir('rorschach-workflow-runs')
    const wf = workflow([startWorkflowRunTool.name, switchModeTool.name])
    const runner = system.spawn('workflow-runner-control', WorkflowRunner({ llmRef: null, model: 'test-model', maxToolLoops: 1 }))

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
    await seedRun(system, run)

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

  test('removes terminated workflow run from runner cache and resolves via disk', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const toolRef = system.spawn('fake-read-tool', FakeTool())
    system.publishRetained(ToolRegistrationTopic, readTool.name, { ...readTool, ref: toolRef })

    const runsDir = await makeDir('rorschach-workflow-runs')
    const wf = workflow(['read'])
    const runner = system.spawn('workflow-runner', WorkflowRunner({ llmRef: null, model: 'test-model', maxToolLoops: 1 }))

    const run = initialRunState(wf, 'run-id-cleanup')
    await seedRun(system, run)

    const startReply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(
      runner,
      replyTo => ({ type: 'start', run, workflow: wf, replyTo }),
      { timeoutMs: 1_000 },
    )
    expect(startReply.ok).toBe(true)

    // Stop the child actor representing the workflow run
    await system.stop({ name: 'system/workflow-runner/workflow-run-run-id-cleanup' })
    await Bun.sleep(100) // allow lifecycle/termination to process

    // Call get: since the actor was terminated, it should have been removed from the runner cache
    // and fetched successfully from the disk (runsDir)
    const getReply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(
      runner,
      replyTo => ({ type: 'get', userId: 'u1', runId: 'run-id-cleanup', replyTo }),
      { timeoutMs: 1_000 },
    )
    expect(getReply.ok).toBe(true)
    if (getReply.ok && 'run' in getReply) {
      expect(getReply.run.runId).toBe('run-id-cleanup')
    }

    await system.shutdown()
  })
})
