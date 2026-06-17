import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentSystem, ask, type ActorDef } from '../system/index.ts'
import { buildWorkflowsRoutes } from '../plugins/workflows/routes.ts'
import { handleWorkflowTool, startWorkflowRunTool } from '../plugins/workflows/tools.ts'
import { parseTaskCompletionArgs } from '../plugins/workflows/workflow-task-executor.ts'
import { validateInputValues, validateWorkflow } from '../plugins/workflows/validation.ts'
import type {
  Workflow,
  WorkflowRunnerMsg,
  WorkflowRunnerReply,
  WorkflowRunState,
  WorkflowStoreMsg,
  WorkflowStoreReply,
} from '../plugins/workflows/types.ts'
import type { ActorRef } from '../system/index.ts'
import type { ToolReply } from '../types/tools.ts'
import { ANONYMOUS_IDENTITY } from '../plugins/interfaces/types.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const makeDir = async (): Promise<string> => {
  const dir = join(tmpdir(), `rorschach-workflow-io-${crypto.randomUUID()}`)
  tempDirs.push(dir)
  await mkdir(dir, { recursive: true })
  return dir
}

const workflow = (): Workflow => ({
  id: 'workflow-1',
  userId: 'anonymous',
  goal: 'Generate a report',
  context: 'Use structured workflow IO.',
  createdAt: '2026-06-11T10:00:00.000Z',
  executionTools: ['write'],
  inputs: {
    city: { type: 'string' },
  },
  outputs: {
    report: { type: 'artifact' },
  },
  tasks: [{
    id: 'write-report',
    name: 'Write report',
    description: 'Write the report artifact.',
    validationCriteria: 'The report artifact exists.',
    dependencies: [],
    outputs: {
      report: { type: 'artifact' },
    },
  }],
})

const runState = (): WorkflowRunState => ({
  schemaVersion: 1,
  runId: 'run-1',
  workflowId: 'workflow-1',
  userId: 'anonymous',
  status: 'completed',
  inputs: { city: 'Paris' },
  outputs: {
    report: { type: 'artifact', path: 'report.html', mimeType: 'text/html' },
  },
  activeTaskIds: [],
  activeTasks: {},
  pendingJobs: {},
  taskStates: {
    'write-report': {
      status: 'completed',
      attempts: 1,
      summary: 'Wrote the report.',
      outputs: {
        report: { type: 'artifact', path: 'report.html', mimeType: 'text/html' },
      },
    },
  },
  events: [],
})

const runningRunState = (inputs: Record<string, unknown> = {}): WorkflowRunState => ({
  ...runState(),
  status: 'running',
  inputs,
  outputs: {},
  activeTaskIds: ['write-report'],
  taskStates: {
    'write-report': {
      status: 'running',
      attempts: 1,
      startedAt: '2026-06-11T10:00:01.000Z',
    },
  },
})

