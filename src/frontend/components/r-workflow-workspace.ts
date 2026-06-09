import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { StoreController } from '../store.js';

@customElement('r-workflow-workspace')
export class RWorkflowWorkspace extends RorschachBase {
  @state() private _view: 'list' | 'graph' | 'loading' | 'error' = 'list';
  @state() private _errorMsg = '';
  @state() private _workflows: any[] = [];
  @state() private _currentGraph: any = null;
  @state() private _selectedTaskId: string | null = null;
  @state() private _runId: string | null = null;

  private _lastMode = '';
  private _lastWorkflowGraph: any = null;

  private _currentMode = new StoreController(this, 'currentMode');
  private _currentWorkflowGraph = new StoreController(this, 'currentWorkflowGraph');

  override createRenderRoot() {
    return this;
  }

  override updated() {
    const mode = this._currentMode.value as string;
    if (mode !== this._lastMode) {
      const isInitialLoad = this._lastMode === '';
      this._lastMode = mode;
      if (mode === 'workflows') {
        if (isInitialLoad) {
          const savedView = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.workflowWorkspaceView') || 'list' : 'list';
          const savedWorkflowId = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.workflowWorkspaceWorkflowId') : null;
          const savedRunId = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.workflowWorkspaceRunId') : null;
          if (savedView === 'graph' && savedWorkflowId) this.openGraph(savedWorkflowId, savedRunId || undefined);
          else this.openList();
        } else {
          this.openList();
        }
      }
    }

    const workflowGraph = this._currentWorkflowGraph.value as any;
    if (workflowGraph !== this._lastWorkflowGraph) {
      this._lastWorkflowGraph = workflowGraph;
      if (workflowGraph) {
        if (workflowGraph.workflowId) {
          this.openGraph(workflowGraph.workflowId, workflowGraph.runId);
        } else if (workflowGraph.nodes && workflowGraph.nodes.length) {
          this._view = 'graph';
          this._currentGraph = workflowGraph;
          this._runId = workflowGraph.run?.runId ?? null;
          this._selectedTaskId = this._currentGraph.nodes[0]?.id ?? null;
        } else {
          this.openList();
        }
      }
    }
  }

