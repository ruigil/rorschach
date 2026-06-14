import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cleanup, mountClass } from '../helpers/frontend.js'
import { WORKFLOW_RUN_UPDATED_EVENT } from '../../frontend/connection.js'
import { RWorkflowWorkspace, isLiveWorkflowRunStatus, mergeWorkflowRunIntoGraph } from '../../frontend/components/r-workflow-workspace.js'

const graph = (status = 'running') => ({
  workflow: {
    id: 'workflow-1',
    userId: 'anonymous',
    goal: 'Build a report',
    context: 'Use workflow context in the UI.',
    createdAt: '2026-06-12T10:00:00.000Z',
    taskCount: 1,
    executionTools: ['read', 'write'],
    inputs: {
      city: { type: 'string', required: true, description: 'City name' },
    },
    outputs: {
      report: { type: 'artifact', required: true, description: 'HTML report' },
    },
  },
  run: {
    runId: 'run-1',
    status,
    inputs: { city: 'Rio' },
    activeTaskIds: status === 'running' ? ['write-report'] : [],
    activeTasks: {},
    pendingJobs: status === 'running'
      ? { 'job-1': { taskId: 'write-report', toolName: 'write', startedAt: '2026-06-12T10:01:00.000Z' } }
      : {},
    outputs: {
      report: { type: 'artifact', path: 'report.html', mimeType: 'text/html' },
    },
    events: [
      { timestamp: '2026-06-12T10:00:00.000Z', type: 'runStarted', message: 'Run started.' },
    ],
  },
  nodes: [{
    id: 'write-report',
    label: 'Write report',
    description: 'Write the report.',
    validationCriteria: 'Report exists.',
    dependencies: [],
    dependents: [],
    status,
    attempts: 1,
    startedAt: '2026-06-12T10:00:00.000Z',
    outputs: {
      report: { type: 'artifact', path: 'report.html', mimeType: 'text/html' },
    },
  }],
  edges: [],
})