describe('workflow IO and artifacts', () => {
  test('validates workflow output contracts and input values', () => {
    expect(validateWorkflow(workflow())).toEqual([])
    expect(validateInputValues(workflow().inputs, { city: 'Paris' })).toEqual({ ok: true, values: { city: 'Paris' } })
    expect(validateInputValues(workflow().inputs, {})).toEqual({ ok: false, error: 'missing required workflow input: city' })

    const invalid = workflow()
    invalid.tasks = [
      ...invalid.tasks,
      {
        id: 'duplicate',
        name: 'Duplicate',
        description: 'Duplicate output.',
        validationCriteria: 'No duplicate outputs.',
        dependencies: [],
        outputs: { report: { type: 'artifact' } },
      },
    ]
    expect(validateWorkflow(invalid)).toContain('duplicate task output key: report (write-report, duplicate)')
  })

  test('parses task completion tool arguments and rejects undeclared outputs', () => {
    const task = workflow().tasks[0]
    if (!task) throw new Error('missing sample task')
    const parsed = parseTaskCompletionArgs(task, JSON.stringify({
      summary: 'Wrote the report.',
      outputs: { report: { type: 'artifact', path: 'report.html', mimeType: 'text/html' } },
    }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.outputs.report).toEqual({ type: 'artifact', path: 'report.html', mimeType: 'text/html' })

    expect(parseTaskCompletionArgs(task, JSON.stringify({
      summary: 'Wrote the report.',
      outputs: { report: { type: 'artifact', path: '../report.html' } },
    }))).toEqual({ ok: false, error: 'task write-report.report must be an artifact reference with either a safe relative path or a public URL' })

    const urlParsed = parseTaskCompletionArgs(task, JSON.stringify({
      summary: 'Generated the image.',
      outputs: { report: { type: 'artifact', url: 'generated/image.png', mimeType: 'image/png' } },
    }))
    expect(urlParsed.ok).toBe(true)
    if (urlParsed.ok) expect(urlParsed.outputs.report).toEqual({ type: 'artifact', url: 'generated/image.png', mimeType: 'image/png' })

    expect(parseTaskCompletionArgs(task, JSON.stringify({
      summary: 'Generated the image.',
      outputs: { report: { type: 'artifact', url: 'javascript:alert(1)' } },
    }))).toEqual({ ok: false, error: 'task write-report.report must be an artifact reference with either a safe relative path or a public URL' })

    expect(parseTaskCompletionArgs(task, JSON.stringify({
      summary: 'Generated the image.',
      outputs: { report: { type: 'artifact', url: 'generated/%2e%2e/secret.png' } },
    }))).toEqual({ ok: false, error: 'task write-report.report must be an artifact reference with either a safe relative path or a public URL' })

    expect(parseTaskCompletionArgs(task, JSON.stringify({
      summary: 'Wrote the report.',
      outputs: {
        report: { type: 'artifact', path: 'report.html' },
        extra: true,
      },
    }))).toEqual({ ok: false, error: 'task write-report output is not declared: extra' })
  })

  test('start_workflow_run passes tool-only inputs to the runner', async () => {
    const system = await AgentSystem()
    let capturedInputs: Record<string, unknown> | undefined
    const store = system.spawn('noop-workflow-store', NoopStore())
    const runner = system.spawn('capturing-workflow-runner', CapturingRunner(inputs => { capturedInputs = inputs }))

    const reply = await handleWorkflowTool(
      { type: 'invoke', toolName: startWorkflowRunTool.name, arguments: JSON.stringify({ workflowId: 'workflow-1', inputs: { city: 'Paris' } }), replyTo: null as unknown as ActorRef<ToolReply>, userId: 'anonymous', clientId: 'client-1' },
      { workflowStoreRef: store, workflowRunnerRef: runner, publishGraph: () => {} },
    )

    expect(reply.type).toBe('toolPending')
    expect(capturedInputs).toEqual({ city: 'Paris' })
    await system.shutdown()
  })

  test('start_workflow_run returns immediate run state when start blocks before execution', async () => {
    const system = await AgentSystem()
    const store = system.spawn('noop-workflow-store-blocked', NoopStore())
    const runner = system.spawn('blocked-workflow-runner', StaticStartRunner({
      ...runState(),
      status: 'blocked',
      outputs: {},
      taskStates: {
        'write-report': {
          status: 'blocked',
          attempts: 0,
          error: 'Required execution tool is unavailable: write',
          blockedReason: { type: 'task_blocked', message: 'Required execution tool is unavailable: write' },
        },
      },
    }))

    const reply = await handleWorkflowTool(
      { type: 'invoke', toolName: startWorkflowRunTool.name, arguments: JSON.stringify({ workflowId: 'workflow-1' }), replyTo: null as unknown as ActorRef<ToolReply>, userId: 'anonymous', clientId: 'client-1' },
      { workflowStoreRef: store, workflowRunnerRef: runner, publishGraph: () => {} },
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(JSON.parse(reply.result.text).status).toBe('blocked')
    }
    await system.shutdown()
  })

  test('artifact route serves only referenced completed artifacts', async () => {
    const dir = await makeDir()
    await mkdir(join(dir, 'run-1'), { recursive: true })
    await writeFile(join(dir, 'run-1', 'report.html'), '<h1>Report</h1>')

    const system = await AgentSystem()
    const runner = system.spawn('artifact-runner', StaticRunRunner(runState()))
    const routes = buildWorkflowsRoutes(null, runner as ActorRef<WorkflowRunnerMsg>, dir)
    const route = routes.find(item => item.id === 'workflow-runs.artifact')
    if (!route || route.handler === null) throw new Error('missing artifact route')

    const ok = await route.handler(
      new Request('http://localhost/workflow-runs/run-1/artifact?path=report.html'),
      new URL('http://localhost/workflow-runs/run-1/artifact?path=report.html'),
      ANONYMOUS_IDENTITY,
    )
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('<h1>Report</h1>')

    const missing = await route.handler(
      new Request('http://localhost/workflow-runs/run-1/artifact?path=other.html'),
      new URL('http://localhost/workflow-runs/run-1/artifact?path=other.html'),
      ANONYMOUS_IDENTITY,
    )
    expect(missing.status).toBe(404)

    const urlOnly = await route.handler(
      new Request('http://localhost/workflow-runs/run-url/artifact?path=generated/image.png'),
      new URL('http://localhost/workflow-runs/run-url/artifact?path=generated/image.png'),
      ANONYMOUS_IDENTITY,
    )
    expect(urlOnly.status).toBe(404)
    await system.shutdown()
  })
})

const NoopStore = (): ActorDef<WorkflowStoreMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if ('replyTo' in msg) {
      const reply: WorkflowStoreReply = { ok: false, error: 'not implemented' }
      msg.replyTo.send(reply)
    }
    return { state }
  },
})

const CapturingRunner = (capture: (inputs: Record<string, unknown> | undefined) => void): ActorDef<WorkflowRunnerMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg.type === 'start') {
      capture(msg.inputs)
      const reply: WorkflowRunnerReply = { ok: true, run: runningRunState(msg.inputs ?? {}) }
      msg.replyTo.send(reply)
    } else if ('replyTo' in msg) {
      msg.replyTo.send({ ok: false, error: 'not implemented' })
    }
    return { state }
  },
})

const StaticStartRunner = (run: WorkflowRunState): ActorDef<WorkflowRunnerMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg.type === 'start') msg.replyTo.send({ ok: true, run })
    else if ('replyTo' in msg) msg.replyTo.send({ ok: false, error: 'not implemented' })
    return { state }
  },
})

const StaticRunRunner = (run: WorkflowRunState): ActorDef<WorkflowRunnerMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg.type === 'get' && msg.runId === 'run-url') {
      msg.replyTo.send({
        ok: true,
        run: {
          ...run,
          runId: 'run-url',
          outputs: { report: { type: 'artifact', url: 'generated/image.png', mimeType: 'image/png' } },
          taskStates: {
            'write-report': {
              status: 'completed',
              attempts: 1,
              outputs: { report: { type: 'artifact', url: 'generated/image.png', mimeType: 'image/png' } },
            },
          },
        },
      })
    } else if (msg.type === 'get') msg.replyTo.send({ ok: true, run })
    else if ('replyTo' in msg) msg.replyTo.send({ ok: false, error: 'not implemented' })
    return { state }
  },
})
