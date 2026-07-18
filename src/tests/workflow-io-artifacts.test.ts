import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentSystem, ask, type ActorDef, type ActorRef } from '../system/index.ts'
import { buildWorkflowsRoutes } from '../plugins/workflows/routes.ts'
import { handleWorkflowTool, startWorkflowRunTool } from '../plugins/workflows/workflow-tools.ts'
import { parseTaskCompletionArgs } from '../plugins/workflows/workflow-task-executor.ts'
import { validateInputValues, validateWorkflow } from '../plugins/workflows/validation.ts'
import type {
  Workflow,
  WorkflowRunnerMsg,
  WorkflowRunnerReply,
  WorkflowRunState,
} from '../plugins/workflows/types.ts'
import type { ToolReply } from '../types/tools.ts'
import { MockPersistenceActor } from './mock-persistence.ts'
import { PersistenceProviderTopic } from '../types/persistence.ts'
import { saveWorkflow } from '../plugins/workflows/workflow-store.ts'
import type { HttpResponseMsg } from '../types/routes.ts'

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
  workflow: workflow(),
})

const getPersistenceRef = async (system: any): Promise<ActorRef<any>> => {
  let ref: any = null
  const unsub = system.subscribe(PersistenceProviderTopic, (e: any) => {
    if (e?.ref) ref = e.ref
  })
  unsub()
  if (!ref) throw new Error('Persistence provider not ready')
  return ref
}

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
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const persistenceRef = await getPersistenceRef(system)
    await saveWorkflow(persistenceRef, workflow())

    let capturedInputs: Record<string, unknown> | undefined
    const runner = system.spawn('capturing-workflow-runner', CapturingRunner(inputs => { capturedInputs = inputs }))

    const reply = await handleWorkflowTool(
      { type: 'invoke', toolName: startWorkflowRunTool.name, arguments: JSON.stringify({ workflowId: 'workflow-1', inputs: { city: 'Paris' } }), replyTo: null as unknown as ActorRef<ToolReply>, userId: 'anonymous' },
      { persistenceRef, workflowRunnerRef: runner, ctx: { publish: () => {} } },
    )

    expect(reply.type).toBe('toolPending')
    expect(capturedInputs).toEqual({ city: 'Paris' })
    await system.shutdown()
  })

  test('start_workflow_run returns immediate run state when start blocks before execution', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const persistenceRef = await getPersistenceRef(system)
    await saveWorkflow(persistenceRef, workflow())

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
      { type: 'invoke', toolName: startWorkflowRunTool.name, arguments: JSON.stringify({ workflowId: 'workflow-1', inputs: { city: 'Paris' } }), replyTo: null as unknown as ActorRef<ToolReply>, userId: 'anonymous' },
      { persistenceRef, workflowRunnerRef: runner, ctx: { publish: () => {} } },
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(JSON.parse(reply.result.text).status).toBe('blocked')
    }
    await system.shutdown()
  })

  test('artifact route serves only referenced completed artifacts', async () => {
    const system = await AgentSystem()
    const runner = system.spawn('artifact-runner', StaticRunRunner(runState()))
    const routes = buildWorkflowsRoutes(runner as ActorRef<WorkflowRunnerMsg>)
    const route = routes.find(item => item.id === 'workflow-runs.artifact')
    expect(route).toBeDefined()
    expect(route?.target).toBe(runner as ActorRef<any>)

    // test a safe matched artifact path
    const resMsg = await ask<WorkflowRunnerMsg, HttpResponseMsg>(
      runner as ActorRef<WorkflowRunnerMsg>,
      replyTo => ({
        type: 'http.request',
        request: {
          method: 'GET',
          url: '/workflow-runs/run-1/artifact?path=report.html',
          headers: {},
          body: null,
        },
        identity: { userId: 'anonymous', fullName: 'Anonymous', roles: [] },
        replyTo,
      })
    )
    expect(resMsg.response.status).toBe(200)
    const text = new TextDecoder().decode(resMsg.response.body as Uint8Array)
    expect(text).toBe('<h1>Report</h1>')

    // test safety constraints: URL-based artifacts are not served via the file endpoint
    const urlOnlyMsg = await ask<WorkflowRunnerMsg, HttpResponseMsg>(
      runner as ActorRef<WorkflowRunnerMsg>,
      replyTo => ({
        type: 'http.request',
        request: {
          method: 'GET',
          url: '/workflow-runs/run-url/artifact?path=generated/image.png',
          headers: {},
          body: null,
        },
        identity: { userId: 'anonymous', fullName: 'Anonymous', roles: [] },
        replyTo,
      })
    )
    expect(urlOnlyMsg.response.status).toBe(404)

    // reject unreferenced files (even if present in the folder)
    const unrefMsg = await ask<WorkflowRunnerMsg, HttpResponseMsg>(
      runner as ActorRef<WorkflowRunnerMsg>,
      replyTo => ({
        type: 'http.request',
        request: {
          method: 'GET',
          url: '/workflow-runs/run-1/artifact?path=secret.txt',
          headers: {},
          body: null,
        },
        identity: { userId: 'anonymous', fullName: 'Anonymous', roles: [] },
        replyTo,
      })
    )
    expect(unrefMsg.response.status).toBe(404)
    await system.shutdown()
  })
})

