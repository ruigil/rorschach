import {
  css,
  customElement,
  html,
  nothing,
  RorschachBase,
  sharedStyles,
  state,
  store,
  StoreController,
  send,
  workspaceStyles,
  type TreeNode,
} from '@rorschach/webkit';

import type { WorkflowsState } from './index.js';
import {
  isLiveWorkflowRunStatus,
  mergeWorkflowRunIntoGraph,
} from './r-workflow-inspector.js';


const DEFAULT_INSPECTOR_WIDTH_PERCENT = 34
const MIN_INSPECTOR_WIDTH_PERCENT = 18
const MAX_INSPECTOR_WIDTH_PERCENT = 72

export const clampWorkflowInspectorWidthPercent = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_INSPECTOR_WIDTH_PERCENT
  return Math.max(MIN_INSPECTOR_WIDTH_PERCENT, Math.min(MAX_INSPECTOR_WIDTH_PERCENT, numeric))
}

export { isLiveWorkflowRunStatus, mergeWorkflowRunIntoGraph }

// Workflow workspace container — owns view state, composes r-tree sidebar and r-workflow-inspector.

@customElement('r-workflow-workspace')
export class RWorkflowWorkspace extends RorschachBase {
  @state() private _view: 'list' | 'graph' | 'loading' | 'error' = 'list'
  @state() private _selectedTaskId: string | null = null
  @state() private _workflowId: string | null = null
  @state() private _runId: string | null = null
  @state() private _lastUpdatedAt: string | null = null
  @state() private _inspectorTab: 'task' | 'workflow' | 'run' | 'events' = 'task'

  private _lastMode = ''
  private _lastGraphValue: any = null

  private _currentMode = new StoreController(this, ['shell', 'currentMode'])
  private _storeGraph = new StoreController(this, ['workflows', 'currentGraph'])
  private _storeWidth = new StoreController(this, ['workflows', 'inspectorWidthPercent'])
  private _storeWorkflows = new StoreController(this, ['workflows', 'workflows'])
  private _storeRuns = new StoreController(this, ['workflows', 'runs'])
  private _storeError = new StoreController(this, ['workflows', 'errorMessage'])

  private get _workflows() { return this._storeWorkflows.value ?? [] }
  private get _runs() { return this._storeRuns.value ?? [] }
  private get _currentGraph() { return this._storeGraph.value }
  private get _errorMsg() { return this._storeError.value ?? '' }

  static override styles = [
    sharedStyles,
    workspaceStyles,
    css`
      :host {
        display: block;
        height: 100%;
        width: 100%;
      }
      .plan-workspace-meta-text {
        font-family: var(--font-mono);
        font-size: 0.62rem;
        color: var(--text-dim);
      }
      .plan-empty {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--text-dim);
        font-size: 0.72rem;
        font-family: var(--font-mono);
      }
      .plan-task-detail-wrap {
        height: 100%;
        overflow-y: auto;
      }
    `
  ];

  override connectedCallback() {
    super.connectedCallback();
    send({ type: 'workflow.list.request' });
    send({ type: 'workflow.runs.request' });
  }

  override updated() {
    const mode = this._currentMode.value as string
    if (mode !== this._lastMode) {
      const isInitialLoad = this._lastMode === ''
      this._lastMode = mode
      if (mode === 'workflows') {
        if (isInitialLoad) {
          const ns = store.namespace<WorkflowsState>('workflows')
          const savedWorkflowId = ns.get('workspaceWorkflowId')
          const savedRunId = ns.get('workspaceRunId')
          if (savedWorkflowId) this.openGraph(savedWorkflowId, savedRunId || undefined)
          else this.openList()
        } else {
          this.openList()
        }
      }
    }

    const graphValue = this._storeGraph.value as any
    if (graphValue !== this._lastGraphValue) {
      this._lastGraphValue = graphValue
      if (graphValue) {
        if (graphValue.nodes && graphValue.nodes.length) {
          this._view = 'graph'
          this._workflowId = graphValue.workflow?.id ?? graphValue.workflowId ?? null
          this._runId = graphValue.run?.runId ?? graphValue.runId ?? null

          const savedTaskId = store.namespace<WorkflowsState>('workflows').get('workspaceSelectedTaskId')
          const candidate = this._selectedTaskId || savedTaskId
          this._selectedTaskId = candidate && graphValue.nodes.some((n: any) => n.id === candidate)
            ? candidate
            : (graphValue.nodes[0]?.id ?? null)

          this._lastUpdatedAt = new Date().toISOString()
        } else if (graphValue.workflowId) {
          this.openGraph(graphValue.workflowId, graphValue.runId)
        } else {
          this._view = 'list'
        }
      }
    }

    // Auto-select first workflow if list loaded and none selected
    if (this._view === 'list' && this._workflows.length > 0 && !this._workflowId) {
      const firstWf = this._workflows[0]
      this.openGraph(firstWf.id)
    }
  }

  openList() {
    this._view = 'loading'
    this._workflowId = null
    this._runId = null
    const ns = store.namespace<WorkflowsState>('workflows')
    ns.set('workspaceView', 'list')
    ns.set('workspaceWorkflowId', null)
    ns.set('workspaceRunId', null)
    ns.set('currentGraph', null)
    ns.set('errorMessage', null)

    send({ type: 'workflow.list.request' })
    send({ type: 'workflow.runs.request' })

    this._view = 'list'
  }

