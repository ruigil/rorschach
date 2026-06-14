import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentSystem, ask, defineTool, type ActorDef } from '../system/index.ts'
import { WorkflowRunExecutor, initialRunState } from '../plugins/workflows/workflow-run-executor.ts'
import type { Workflow, WorkflowRunExecutorMsg, WorkflowRunExecutorReply, WorkflowRunState } from '../plugins/workflows/types.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import { JobRegistryTopic, type ToolCollection, type ToolMsg, type ToolReply } from '../types/tools.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const makeDir = async (): Promise<string> => {
  const dir = join(tmpdir(), `rorschach-workflow-runs-${crypto.randomUUID()}`)
  tempDirs.push(dir)
  await mkdir(dir, { recursive: true })
  return dir
}

const workflow: Workflow = {
  id: 'workflow-1',
  userId: 'u1',
  goal: 'Read a file',
  context: 'Regression test workflow.',
  createdAt: '2026-06-10T10:00:00.000Z',
  executionTools: ['read'],
  tasks: [
    {
      id: 'read-task',
      name: 'Read task',
      description: 'Read a file.',
      validationCriteria: 'A file has been read.',
      dependencies: [],
    },
  ],
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

const CapturingLlm = (streams: Array<Extract<LlmProviderMsg, { type: 'stream' }>>): ActorDef<LlmProviderMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg.type === 'stream') streams.push(msg)
    return { state }
  },
})

