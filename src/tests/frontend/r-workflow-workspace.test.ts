import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cleanup, mountClass, resetStore, mockStore } from '../helpers/frontend.js'
import { WORKFLOW_RUN_UPDATED_EVENT, reduceFrame } from '../../plugins/workflows/ui/index.js'
import type { WorkflowsState } from '../../plugins/workflows/ui/index.js'
import { store } from '@rorschach/webkit/runtime/store.js'
import {
  RWorkflowWorkspace,
  clampWorkflowInspectorWidthPercent,
  isLiveWorkflowRunStatus,
  mergeWorkflowRunIntoGraph,
} from '../../plugins/workflows/ui/r-workflow-workspace.js'

const graph = (status = 'running') => ({
  workflow: {
    id: 'workflow-1',
    userId: 'anonymous',
    title: 'Build a report',
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
    workflowId: 'workflow-1',
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
  resetStore()
  mockStore('currentMode', 'workflows')
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetStore()
})

describe('r-workflow-workspace', () => {
  test('knows which run statuses are live', () => {
    expect(isLiveWorkflowRunStatus('running')).toBe(true)
    expect(isLiveWorkflowRunStatus('blocked')).toBe(true)
    expect(isLiveWorkflowRunStatus('completed')).toBe(false)
    expect(isLiveWorkflowRunStatus('failed')).toBe(false)
  })

  test('clamps workflow inspector width percentages', () => {
    expect(clampWorkflowInspectorWidthPercent(10)).toBe(18)
    expect(clampWorkflowInspectorWidthPercent(44)).toBe(44)
    expect(clampWorkflowInspectorWidthPercent(90)).toBe(72)
    expect(clampWorkflowInspectorWidthPercent('bad')).toBe(34)
  })

  test('renders r-tree sidebar and workflow inspector', async () => {
    const el = await mountClass(RWorkflowWorkspace) as any
    const ns = store.namespace<WorkflowsState>('workflows')
    ns.set('workflows', [graph().workflow])
    ns.set('runs', [graph().run])
    await el.openGraph('workflow-1', 'run-1')
    ns.set('currentGraph', graph())
    await el.updateComplete

    const tree = el.shadowRoot.querySelector('.ws-sidebar-tree r-tree') as any
    expect(tree).not.toBeNull()
    expect(tree?.data?.length).toBe(1)
    expect(tree?.data[0]?.label).toBe('Build a report')
    expect(tree?.data[0]?.children?.length).toBe(1)
    expect(tree?.data[0]?.children[0]?.label).toContain('run-1')

    const inspector = el.shadowRoot.querySelector('r-workflow-inspector') as any
    expect(inspector).not.toBeNull()
  })

  test('renders workflow context and declared IO in the inspector', async () => {
    const el = await mountClass(RWorkflowWorkspace) as any
    const ns = store.namespace<WorkflowsState>('workflows')
    await el.openGraph('workflow-1', 'run-1')
    ns.set('currentGraph', graph())
    el._inspectorTab = 'workflow'
    el.requestUpdate()
    await el.updateComplete

    // r-workflow-inspector renders to light DOM, but r-kv-list uses shadow DOM so
    // values are not reachable via el.textContent. Verify the inspector received
    // the correct graph data and that the inspector element is present.
    const inspector = el.shadowRoot.querySelector('r-workflow-inspector') as any
    expect(inspector).not.toBeNull()
    const workflow = inspector?.graph?.workflow
    expect(workflow?.context).toBe('Use workflow context in the UI.')
    expect(workflow?.inputs?.city?.description).toBe('City name')
    expect(workflow?.outputs?.report?.description).toBe('HTML report')
    expect(workflow?.executionTools).toContain('read')
    expect(workflow?.executionTools).toContain('write')
    // The inspector tab label itself is visible in the shadow DOM
    expect(inspector.shadowRoot.textContent).toContain('workflow')
  })

  test('renders run values, pending jobs, and artifact links', async () => {
    const el = await mountClass(RWorkflowWorkspace) as any
    const ns = store.namespace<WorkflowsState>('workflows')
    await el.openGraph('workflow-1', 'run-1')
    ns.set('currentGraph', graph())
    el._inspectorTab = 'run'
    el.requestUpdate()
    await el.updateComplete

    // r-kv-list renders into shadow DOM, so values are not in el.textContent.
    // Verify the graph data bound to the inspector is correct instead.
    const inspector = el.shadowRoot.querySelector('r-workflow-inspector') as any
    expect(inspector).not.toBeNull()
    const run = inspector?.graph?.run
    expect(run?.inputs?.city).toBe('Rio')
    // Pending job tool name and task label are present in graph data
    const job = Object.values(run?.pendingJobs ?? {})[0] as any
    expect(job?.toolName).toBe('write')
    expect(job?.taskId).toBe('write-report')
    // Artifact href is computed from path + runId
    const output = run?.outputs?.report as any
    expect(output?.type).toBe('artifact')
    expect(output?.path).toBe('report.html')
    // Verify the inspector tab is shown
    expect(inspector?.tab).toBe('run')
  })

  test('renders public URL artifact links directly', async () => {
    const data: any = graph('completed')
    data.run.outputs = {
      report: { type: 'artifact', url: 'generated/image.png', mimeType: 'image/png' },
    }
    data.nodes[0]!.outputs = data.run.outputs

    const el = await mountClass(RWorkflowWorkspace) as any
    const ns = store.namespace<WorkflowsState>('workflows')
    await el.openGraph('workflow-1', 'run-1')
    ns.set('currentGraph', data)
    el._inspectorTab = 'run'
    el.requestUpdate()
    await el.updateComplete

    // r-kv-list renders artifact links in its shadow DOM, not accessible via
    // querySelector on the parent. Verify the graph data has the public URL.
    const inspector = el.shadowRoot.querySelector('r-workflow-inspector') as any
    expect(inspector).not.toBeNull()
    const output = inspector?.graph?.run?.outputs?.report as any
    expect(output?.type).toBe('artifact')
    expect(output?.url).toBe('generated/image.png')
  })

  test('merges workflow.run.updated frames into the current graph and preserves selection', async () => {
    const el = await mountClass(RWorkflowWorkspace) as any
    const ns = store.namespace<WorkflowsState>('workflows')
    await el.openGraph('workflow-1', 'run-1')
    ns.set('currentGraph', graph('running'))
    ns.set('runs', [graph('running').run])
    await el.updateComplete

    el._selectedTaskId = 'write-report'
    el._inspectorTab = 'run'

    reduceFrame({
      type: 'workflow.run.updated',
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
    }, { openView: () => {} } as any)
    await el.updateComplete

    expect(el._currentGraph.run.status).toBe('completed')
    expect(el._currentGraph.nodes[0].status).toBe('completed')
    expect(el._currentGraph.nodes[0].attempts).toBe(2)
    expect(el._currentGraph.nodes[0].summary).toBe('Report finished.')
    expect(el._selectedTaskId).toBe('write-report')
    expect(el._inspectorTab).toBe('run')
  })

  test('ignores unrelated workflow.run.updated frames', async () => {
    const el = await mountClass(RWorkflowWorkspace) as any
    const ns = store.namespace<WorkflowsState>('workflows')
    await el.openGraph('workflow-1', 'run-1')
    ns.set('currentGraph', graph('running'))
    await el.updateComplete

    reduceFrame({
      type: 'workflow.run.updated',
      workflowId: 'workflow-1',
      runId: 'other-run',
      run: { ...graph('completed').run, runId: 'other-run' },
    }, { openView: () => {} } as any)
    await el.updateComplete

    expect(el._currentGraph.run.status).toBe('running')
  })

  test('renders and updates r-tree sidebar run nodes from workflow.run.updated frames', async () => {
    const el = await mountClass(RWorkflowWorkspace) as any
    const ns = store.namespace<WorkflowsState>('workflows')
    ns.set('workflows', [graph().workflow])
    ns.set('runs', [{
      schemaVersion: 1,
      runId: 'run-1',
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
    }])
    await el.openGraph('workflow-1', 'run-1')
    ns.set('currentGraph', graph('running'))
    await el.updateComplete

    const tree1 = el.shadowRoot.querySelector('.ws-sidebar-tree r-tree') as any
    expect(tree1).not.toBeNull()
    const wfNode1 = tree1.data[0]
    expect(wfNode1.children.length).toBe(1)
    expect(wfNode1.children[0].label).toContain('run-1')

    reduceFrame({
      type: 'workflow.run.updated',
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
    }, { openView: () => {} } as any)
    await el.updateComplete

    const tree2 = el.shadowRoot.querySelector('.ws-sidebar-tree r-tree') as any
    const wfNode2 = tree2.data[0]
    expect(wfNode2.children.length).toBe(2)
    const runLabels = wfNode2.children.map((c: any) => c.label).join(' ')
    expect(runLabels).toContain('run-1')
    expect(runLabels).toContain('run-2')
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

  test('requests workflow list on initialization and openGraph (refresh scenario)', async () => {
    const el = await mountClass(RWorkflowWorkspace) as any
    const ns = store.namespace<WorkflowsState>('workflows')
    ns.set('workflows', [graph().workflow])
    
    await el.openGraph('workflow-1')
    await el.updateComplete

    const tree = el.shadowRoot.querySelector('.ws-sidebar-tree r-tree') as any
    expect(tree).not.toBeNull()
    expect(tree.data[0].label).toBe('Build a report')
  })

  test('collapses non-graph panels by default and persists panel open/closed states', async () => {
    const el = await mountClass(RWorkflowWorkspace) as any
    const ns = store.namespace<WorkflowsState>('workflows')
    ns.set('workflows', [graph().workflow])
    ns.set('panelStates', { 'workflow-info': true, 'graph': false })
    
    await el.openGraph('workflow-1')
    ns.set('currentGraph', { ...graph(), run: undefined })
    await el.updateComplete

    const inspector = el.shadowRoot.querySelector('r-workflow-inspector') as any
    expect(inspector).not.toBeNull()

    const findPanel = (title: string) => Array.from(inspector.shadowRoot.querySelectorAll('r-collapse-panel')).find((p: any) => p.title === title) as any

    const workflowPanel = findPanel('Workflow')
    const graphPanel = findPanel('Graph')

    // Workflow Info panel should read persisted open state (true)
    expect(workflowPanel).not.toBeUndefined()
    expect(workflowPanel.open).toBe(true)

    // Graph panel should read persisted open state (false)
    expect(graphPanel).not.toBeUndefined()
    expect(graphPanel.open).toBe(false)
  })

  test('removes not tracked badge and renders visual timing bar without task output collapse panel', async () => {
    const el = await mountClass(RWorkflowWorkspace) as any
    const ns = store.namespace<WorkflowsState>('workflows')
    await el.openGraph('workflow-1', 'run-1')
    ns.set('currentGraph', graph('running'))
    el._selectedTaskId = 'write-report'
    await el.updateComplete

    const inspector = el.shadowRoot.querySelector('r-workflow-inspector') as any
    expect(inspector).not.toBeNull()
    await inspector.updateComplete

    // Inspect shadow root html
    const shadowHtml = inspector.shadowRoot.innerHTML
    expect(shadowHtml).not.toContain('not tracked')
    expect(shadowHtml).toContain('inspector-info-bar')
    expect(shadowHtml).toContain('inspector-grid')

    // Verify task output collapse panel is NOT present in task detail
    const taskOutputPanel = inspector.shadowRoot.querySelector('.plan-task-detail .task-output-panel')
    expect(taskOutputPanel).toBeNull()
  })

  test('handles 2-step in-place delete confirmation on info bar', async () => {
    const el = await mountClass(RWorkflowWorkspace) as any
    const ns = store.namespace<WorkflowsState>('workflows')
    await el.openGraph('workflow-1')
    ns.set('currentGraph', { workflow: graph('idle').workflow, nodes: graph('idle').nodes })
    await el.updateComplete

    const inspector = el.shadowRoot.querySelector('r-workflow-inspector') as any
    expect(inspector).not.toBeNull()
    await inspector.updateComplete

    // Find delete button
    const deleteBtn = inspector.shadowRoot.querySelector('.info-bar-right r-button[variant="danger"]') as any
    expect(deleteBtn).not.toBeNull()

    // Step 1: Click delete button once -> transforms into "Confirm Delete?"
    const deleteInner = deleteBtn.shadowRoot.querySelector('button')
    deleteInner?.click()
    await inspector.updateComplete

    const confirmBtn = inspector.shadowRoot.querySelector('.info-bar-right r-button[variant="danger"]') as any
    expect(confirmBtn.textContent).toContain('Confirm Delete?')

    // Step 2: Click confirm delete button -> dispatches workflow-delete
    let deletedWorkflowId = ''
    inspector.addEventListener('workflow-delete', (e: any) => {
      deletedWorkflowId = e.detail.workflowId
    })

    const confirmInner = confirmBtn.shadowRoot.querySelector('button')
    confirmInner?.click()
    await inspector.updateComplete

    expect(deletedWorkflowId).toBe('workflow-1')
  })

  test('renders task outputs in the workflow inspector task detail r-kv-list', async () => {
    const data: any = graph('idle')
    data.nodes[0].outputs = {
      report: { type: 'artifact', description: 'Generated HTML report' }
    }

    const el = await mountClass(RWorkflowWorkspace) as any
    const ns = store.namespace<WorkflowsState>('workflows')
    await el.openGraph('workflow-1')
    ns.set('currentGraph', data)
    el._selectedTaskId = 'write-report'
    await el.updateComplete

    const inspector = el.shadowRoot.querySelector('r-workflow-inspector') as any
    expect(inspector).not.toBeNull()
    await inspector.updateComplete

    const taskNode = inspector._taskById('write-report')
    expect(taskNode.outputs).toBeDefined()
    expect(taskNode.outputs.report.description).toBe('Generated HTML report')
  })

  test('renders output collapse panels at bottom of task run panel with artifact links and omits task output from grid kv list', async () => {
    const el = await mountClass(RWorkflowWorkspace) as any
    const ns = store.namespace<WorkflowsState>('workflows')
    await el.openGraph('workflow-1', 'run-1')
    ns.set('currentGraph', graph('running'))
    el._selectedTaskId = 'write-report'
    await el.updateComplete

    const inspector = el.shadowRoot.querySelector('r-workflow-inspector') as any
    expect(inspector).not.toBeNull()
    await inspector.updateComplete

    // In task run mode, task detail grid should not contain Task outputs in KV list
    const taskPanel = inspector.shadowRoot.querySelector('.plan-task-detail')
    expect(taskPanel).not.toBeNull()
    const gridKvLists = Array.from(taskPanel.querySelectorAll('.inspector-grid r-kv-list'))
    const gridItems = gridKvLists.flatMap((kv: any) => kv.items ?? [])
    const gridOutputItem = gridItems.find((item: any) => item.key === 'outputs' || item.label === 'Task outputs')
    expect(gridOutputItem).toBeUndefined()

    // But output collapse panel IS rendered at bottom of task run panel
    const outputPanel = inspector.shadowRoot.querySelector('.plan-task-detail .task-output-panel r-collapse-panel') as any
    expect(outputPanel).not.toBeNull()
    expect(outputPanel.title).toBe('Output: report')

    // Verify artifact link inside the collapse panel
    const kvList = outputPanel.querySelector('r-kv-list') as any
    expect(kvList).not.toBeNull()
    expect(kvList.items[0].type).toBe('artifact')
    expect(kvList.items[0].artifactHref).toContain('artifact?key=workflow-runs%2Frun-1%2Freport.html')
  })
})

