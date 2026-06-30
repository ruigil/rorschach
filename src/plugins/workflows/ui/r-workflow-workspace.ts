import { html, nothing } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import { RorschachBase } from '@rorschach/frontend/webkit/base.js'
import { StoreController } from '@rorschach/frontend/webkit/store-controller.js'
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


const DEFAULT_INSPECTOR_HEIGHT_PERCENT = 34
const MIN_INSPECTOR_HEIGHT_PERCENT = 18
const MAX_INSPECTOR_HEIGHT_PERCENT = 72
const INSPECTOR_HEIGHT_STORAGE_KEY = 'rorschach.workflowWorkspaceInspectorHeightPercent'

export const clampWorkflowInspectorHeightPercent = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_INSPECTOR_HEIGHT_PERCENT
  return Math.max(MIN_INSPECTOR_HEIGHT_PERCENT, Math.min(MAX_INSPECTOR_HEIGHT_PERCENT, numeric))
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
  @state() private _inspectorHeightPercent = this._readInspectorHeightPercent()
  @state() private _inspectorTab: InspectorTab = 'task'

  private _lastMode = ''
  private _lastGraphValue: any = null
  private _onWorkflowRunUpdated = (event: Event) => {
    this._applyWorkflowRunUpdate((event as CustomEvent).detail)
  }

  private _currentMode = new StoreController<ShellState, 'currentMode'>(this, ['shell', 'currentMode'])
  private _storeGraph = new StoreController<WorkflowsState, 'currentGraph'>(this, ['workflows', 'currentGraph'])

  override createRenderRoot() { return this }

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
          const savedView = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.workflowWorkspaceView') || 'list' : 'list'
          const savedWorkflowId = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.workflowWorkspaceWorkflowId') : null
          const savedRunId = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.workflowWorkspaceRunId') : null
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
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('rorschach.workflowWorkspaceView', 'list')
      localStorage.removeItem('rorschach.workflowWorkspaceWorkflowId')
      localStorage.removeItem('rorschach.workflowWorkspaceRunId')
    }
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
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('rorschach.workflowWorkspaceView', 'graph')
      localStorage.setItem('rorschach.workflowWorkspaceWorkflowId', workflowId)
      if (runId) localStorage.setItem('rorschach.workflowWorkspaceRunId', runId)
      else localStorage.removeItem('rorschach.workflowWorkspaceRunId')
    }
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
        orientation="horizontal"
        style="flex: 1; min-height: 0;"
        .splitPercent=${this._inspectorHeightPercent}
        .minPercent=${MIN_INSPECTOR_HEIGHT_PERCENT}
        .maxPercent=${MAX_INSPECTOR_HEIGHT_PERCENT}
        @resize-end=${(e: CustomEvent) => {
          this._inspectorHeightPercent = e.detail.splitPercent
          this._persistInspectorHeightPercent()
        }}
      >
        <r-force-graph
          slot="primary"
          class="plan-graph"
          .planData=${this._currentGraph}
          .selectedTaskId=${this._selectedTaskId}
          @node-select=${(e: CustomEvent) => this._selectTask(e.detail.id)}
        ></r-force-graph>
        <div slot="secondary" class="plan-task-detail-wrap" style="height: 100%; overflow: hidden;">
          <r-workflow-inspector
            style="height: 100%; display: flex; flex-direction: column;"
            .graph=${this._currentGraph}
            .selectedTaskId=${this._selectedTaskId}
            .tab=${this._inspectorTab}
            @task-select=${(e: CustomEvent) => { this._selectedTaskId = e.detail.id }}
            @tab-change=${(e: CustomEvent) => { this._inspectorTab = e.detail.tab }}
          ></r-workflow-inspector>
        </div>
      </r-split-pane>
    `
  }

  private _selectTask(taskId: string) {
    this._selectedTaskId = taskId
    this._inspectorTab = 'task'
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('rorschach.workflowWorkspaceSelectedTaskId', taskId)
    }
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
    const savedTaskId = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.workflowWorkspaceSelectedTaskId') : null
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

  private _readInspectorHeightPercent(): number {
    if (typeof localStorage === 'undefined') return DEFAULT_INSPECTOR_HEIGHT_PERCENT
    return clampWorkflowInspectorHeightPercent(localStorage.getItem(INSPECTOR_HEIGHT_STORAGE_KEY))
  }

  private _persistInspectorHeightPercent(): void {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(INSPECTOR_HEIGHT_STORAGE_KEY, String(Math.round(this._inspectorHeightPercent)))
  }
}
