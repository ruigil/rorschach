import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentSystem, ask, defineTool, type ActorDef } from '../system/index.ts'
import { WorkflowRunner } from '../plugins/workflows/workflow-runner.ts'
import { WorkflowStore } from '../plugins/workflows/workflow-store.ts'
import { startWorkflowRunTool } from '../plugins/workflows/tools.ts'
import type { Workflow, WorkflowRunnerMsg, WorkflowRunnerReply } from '../plugins/workflows/types.ts'
import { ToolRegistrationTopic, type ToolMsg, type ToolReply } from '../types/tools.ts'

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
  const store = system.spawn('workflow-store', WorkflowStore(workflowsDir))
  const runner = system.spawn('workflow-runner', WorkflowRunner(store, runsDir, null, 'test-model', 1))
  return { system, runner }
}

describe('workflow runner', () => {
  test('hydrates retained execution tools and starts a valid run', async () => {
    const system = await AgentSystem()
    const toolRef = system.spawn('fake-read-tool', FakeTool())
    system.publishRetained(ToolRegistrationTopic, readTool.name, { ...readTool, ref: toolRef })

    const workflowsDir = await makeDir('rorschach-workflows')
    const runsDir = await makeDir('rorschach-workflow-runs')
    await writeFile(join(workflowsDir, 'workflow.json'), JSON.stringify(workflow(['read'])))
    const store = system.spawn('workflow-store', WorkflowStore(workflowsDir))
    const runner = system.spawn('workflow-runner', WorkflowRunner(store, runsDir, null, 'test-model', 1))

    const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(
      runner,
      replyTo => ({ type: 'start', userId: 'u1', workflowId: 'workflow-1', replyTo }),
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
    const { system, runner } = await spawnRunner(workflow(['missing_tool']))

    const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(
      runner,
      replyTo => ({ type: 'start', userId: 'u1', workflowId: 'workflow-1', replyTo }),
      { timeoutMs: 1_000 },
    )

    expect(reply.ok).toBe(true)
    if (reply.ok && 'run' in reply) {
      expect(reply.run.status).toBe('blocked')
      expect(reply.run.taskStates['task-1']?.status).toBe('blocked')
      expect(reply.run.taskStates['task-1']?.error).toBe('Required execution tool is unavailable: missing_tool')
    }

    await system.shutdown()
  })

  test('does not treat workflow control tools as execution tools', async () => {
    const system = await AgentSystem()
    const toolRef = system.spawn('fake-control-tool', FakeTool())
    system.publishRetained(ToolRegistrationTopic, startWorkflowRunTool.name, { ...startWorkflowRunTool, ref: toolRef })

    const workflowsDir = await makeDir('rorschach-workflows')
    const runsDir = await makeDir('rorschach-workflow-runs')
    await writeFile(join(workflowsDir, 'workflow.json'), JSON.stringify(workflow([startWorkflowRunTool.name])))
    const store = system.spawn('workflow-store', WorkflowStore(workflowsDir))
    const runner = system.spawn('workflow-runner-control', WorkflowRunner(store, runsDir, null, 'test-model', 1))

    const reply = await ask<WorkflowRunnerMsg, WorkflowRunnerReply>(
      runner,
      replyTo => ({ type: 'start', userId: 'u1', workflowId: 'workflow-1', replyTo }),
      { timeoutMs: 1_000 },
    )

    expect(reply.ok).toBe(true)
    if (reply.ok && 'run' in reply) {
      expect(reply.run.status).toBe('blocked')
      expect(reply.run.taskStates['task-1']?.error).toBe('Required execution tool is unavailable: start_workflow_run')
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