describe('workflow run executor', () => {
  test('schedules tasks with constructor-provided execution tools', async () => {
    const dir = await makeDir()
    const system = await AgentSystem()
    const toolRef = system.spawn('fake-read-tool', FakeTool())
    const tools: ToolCollection = { [readTool.name]: { ...readTool, ref: toolRef } }

    const run = initialRunState(workflow, 'run-1')
    const executor = system.spawn(
      'workflow-run-run-1',
      WorkflowRunExecutor(workflow, dir, null, 'test-model', 1, run, tools),
    )

    const reply = await ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
      executor,
      replyTo => ({ type: 'start', replyTo }),
      { timeoutMs: 1_000 },
    )

    expect(reply.ok).toBe(true)
    if (reply.ok) {
      expect(reply.run.status).toBe('running')
      expect(reply.run.taskStates['read-task']?.status).toBe('running')
      expect(reply.run.taskStates['read-task']?.error).toBeUndefined()
    }

    await system.shutdown()
  })

  test('resume abandons persisted pending jobs and retries their tasks', async () => {
    const dir = await makeDir()
    const system = await AgentSystem()
    const toolRef = system.spawn('fake-read-tool-resume', FakeTool())
    const tools: ToolCollection = { [readTool.name]: { ...readTool, ref: toolRef } }
    const run: WorkflowRunState = {
      ...initialRunState(workflow, 'run-2'),
      status: 'running',
      taskStates: {
        'read-task': {
          status: 'running',
          attempts: 1,
          startedAt: '2026-06-10T10:00:00.000Z',
        },
      },
      pendingJobs: {
        'job-1': {
          taskId: 'read-task',
          toolName: 'read',
          toolCallId: 'call-1',
          startedAt: '2026-06-10T10:00:01.000Z',
        },
      },
    }
    const executor = system.spawn(
      'workflow-run-run-2',
      WorkflowRunExecutor(workflow, dir, null, 'test-model', 1, run, tools),
    )

    const reply = await ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
      executor,
      replyTo => ({ type: 'resume', replyTo }),
      { timeoutMs: 1_000 },
    )

    expect(reply.ok).toBe(true)
    if (reply.ok) {
      expect(reply.run.status).toBe('running')
      expect(reply.run.pendingJobs).toEqual({})
      expect(reply.run.taskStates['read-task']?.status).toBe('running')
      expect(reply.run.taskStates['read-task']?.attempts).toBe(2)
    }

    await system.shutdown()
  })

  test('resume retries task-blocked tasks', async () => {
    const dir = await makeDir()
    const system = await AgentSystem()
    const toolRef = system.spawn('fake-read-tool-task-blocked-resume', FakeTool())
    const tools: ToolCollection = { [readTool.name]: { ...readTool, ref: toolRef } }
    const run: WorkflowRunState = {
      ...initialRunState(workflow, 'run-task-blocked'),
      status: 'blocked',
      taskStates: {
        'read-task': {
          status: 'blocked',
          attempts: 1,
          startedAt: '2026-06-10T10:00:00.000Z',
          error: 'External dependency was unavailable.',
          blockedReason: { type: 'task_blocked', message: 'External dependency was unavailable.' },
        },
      },
    }
    const executor = system.spawn(
      'workflow-run-task-blocked',
      WorkflowRunExecutor(workflow, dir, null, 'test-model', 1, run, tools),
    )

    const reply = await ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
      executor,
      replyTo => ({ type: 'resume', replyTo }),
      { timeoutMs: 1_000 },
    )

    expect(reply.ok).toBe(true)
    if (reply.ok) {
      expect(reply.run.status).toBe('running')
      expect(reply.run.taskStates['read-task']?.status).toBe('running')
      expect(reply.run.taskStates['read-task']?.attempts).toBe(2)
      expect(reply.run.taskStates['read-task']?.error).toBeUndefined()
      expect(reply.run.taskStates['read-task']?.blockedReason).toBeUndefined()
    }

    await system.shutdown()
  })

  test('resume retries stale active tasks', async () => {
    const dir = await makeDir()
    const system = await AgentSystem()
    const toolRef = system.spawn('fake-read-tool-stale-active-resume', FakeTool())
    const tools: ToolCollection = { [readTool.name]: { ...readTool, ref: toolRef } }
    const run: WorkflowRunState = {
      ...initialRunState(workflow, 'run-stale-active'),
      status: 'running',
      activeTaskIds: ['read-task'],
      activeTasks: {
        'read-task': {
          actorName: 'workflow-task-run-stale-active-read-task-1',
          startedAt: '2026-06-10T10:00:00.000Z',
        },
      },
      taskStates: {
        'read-task': {
          status: 'running',
          attempts: 1,
          startedAt: '2026-06-10T10:00:00.000Z',
        },
      },
    }
    const executor = system.spawn(
      'workflow-run-stale-active',
      WorkflowRunExecutor(workflow, dir, null, 'test-model', 1, run, tools),
    )

    const reply = await ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
      executor,
      replyTo => ({ type: 'resume', replyTo }),
      { timeoutMs: 1_000 },
    )

    expect(reply.ok).toBe(true)
    if (reply.ok) {
      expect(reply.run.status).toBe('running')
      expect(reply.run.activeTaskIds).toEqual(['read-task'])
      expect(reply.run.taskStates['read-task']?.status).toBe('running')
      expect(reply.run.taskStates['read-task']?.attempts).toBe(2)
      expect(reply.run.events.some(event => event.type === 'runResumed')).toBe(true)
    }

    await system.shutdown()
  })

  test('resume rejects terminal failed runs', async () => {
    const dir = await makeDir()
    const system = await AgentSystem()
    const toolRef = system.spawn('fake-read-tool-failed-resume', FakeTool())
    const tools: ToolCollection = { [readTool.name]: { ...readTool, ref: toolRef } }
    const run: WorkflowRunState = {
      ...initialRunState(workflow, 'run-failed'),
      status: 'failed',
      taskStates: {
        'read-task': {
          status: 'failed',
          attempts: 1,
          startedAt: '2026-06-10T10:00:00.000Z',
          error: 'Tool loop limit reached.',
        },
      },
    }
    const executor = system.spawn(
      'workflow-run-failed',
      WorkflowRunExecutor(workflow, dir, null, 'test-model', 1, run, tools),
    )

    const reply = await ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
      executor,
      replyTo => ({ type: 'resume', replyTo }),
      { timeoutMs: 1_000 },
    )

    expect(reply.ok).toBe(false)
    if (!reply.ok) {
      expect(reply.status).toBe(409)
      expect(reply.error).toBe('Workflow run is not resumable: failed')
    }

    await system.shutdown()
  })

  test('resume rejects runs with no retryable work', async () => {
    const dir = await makeDir()
    const system = await AgentSystem()
    const toolRef = system.spawn('fake-read-tool-noop-resume', FakeTool())
    const tools: ToolCollection = { [readTool.name]: { ...readTool, ref: toolRef } }
    const run: WorkflowRunState = {
      ...initialRunState(workflow, 'run-noop'),
      status: 'running',
      taskStates: {
        'read-task': {
          status: 'completed',
          attempts: 1,
          startedAt: '2026-06-10T10:00:00.000Z',
          completedAt: '2026-06-10T10:00:01.000Z',
          summary: 'Done.',
          outputs: {},
        },
      },
    }
    const executor = system.spawn(
      'workflow-run-noop',
      WorkflowRunExecutor(workflow, dir, null, 'test-model', 1, run, tools),
    )

    const reply = await ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
      executor,
      replyTo => ({ type: 'resume', replyTo }),
      { timeoutMs: 1_000 },
    )

    expect(reply.ok).toBe(false)
    if (!reply.ok) {
      expect(reply.status).toBe(409)
      expect(reply.error).toBe('Workflow run is not resumable: no pending, active, or blocked tasks to retry.')
    }

    await system.shutdown()
  })

  test('completed pending jobs retry the task with resume context instead of parsing tool text as JSON', async () => {
    const dir = await makeDir()
    const system = await AgentSystem()
    const toolRef = system.spawn('fake-read-tool-pending-complete', FakeTool())
    const tools: ToolCollection = { [readTool.name]: { ...readTool, ref: toolRef } }
    const streams: Array<Extract<LlmProviderMsg, { type: 'stream' }>> = []
    const llmRef = system.spawn('capturing-llm-pending-complete', CapturingLlm(streams))
    const run: WorkflowRunState = {
      ...initialRunState(workflow, 'run-3'),
      status: 'running',
      taskStates: {
        'read-task': {
          status: 'running',
          attempts: 1,
          startedAt: '2026-06-10T10:00:00.000Z',
        },
      },
      pendingJobs: {
        'job-1': {
          taskId: 'read-task',
          toolName: 'read',
          toolCallId: 'call-1',
          startedAt: '2026-06-10T10:00:01.000Z',
        },
      },
    }
    const executor = system.spawn(
      'workflow-run-run-3',
      WorkflowRunExecutor(workflow, dir, llmRef, 'test-model', 1, run, tools),
    )
    await Bun.sleep(30)

    system.publish(JobRegistryTopic, {
      jobId: 'job-1',
      status: 'completed',
      result: { text: 'finished work without JSON' },
    })
    await Bun.sleep(80)

    const reply = await ask<WorkflowRunExecutorMsg, WorkflowRunExecutorReply>(
      executor,
      replyTo => ({ type: 'get', replyTo }),
      { timeoutMs: 1_000 },
    )

    expect(reply.ok).toBe(true)
    if (reply.ok) {
      expect(reply.run.status).toBe('running')
      expect(reply.run.pendingJobs).toEqual({})
      expect(reply.run.taskStates['read-task']?.status).toBe('running')
      expect(reply.run.taskStates['read-task']?.attempts).toBe(2)
    }
    expect(JSON.stringify(streams[0]?.messages ?? [])).toContain('finished work without JSON')

    await system.shutdown()
  })
})