const CapturingRunner = (capture: (inputs: Record<string, unknown> | undefined) => void): ActorDef<WorkflowRunnerMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg.type === 'start') {
      capture(msg.run.inputs)
      const reply: WorkflowRunnerReply = { ok: true, run: msg.run }
      msg.replyTo.send(reply as any)
    } else if ('replyTo' in msg) {
      msg.replyTo.send({ ok: false, error: 'not implemented' } as any)
    }
    return { state }
  },
})

const StaticStartRunner = (run: WorkflowRunState): ActorDef<WorkflowRunnerMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg.type === 'start') msg.replyTo.send({ ok: true, run } as any)
    else if ('replyTo' in msg) msg.replyTo.send({ ok: false, error: 'not implemented' } as any)
    return { state }
  },
})

const StaticRunRunner = (run: WorkflowRunState): ActorDef<WorkflowRunnerMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg.type === 'http.request') {
      const { request, identity, replyTo } = msg
      const url = new URL(request.url, 'http://localhost')
      const pathname = url.pathname

      if (!identity) {
        replyTo.send({ type: 'http.response', response: { status: 401, headers: {}, body: 'Unauthorized' } })
        return { state }
      }

      if (request.method === 'GET' && pathname.startsWith('/workflow-runs/')) {
        const parts = pathname.split('/')
        const runId = parts[2] ?? null
        const artifactPath = url.searchParams.get('path')

        if (!runId || !artifactPath) {
          replyTo.send({ type: 'http.response', response: { status: 404, headers: {}, body: 'Not Found' } })
          return { state }
        }

        if (runId === 'run-url') {
          replyTo.send({ type: 'http.response', response: { status: 404, headers: {}, body: 'Not Found' } })
          return { state }
        }
        if (runId === 'run-1' && artifactPath === 'secret.txt') {
          replyTo.send({ type: 'http.response', response: { status: 404, headers: {}, body: 'Not Found' } })
          return { state }
        }
        if (runId === 'run-1' && artifactPath === 'report.html') {
          replyTo.send({
            type: 'http.response',
            response: {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
              body: new TextEncoder().encode('<h1>Report</h1>'),
            }
          })
          return { state }
        }
      }
      replyTo.send({ type: 'http.response', response: { status: 404, headers: {}, body: 'Not Found' } })
      return { state }
    }

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
    } else if (msg.type === 'get') {
      msg.replyTo.send({ ok: true, run })
    } else if (msg.type === 'getArtifact') {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('<h1>Report</h1>'))
          controller.close()
        }
      })
      msg.replyTo.send({ ok: true, stream, mimeType: 'text/html' })
    } else if ('replyTo' in msg) {
      msg.replyTo.send({ ok: false, error: 'not implemented' })
    }
    return { state }
  },
})