beforeEach(() => {
  cleanup()
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('r-workflow-workspace', () => {
  test('knows which run statuses are live', () => {
    expect(isLiveWorkflowRunStatus('running')).toBe(true)
    expect(isLiveWorkflowRunStatus('blocked')).toBe(true)
    expect(isLiveWorkflowRunStatus('completed')).toBe(false)
    expect(isLiveWorkflowRunStatus('failed')).toBe(false)
  })

  test('renders workflow context and declared IO in the inspector', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(graph()), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    const el = await mountClass(RWorkflowWorkspace) as any
    await el.openGraph('workflow-1', 'run-1')
    el._inspectorTab = 'workflow'
    el.requestUpdate()
    await el.updateComplete

    const text = el.textContent
    expect(text).toContain('Use workflow context in the UI.')
    expect(text).toContain('city')
    expect(text).toContain('City name')
    expect(text).toContain('report')
    expect(text).toContain('HTML report')
    expect(text).toContain('read, write')
  })

  test('renders run values, pending jobs, and artifact links', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(graph()), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    const el = await mountClass(RWorkflowWorkspace) as any
    await el.openGraph('workflow-1', 'run-1')
    el._inspectorTab = 'run'
    el.requestUpdate()
    await el.updateComplete

    expect(el.textContent).toContain('Rio')
    expect(el.textContent).toContain('write for Write report')
    const link = el.querySelector('.workflow-artifact-link') as HTMLAnchorElement | null
    expect(link?.getAttribute('href')).toBe('workflow-runs/run-1/artifact?path=report.html')
  })

  test('renders public URL artifact links directly', async () => {
    const data: any = graph('completed')
    data.run.outputs = {
      report: { type: 'artifact', url: 'generated/image.png', mimeType: 'image/png' },
    }
    data.nodes[0]!.outputs = data.run.outputs
    globalThis.fetch = (async () => new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    const el = await mountClass(RWorkflowWorkspace) as any
    await el.openGraph('workflow-1', 'run-1')
    el._inspectorTab = 'run'
    el.requestUpdate()
    await el.updateComplete

    const link = el.querySelector('.workflow-artifact-link') as HTMLAnchorElement | null
    expect(link?.getAttribute('href')).toBe('generated/image.png')
  })

  test('merges workflowRunUpdated frames into the current graph and preserves selection', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(graph('running')), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    const el = await mountClass(RWorkflowWorkspace) as any
    await el.openGraph('workflow-1', 'run-1')
    el._selectedTaskId = 'write-report'
    el._inspectorTab = 'run'

    window.dispatchEvent(new CustomEvent(WORKFLOW_RUN_UPDATED_EVENT, {
      detail: {
        type: 'workflowRunUpdated',
        workflowId: 'workflow-1',
        runId: 'run-1',
        run: {
          schemaVersion: 1,
          runId: 'run-1',
          workflowId: 'workflow-1',
          userId: 'anonymous',
          status: 'completed',
          inputs: { city: 'Rio' },
          outputs: { report: { type: 'artifact', path: 'report.html', mimeType: 'text/html' } },
          activeTaskIds: [],
          activeTasks: {},
          pendingJobs: {},
          taskStates: {
            'write-report': {
              status: 'completed',
              attempts: 2,
              startedAt: '2026-06-12T10:00:00.000Z',
              completedAt: '2026-06-12T10:02:00.000Z',
              summary: 'Report finished.',
              outputs: { report: { type: 'artifact', path: 'report.html', mimeType: 'text/html' } },
            },
          },
          events: [
            { timestamp: '2026-06-12T10:00:00.000Z', type: 'runStarted', message: 'Run started.' },
            { timestamp: '2026-06-12T10:02:00.000Z', type: 'runCompleted', message: 'Workflow run completed.' },
          ],
        },
      },
    }))
    await el.updateComplete

    expect(el._currentGraph.run.status).toBe('completed')
    expect(el._currentGraph.nodes[0].status).toBe('completed')
    expect(el._currentGraph.nodes[0].attempts).toBe(2)
    expect(el._currentGraph.nodes[0].summary).toBe('Report finished.')
    expect(el._selectedTaskId).toBe('write-report')
    expect(el._inspectorTab).toBe('run')
  })

  test('ignores unrelated workflowRunUpdated frames', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(graph('running')), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    const el = await mountClass(RWorkflowWorkspace) as any
    await el.openGraph('workflow-1', 'run-1')

    window.dispatchEvent(new CustomEvent(WORKFLOW_RUN_UPDATED_EVENT, {
      detail: {
        type: 'workflowRunUpdated',
        workflowId: 'workflow-1',
        runId: 'other-run',
        run: { ...graph('completed').run, runId: 'other-run' },
      },
    }))
    await el.updateComplete

    expect(el._currentGraph.run.status).toBe('running')
  })

  test('updates list view run chips from workflowRunUpdated frames', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.endsWith('/workflows')
        ? [{ id: 'workflow-1', goal: 'Build a report', createdAt: '2026-06-12T10:00:00.000Z', taskCount: 1 }]
        : []
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    const el = await mountClass(RWorkflowWorkspace) as any
    await el.openList()

    window.dispatchEvent(new CustomEvent(WORKFLOW_RUN_UPDATED_EVENT, {
      detail: {
        type: 'workflowRunUpdated',
        workflowId: 'workflow-1',
        runId: 'run-2',
        run: {
          schemaVersion: 1,
          runId: 'run-2',
          workflowId: 'workflow-1',
          userId: 'anonymous',
          status: 'running',
          inputs: {},
          outputs: {},
          activeTaskIds: [],
          activeTasks: {},
          pendingJobs: {},
          taskStates: {},
          events: [],
        },
      },
    }))
    await el.updateComplete

    expect(el.textContent).toContain('running')
    expect(el.textContent).toContain('run-2')
  })

  test('pure graph merge projects taskStates onto nodes', () => {
    const merged = mergeWorkflowRunIntoGraph(graph('running'), {
      ...graph('completed').run,
      taskStates: {
        'write-report': {
          status: 'failed',
          attempts: 3,
          error: 'Tool failed.',
        },
      },
    })

    expect(merged.nodes[0].status).toBe('failed')
    expect(merged.nodes[0].attempts).toBe(3)
    expect(merged.nodes[0].error).toBe('Tool failed.')
  })
})
