import { html, nothing, css } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import { RorschachBase } from '@rorschach/frontend/webkit/base.js'
import { sharedStyles } from '@rorschach/frontend/webkit/shared-styles.js'
import { StoreController } from '@rorschach/frontend/webkit/store-controller.js'
import { store } from '@rorschach/frontend/webkit/store.js'
import type { ShellState } from '../../../frontend/types/state.js'
import type { WorkflowsState, WORKFLOW_RUN_UPDATED_EVENT as _WRE } from './index.js'
import { WORKFLOW_RUN_UPDATED_EVENT } from './index.js'
import {
  isLiveWorkflowRunStatus,
  mergeWorkflowRunIntoGraph,
} from './r-workflow-inspector.js'
import '@rorschach/frontend/webkit/r-panel.js'
import '@rorschach/frontend/webkit/r-button.js'
import '@rorschach/frontend/webkit/r-split-pane.js'
import '@rorschach/frontend/webkit/r-toolbar.js'
import '@rorschach/frontend/webkit/r-badge.js'

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
  @state() private _errorMsg = ''
  @state() private _workflows: any[] = []
  @state() private _runs: any[] = []
  @state() private _currentGraph: any = null
  @state() private _selectedTaskId: string | null = null
  @state() private _workflowId: string | null = null
  @state() private _runId: string | null = null
  @state() private _lastUpdatedAt: string | null = null
  @state() private _inspectorTab: InspectorTab = 'task'

  private _lastMode = ''
  private _lastGraphValue: any = null
  private _onWorkflowRunUpdated = (event: Event) => {
    this._applyWorkflowRunUpdate((event as CustomEvent).detail)
  }

  private _currentMode = new StoreController(this, ['shell', 'currentMode'])
  private _storeGraph = new StoreController(this, ['workflows', 'currentGraph'])
  private _storeWidth = new StoreController(this, ['workflows', 'inspectorWidthPercent'])

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
      .workflow-run-chip {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        min-width: 0;
        padding: 0.22rem 0.45rem;
        color: var(--text-mid);
        background: rgba(6, 16, 26, 0.74);
        border: 1px solid var(--border);
        border-radius: 4px;
        font-family: var(--font-mono);
        font-size: 0.58rem;
        cursor: pointer;
      }
      .workflow-run-chip:hover {
        color: var(--text);
        border-color: var(--accent);
      }
      .workflow-run-chip.status-running {
        color: #b9fbff;
        border-color: rgba(0, 196, 212, 0.6);
      }
      .workflow-run-chip.status-completed {
        color: #c9ffe4;
        border-color: rgba(57, 232, 160, 0.55);
      }
      .workflow-run-chip.status-blocked {
        color: #fff1b3;
        border-color: rgba(220, 180, 40, 0.6);
      }
      .workflow-run-chip.status-failed {
        color: #ffc7bf;
        border-color: rgba(224, 80, 64, 0.6);
      }
      .workflow-run-chip.active {
        color: var(--accent);
        border-color: var(--accent);
        box-shadow: 0 0 8px rgba(0, 196, 212, 0.18);
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
      }
      .plan-run-title strong {
        overflow: hidden;
        color: var(--text);
        font-size: 0.78rem;
        text-overflow: ellipsis;
        white-space: nowrap;
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

  override connectedCallback() {
    super.connectedCallback()
    window.addEventListener(WORKFLOW_RUN_UPDATED_EVENT, this._onWorkflowRunUpdated)
  }

  override disconnectedCallback() {
    window.removeEventListener(WORKFLOW_RUN_UPDATED_EVENT, this._onWorkflowRunUpdated)
    super.disconnectedCallback()
  }

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
          this._currentGraph = graphValue
          this._workflowId = graphValue.workflow?.id ?? graphValue.workflowId ?? null
          this._runId = graphValue.run?.runId ?? graphValue.runId ?? null
          this._selectedTaskId = this._currentGraph.nodes[0]?.id ?? null
          this._lastUpdatedAt = new Date().toISOString()
        } else {
          this.openList()
        }
      }
    }
  }

  async openList() {
    this._view = 'loading'
    this._workflowId = null
    this._runId = null
    this._currentGraph = null
    const ns = store.namespace<WorkflowsState>('workflows')
    ns.set('workspaceView', 'list')
    ns.set('workspaceWorkflowId', null)
    ns.set('workspaceRunId', null)
    try {
      const [workflows, runs] = await Promise.all([
        this._fetchJson('workflows'),
        this._fetchJson('workflow-runs'),
      ])
      this._workflows = Array.isArray(workflows) ? workflows : []
      this._runs = Array.isArray(runs) ? runs : []
      this._view = 'list'
    } catch {
      this._errorMsg = 'could not load workflows'
      this._view = 'error'
    }
  }

  async openGraph(workflowId: string, runId?: string) {
    this._view = 'loading'
    this._workflowId = workflowId
    this._runId = runId ?? null
    const ns = store.namespace<WorkflowsState>('workflows')
    ns.set('workspaceView', 'graph')
    ns.set('workspaceWorkflowId', workflowId)
    ns.set('workspaceRunId', runId ?? null)
    const runsPromise = this._refreshRuns().catch(() => {})
    try {
      await this._loadGraph(workflowId, runId, false)
      this._view = 'graph'
    } catch {
      this._errorMsg = 'could not load workflow graph'
      this._view = 'error'
    }
    await runsPromise
  }

  private async _refreshRuns() {
    const runs = await this._fetchJson('workflow-runs')
    this._runs = Array.isArray(runs) ? runs : []
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
              ${this._renderToolbarRuns()}
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

  private _renderToolbarRuns() {
    if (!this._workflowId) return nothing
    const runs = this._runs
      .filter(run => run.workflowId === this._workflowId)
      .slice(0, 8)
    if (!runs.length) return nothing
    return html`
      <div class="plan-workspace-runs">
        ${runs.map(run => html`
          <button
            class=${`workflow-run-chip status-${run.status}${run.runId === this._runId ? ' active' : ''}`}
            type="button"
            @click=${() => this.openGraph(this._workflowId!, run.runId)}
          >
            <span>${run.status}</span>
            <span>${this._shortRunId(run.runId)}</span>
          </button>
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
    if (!this._currentGraph || !this._currentGraph.nodes.length) {
      return html`<div class="plan-empty"><span>workflow has no tasks</span></div>`
    }
    return html`
      <div class="plan-run-header">
        <div class="plan-run-title">
          <r-badge status=${this._currentGraph.run?.status ?? 'not-tracked'}>${this._currentGraph.run?.status ?? 'not tracked'}</r-badge>
          <strong>${this._currentGraph.workflow?.goal ?? 'Workflow'}</strong>
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

  private async _loadGraph(workflowId: string, runId?: string, preserveSelection = true) {
    const path = runId
      ? `workflows/${encodeURIComponent(workflowId)}/graph?runId=${encodeURIComponent(runId)}`
      : `workflows/${encodeURIComponent(workflowId)}/graph`
    const graph = await this._fetchJson(path)
    this._currentGraph = graph
    this._workflowId = workflowId
    this._runId = graph.run?.runId ?? runId ?? null
    const savedTaskId = store.namespace<WorkflowsState>('workflows').get('workspaceSelectedTaskId')
    const candidate = preserveSelection ? this._selectedTaskId : savedTaskId
    this._selectedTaskId = candidate && graph.nodes.some((n: any) => n.id === candidate)
      ? candidate
      : (graph.nodes[0]?.id ?? null)
    this._lastUpdatedAt = new Date().toISOString()
  }

  private _applyWorkflowRunUpdate(frame: any) {
    const workflowId = frame?.workflowId
    const runId = frame?.runId
    const run = frame?.run
    if (!workflowId || !runId || !run) return

    if (this._view === 'graph' && this._workflowId === workflowId && this._runId === runId && this._currentGraph) {
      const selectedTaskId = this._selectedTaskId
      this._currentGraph = mergeWorkflowRunIntoGraph(this._currentGraph, run)
      this._selectedTaskId = selectedTaskId && this._currentGraph.nodes.some((node: any) => node.id === selectedTaskId)
        ? selectedTaskId
        : (this._currentGraph.nodes[0]?.id ?? null)
      this._lastUpdatedAt = new Date().toISOString()
    }

    const isGraphForWorkflow = this._view === 'graph' && this._workflowId === workflowId
    const isListForWorkflow = this._view === 'list' && this._workflows.some(workflow => workflow.id === workflowId)
    if (isGraphForWorkflow || isListForWorkflow) {
      const existingIndex = this._runs.findIndex(existing => existing.runId === runId)
      this._runs = existingIndex >= 0
        ? this._runs.map((existing, index) => index === existingIndex ? run : existing)
        : [run, ...this._runs]
    }
  }

  private async _fetchJson(path: string) {
    const res = await fetch(new URL(path, location.href))
    if (!res.ok) throw new Error(await res.text())
    return await res.json()
  }

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
