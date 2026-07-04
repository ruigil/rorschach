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
  send
} from '@rorschach/webkit';
import type { ShellState } from '../../../frontend/types/state.js'
import type { WorkflowsState, WORKFLOW_RUN_UPDATED_EVENT as _WRE } from './index.js'
import { WORKFLOW_RUN_UPDATED_EVENT } from './index.js'
import {
  isLiveWorkflowRunStatus,
  mergeWorkflowRunIntoGraph,
} from './r-workflow-inspector.js'

type InspectorTab = 'task' | 'workflow' | 'run' | 'events'

const DEFAULT_INSPECTOR_WIDTH_PERCENT = 34
const MIN_INSPECTOR_WIDTH_PERCENT = 18
const MAX_INSPECTOR_WIDTH_PERCENT = 72

export const clampWorkflowInspectorWidthPercent = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_INSPECTOR_WIDTH_PERCENT
  return Math.max(MIN_INSPECTOR_WIDTH_PERCENT, Math.min(MAX_INSPECTOR_WIDTH_PERCENT, numeric))
}

export { isLiveWorkflowRunStatus, mergeWorkflowRunIntoGraph }

// Workflow workspace container — owns view state, composes r-workflow-list
// and r-workflow-inspector. Phase 3.2: still reads from namespace('shell')
// (currentWorkflowGraph, currentMode). Phase 3.3 migrates to namespace
// ('workflows').