  async openList() {
    this._view = 'loading';
    this._runId = null;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('rorschach.workflowWorkspaceView', 'list');
      localStorage.removeItem('rorschach.workflowWorkspaceWorkflowId');
      localStorage.removeItem('rorschach.workflowWorkspaceRunId');
    }
    try {
      this._workflows = await this._fetchJson('workflows');
      this._view = 'list';
    } catch {
      this._errorMsg = 'could not load workflows';
      this._view = 'error';
    }
  }

  async openGraph(workflowId: string, runId?: string) {
    this._view = 'loading';
    this._runId = runId ?? null;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('rorschach.workflowWorkspaceView', 'graph');
      localStorage.setItem('rorschach.workflowWorkspaceWorkflowId', workflowId);
      if (runId) localStorage.setItem('rorschach.workflowWorkspaceRunId', runId);
      else localStorage.removeItem('rorschach.workflowWorkspaceRunId');
    }
    try {
      const path = runId
        ? `workflows/${encodeURIComponent(workflowId)}/graph?runId=${encodeURIComponent(runId)}`
        : `workflows/${encodeURIComponent(workflowId)}/graph`;
      this._currentGraph = await this._fetchJson(path);
      const savedTaskId = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.workflowWorkspaceSelectedTaskId') : null;
      this._selectedTaskId = savedTaskId && this._currentGraph.nodes.some((n: any) => n.id === savedTaskId)
        ? savedTaskId
        : (this._currentGraph.nodes[0]?.id ?? null);
      this._view = 'graph';
    } catch {
      this._errorMsg = 'could not load workflow graph';
      this._view = 'error';
    }
  }

  override render() {
    const showBack = this._view === 'graph';
    return html`
      <div class="plan-workspace-content-root">
        ${showBack ? html`
          <div class="plan-workspace-toolbar">
            <button class="plan-workspace-back-btn" @click=${() => this.openList()}>
              ${this.renderIcon('chevron-left')}
              <span>Back to Workflows</span>
            </button>
            <span class="plan-workspace-meta-text">
              ${this._currentGraph?.workflow ? html`${this._formatDate(this._currentGraph.workflow.createdAt)} · ${this._currentGraph.workflow.taskCount} tasks${this._runId ? html` · ${this._currentGraph.run?.status ?? 'running'}` : ''}` : ''}
            </span>
          </div>
        ` : ''}
        <div class="plan-workspace-body-container">
          ${this._renderContent()}
        </div>
      </div>
    `;
  }

  private _renderContent() {
    switch (this._view) {
      case 'loading':
        return html`<div class="plan-empty"><span>loading...</span></div>`;
      case 'error':
        return html`<div class="plan-empty"><span>${this._errorMsg}</span></div>`;
      case 'list':
        return this._renderWorkflowList();
      case 'graph':
        return this._renderGraphView();
      default:
        return nothing;
    }
  }

  private _renderWorkflowList() {
    if (!this._workflows.length) return html`<div class="plan-empty"><span>no saved workflows</span></div>`;
    return html`
      <div class="plan-list">
        ${this._workflows.map(workflow => html`
          <button class="plan-list-item" type="button" @click=${() => this.openGraph(workflow.id)}>
            <span class="plan-list-goal">${workflow.goal}</span>
            <span class="plan-list-meta">${this._formatDate(workflow.createdAt)} · ${workflow.taskCount} task${workflow.taskCount === 1 ? '' : 's'}</span>
          </button>
        `)}
      </div>
    `;
  }

  private _renderGraphView() {
    if (!this._currentGraph || !this._currentGraph.nodes.length) {
      return html`<div class="plan-empty"><span>workflow has no tasks</span></div>`;
    }
    return html`
      <div class="plan-graph-shell">
        <r-force-graph
          class="plan-graph"
          .planData=${this._currentGraph}
          .selectedTaskId=${this._selectedTaskId}
          @node-select=${(e: CustomEvent) => {
            this._selectedTaskId = e.detail.id;
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem('rorschach.workflowWorkspaceSelectedTaskId', e.detail.id);
            }
          }}
        ></r-force-graph>
        <div class="plan-task-detail-wrap">
          ${this._renderTaskDetail(this._taskById(this._selectedTaskId!))}
        </div>
      </div>
    `;
  }

  private _taskById(id: string) {
    return this._currentGraph?.nodes.find((node: any) => node.id === id) ?? null;
  }

  private _renderTaskDetail(task: any) {
    if (!task) return html`<div class="plan-task-placeholder">Select a task to inspect details.</div>`;
    const deps = task.dependencies.length
      ? task.dependencies.map((id: string) => this._taskById(id)?.label || id).join(', ')
      : 'none';
    const dependents = task.dependents.length
      ? task.dependents.map((id: string) => this._taskById(id)?.label || id).join(', ')
      : 'none';
    return html`
      <div class="plan-task-detail">
        <div class="plan-task-status">status · ${task.status ?? 'not_tracked'}</div>
        <h3>${task.label}</h3>
        <dl>
          <dt>Description</dt>
          <dd>${task.description || 'No description'}</dd>
          <dt>Validation</dt>
          <dd>${task.validationCriteria || 'No validation criteria'}</dd>
          <dt>Depends on</dt>
          <dd>${deps}</dd>
          <dt>Unlocks</dt>
          <dd>${dependents}</dd>
          ${task.summary ? html`<dt>Summary</dt><dd>${task.summary}</dd>` : ''}
          ${task.error ? html`<dt>Error</dt><dd>${task.error}</dd>` : ''}
        </dl>
      </div>
    `;
  }

  private async _fetchJson(path: string) {
    const res = await fetch(new URL(path, location.href));
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }

  private _formatDate(value: any) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
  }
}