  openGraph(workflowId: string, runId?: string) {
    this._view = 'loading'
    this._workflowId = workflowId
    this._runId = runId ?? null
    const ns = store.namespace<WorkflowsState>('workflows')
    ns.set('workspaceView', 'graph')
    ns.set('workspaceWorkflowId', workflowId)
    ns.set('workspaceRunId', runId ?? null)

    send({ type: 'workflow.list.request' })
    send({ type: 'workflow.graph.request', workflowId, runId })
    send({ type: 'workflow.runs.request' })

    this._view = 'graph'
  }

  private get _treeData(): TreeNode[] {
    const workflows = this._workflows
    const runs = this._runs
    return workflows.map(wf => {
      const wfRuns = runs.filter((r: any) => r.workflowId === wf.id)
      return {
        id: `wf-${wf.id}`,
        label: wf.title || wf.goal || wf.id,
        icon: 'git-branch' as const,
        badge: wfRuns.length ? wfRuns.length : undefined,
        data: { type: 'workflow', workflowId: wf.id },
        children: wfRuns.map((r: any) => ({
          id: `run-${r.runId}`,
          label: `Run ${this._shortRunId(r.runId)}`,
          status: r.status,
          icon: 'play' as const,
          data: { type: 'run', workflowId: wf.id, runId: r.runId },
        })),
      }
    })
  }

  private get _selectedTreeNodeId(): string | null {
    if (this._runId) return `run-${this._runId}`
    if (this._workflowId) return `wf-${this._workflowId}`
    return null
  }

  private _onNodeSelect(e: CustomEvent) {
    const node = e.detail.node
    if (!node || !node.data) return
    const { type, workflowId, runId } = node.data
    if (type === 'workflow') {
      this.openGraph(workflowId)
    } else if (type === 'run') {
      this.openGraph(workflowId, runId)
    }
  }

  private get _selectedWorkflowTitle(): string {
    const wf = this._workflows.find(w => w.id === this._workflowId) || this._currentGraph?.workflow
    return wf?.title || wf?.goal || ''
  }

  override render() {
    return html`
      <r-panel elevation="1" style="height: 100%; display: flex; flex-direction: column;">
        <r-toolbar slot="header-container">
          <div class="ws-header-title">
            <span class="ws-title-base">Workflows</span>
            ${this._selectedWorkflowTitle ? html`
              <span class="ws-title-sep">/</span>
              <span class="ws-title-active">${this._selectedWorkflowTitle}</span>
            ` : nothing}
            ${this._runId ? html`
              <span class="ws-title-sep">/</span>
              <span class="ws-title-active">Run ${this._shortRunId(this._runId)}</span>
            ` : nothing}
          </div>
        </r-toolbar>
        <div class="ws-body">
          <aside class="ws-sidebar">
            <div class="ws-sidebar-tree">
              ${this._workflows.length ? html`
                <r-tree
                  .data=${this._treeData}
                  .selectedId=${this._selectedTreeNodeId}
                  @node-select=${(e: CustomEvent) => this._onNodeSelect(e)}
                ></r-tree>
              ` : (this._view === 'loading' ? html`
                <div style="padding: 1rem; color: var(--text-dim); font-family: var(--font-mono); font-size: 0.72rem;">loading workflows...</div>
              ` : html`
                <r-empty-state name="git-branch" text="No saved workflows"></r-empty-state>
              `)}
            </div>
          </aside>
          <main class="ws-main">
            ${this._renderContent()}
          </main>
        </div>
      </r-panel>
    `
  }

  private _renderContent() {
    switch (this._view) {
      case 'loading':
        return html`<div class="plan-empty"><span>loading...</span></div>`
      case 'error':
        return html`<div class="plan-empty"><span>${this._errorMsg}</span></div>`
      case 'list':
      case 'graph':
        return this._renderMainInspector()
      default:
        return nothing
    }
  }

  private _renderMainInspector() {
    if (!this._currentGraph || !this._currentGraph.nodes?.length) {
      return html`<div class="plan-empty"><span>Select a workflow from the left sidebar</span></div>`
    }
    return html`
      <div class="plan-task-detail-wrap">
        <r-workflow-inspector
          .graph=${this._currentGraph}
          .selectedTaskId=${this._selectedTaskId}
          .tab=${this._inspectorTab}
          @task-select=${(e: CustomEvent) => this._selectTask(e.detail.id)}
          @tab-change=${(e: CustomEvent) => { this._inspectorTab = e.detail.tab }}
          @workflow-start=${(e: CustomEvent) => this._startWorkflow(e.detail.workflowId)}
          @workflow-delete=${(e: CustomEvent) => this._deleteWorkflow(e.detail.workflowId)}
          @run-delete=${(e: CustomEvent) => this._deleteRun(e.detail.runId, e.detail.workflowId)}
        ></r-workflow-inspector>
      </div>
    `
  }

  private _selectTask(taskId: string) {
    this._selectedTaskId = taskId
    store.namespace<WorkflowsState>('workflows').set('workspaceSelectedTaskId', taskId)
  }

  private _startWorkflow(workflowId: string) {
    send({ type: 'workflow.run.start', workflowId })
  }

  private _deleteWorkflow(workflowId: string) {
    send({ type: 'workflow.delete', workflowId })
    this.openList()
  }

  private _deleteRun(runId: string, workflowId?: string) {
    send({ type: 'workflow.run.delete', runId })
    if (workflowId) {
      this.openGraph(workflowId)
    } else {
      this.openList()
    }
  }

  private _formatDateTime(value: any) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
  }

  private _shortRunId(value: string) {
    return value.length > 8 ? value.slice(0, 8) : value
  }
}