@customElement('r-workflow-workspace')
export class RWorkflowWorkspace extends RorschachBase {
  @state() private _view: 'list' | 'graph' | 'loading' | 'error' = 'list'
  @state() private _selectedTaskId: string | null = null
  @state() private _workflowId: string | null = null
  @state() private _runId: string | null = null
  @state() private _lastUpdatedAt: string | null = null
  @state() private _inspectorTab: InspectorTab = 'task'

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
      .plan-workspace-runs {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.35rem;
        flex: 1;
        min-width: 0;
        overflow: hidden;
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
      .plan-run-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        padding: 0.55rem 0.75rem;
        border-bottom: 1px solid var(--border);
        background: rgba(4, 13, 20, 0.42);
        flex-shrink: 0;
      }
      .plan-run-title {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        min-width: 0;
        flex: 1;
      }
      .plan-run-refresh {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        color: var(--text-dim);
        font-family: var(--font-mono);
        font-size: 0.56rem;
        white-space: nowrap;
      }
      .plan-task-detail-wrap {
        min-height: 0;
        overflow-y: auto;
      }
      .plan-graph {
        position: relative;
        min-height: 180px;
        overflow: hidden;
      }
      .plan-workspace-body-container {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
    `
  ];

  // Connected/disconnected lifecycles do not need local updates anymore

  override updated() {
    const mode = this._currentMode.value as string
    if (mode !== this._lastMode) {
      const isInitialLoad = this._lastMode === ''
      this._lastMode = mode
      if (mode === 'workflows') {
        if (isInitialLoad) {
          const ns = store.namespace<WorkflowsState>('workflows')
          const savedView = ns.get('workspaceView')
          const savedWorkflowId = ns.get('workspaceWorkflowId')
          const savedRunId = ns.get('workspaceRunId')
          if (savedView === 'graph' && savedWorkflowId) this.openGraph(savedWorkflowId, savedRunId || undefined)
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
        if (graphValue.workflowId) {
          this.openGraph(graphValue.workflowId, graphValue.runId)
        } else if (graphValue.nodes && graphValue.nodes.length) {
          this._view = 'graph'
          this._workflowId = graphValue.workflow?.id ?? graphValue.workflowId ?? null
          this._runId = graphValue.run?.runId ?? graphValue.runId ?? null
          
          const savedTaskId = store.namespace<WorkflowsState>('workflows').get('workspaceSelectedTaskId')
          const candidate = this._selectedTaskId || savedTaskId
          this._selectedTaskId = candidate && graphValue.nodes.some((n: any) => n.id === candidate)
            ? candidate
            : (graphValue.nodes[0]?.id ?? null)
            
          this._lastUpdatedAt = new Date().toISOString()
        } else {
          this.openList()
        }
      }
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

    send({ type: 'workflow.graph.request', workflowId, runId })
    send({ type: 'workflow.runs.request' })

    this._view = 'graph'
  }

  override render() {
    const showBack = this._view === 'graph'
    return html`
      <r-panel elevation="1">
        <r-toolbar slot="header-container">
          <div style="display: flex; align-items: center; gap: 8px;">
            ${showBack ? html`
              <r-button variant="ghost" size="sm" icon="chevron-left" @click=${() => this.openList()}>
                Back to Workflows
              </r-button>
              <div style="font-weight: 600; font-size: 0.72rem; color: var(--text); border-left: 1px solid var(--border); padding-left: 8px; margin-left: 4px;">
                ${this._currentGraph?.workflow?.goal ?? 'Workflow'}
              </div>
            ` : html`
              <div style="display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-mid);">
                <r-icon name="git-branch" size="sm" style="margin-right: 6px;"></r-icon>
                <span>Workflows</span>
              </div>
            `}
          </div>
          <span slot="actions" class="plan-workspace-meta-text">
            ${showBack ? this._renderToolbarMeta() : ''}
          </span>
        </r-toolbar>
        <div class="plan-workspace-body-container" style="height: 100%; display: flex; flex-direction: column;">
          ${this._renderContent()}
        </div>
      </r-panel>
    `
  }

  private _renderHeaderRuns() {
    if (!this._workflowId) return nothing
    const runs = this._runs
      .filter(run => run.workflowId === this._workflowId)
      .slice(0, 8)
    if (!runs.length) return nothing
    return html`
      <div class="plan-workspace-runs">
        ${runs.map(run => html`
          <r-button
            class=${`workflow-run-chip${run.runId === this._runId ? ' active' : ''}`}
            variant="badge"
            status=${run.status}
            ?active=${run.runId === this._runId}
            @click=${() => this.openGraph(this._workflowId!, run.runId)}
          >
            <span>${run.status}</span>
            <span>${this._shortRunId(run.runId)}</span>
          </r-button>
        `)}
      </div>
    `
  }

  private _renderContent() {
    switch (this._view) {
      case 'loading':
        return html`<div class="plan-empty"><span>loading...</span></div>`
      case 'error':
        return html`<div class="plan-empty"><span>${this._errorMsg}</span></div>`
      case 'list':
        return html`
          <div style="padding: 1rem; overflow-y: auto; height: 100%; box-sizing: border-box;">
            <r-workflow-list
              .workflows=${this._workflows}
              @open-workflow=${(e: CustomEvent) => this.openGraph(e.detail.workflowId, e.detail.runId)}
            ></r-workflow-list>
          </div>
        `
      case 'graph':
        return this._renderGraphView()
      default:
        return nothing
    }
  }

  private _renderGraphView() {
    if (!this._currentGraph || !this._currentGraph.nodes?.length) {
      return html`<div class="plan-empty"><span>workflow has no tasks</span></div>`
    }
    return html`
      <div class="plan-run-header">
        <div class="plan-run-title">
          ${this._renderHeaderRuns()}
        </div>
        <div class="plan-run-refresh">
          ${this._runId ? html`<span>${isLiveWorkflowRunStatus(this._currentGraph.run?.status) ? 'live' : 'snapshot'}</span>` : html`<span>definition</span>`}
          ${this._lastUpdatedAt ? html`<span>${this._formatTime(this._lastUpdatedAt)}</span>` : nothing}
        </div>
      </div>
      <r-split-pane
        orientation="vertical"
        style="flex: 1; min-height: 0;"
        .splitPercent=${clampWorkflowInspectorWidthPercent(this._storeWidth.value)}
        .minPercent=${MIN_INSPECTOR_WIDTH_PERCENT}
        .maxPercent=${MAX_INSPECTOR_WIDTH_PERCENT}
        @resize-end=${(e: CustomEvent) => {
          store.namespace<WorkflowsState>('workflows').set('inspectorWidthPercent', e.detail.splitPercent)
        }}
      >
        <div slot="primary" class="plan-task-detail-wrap" style="height: 100%; overflow: hidden;">
          <r-workflow-inspector
            style="height: 100%; display: flex; flex-direction: column;"
            .graph=${this._currentGraph}
            .selectedTaskId=${this._selectedTaskId}
            .tab=${this._inspectorTab}
            @task-select=${(e: CustomEvent) => { this._selectedTaskId = e.detail.id }}
            @tab-change=${(e: CustomEvent) => { this._inspectorTab = e.detail.tab }}
          ></r-workflow-inspector>
        </div>
        <r-force-graph
          slot="secondary"
          class="plan-graph"
          .planData=${this._currentGraph}
          .selectedTaskId=${this._selectedTaskId}
          @node-select=${(e: CustomEvent) => this._selectTask(e.detail.id)}
        ></r-force-graph>
      </r-split-pane>
    `
  }

  private _selectTask(taskId: string) {
    this._selectedTaskId = taskId
    this._inspectorTab = 'task'
    store.namespace<WorkflowsState>('workflows').set('workspaceSelectedTaskId', taskId)
  }

  private _renderToolbarMeta() {
    const workflow = this._currentGraph?.workflow
    if (!workflow) return nothing
    return html`${this._formatDateTime(workflow.createdAt)} · ${workflow.taskCount} tasks`
  }

  // Old fetch/REST helpers have been replaced by reactive WebSocket state management

  private _formatDateTime(value: any) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
  }

  private _formatTime(value: any) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString()
  }

  private _shortRunId(value: string) {
    return value.length > 8 ? value.slice(0, 8) : value
  }

}
