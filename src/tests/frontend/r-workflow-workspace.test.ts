import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cleanup, mountClass } from '../helpers/frontend.js'
import { RWorkflowWorkspace, isLiveWorkflowRunStatus } from '../../frontend/components/r-workflow-workspace.js'

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
  test('knows which run statuses should poll', () => {
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

  test('polls live run graphs and stops once the run is terminal', async () => {
    const responses = [graph('running'), graph('completed')]
    globalThis.fetch = (async () => new Response(JSON.stringify(responses.shift() ?? graph('completed')), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    const el = await mountClass(RWorkflowWorkspace) as any
    await el.openGraph('workflow-1', 'run-1')
    expect(el._pollTimer).toBeTruthy()

    await el._pollGraph()
    expect(el._currentGraph.run.status).toBe('completed')
    expect(el._pollTimer).toBeNull()
  })
})
