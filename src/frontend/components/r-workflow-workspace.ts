import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { RorschachBase } from './base.js';
import { StoreController } from '../store.js';
import { WORKFLOW_RUN_UPDATED_EVENT } from '../connection.js';

type InspectorTab = 'task' | 'workflow' | 'run' | 'events';

const DEFAULT_INSPECTOR_HEIGHT_PERCENT = 34;
const MIN_INSPECTOR_HEIGHT_PERCENT = 18;
const MAX_INSPECTOR_HEIGHT_PERCENT = 72;
const INSPECTOR_HEIGHT_STORAGE_KEY = 'rorschach.workflowWorkspaceInspectorHeightPercent';

export const clampWorkflowInspectorHeightPercent = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_INSPECTOR_HEIGHT_PERCENT;
  return Math.max(MIN_INSPECTOR_HEIGHT_PERCENT, Math.min(MAX_INSPECTOR_HEIGHT_PERCENT, numeric));
};

export const isLiveWorkflowRunStatus = (status: unknown): boolean =>
  status === 'running' || status === 'blocked';

export const mergeWorkflowRunIntoGraph = (graph: any, run: any) => {
  if (!graph || !run) return graph;
  return {
    ...graph,
    run: {
      runId: run.runId,
      status: run.status,
      inputs: run.inputs ?? {},
      activeTaskIds: run.activeTaskIds ?? [],
      activeTasks: run.activeTasks ?? {},
      pendingJobs: run.pendingJobs ?? {},
      outputs: run.outputs ?? {},
      events: run.events ?? [],
    },
    nodes: (graph.nodes ?? []).map((node: any) => {
      const taskState = run.taskStates?.[node.id];
      if (!taskState) return node;
      return {
        ...node,
        status: taskState.status,
        attempts: taskState.attempts,
        startedAt: taskState.startedAt,
        completedAt: taskState.completedAt,
        summary: taskState.summary,
        outputs: taskState.outputs,
        error: taskState.error,
        blockedReason: taskState.blockedReason,
      };
    }),
  };
};

@customElement('r-workflow-workspace')
export class RWorkflowWorkspace extends RorschachBase {
  @state() private _view: 'list' | 'graph' | 'loading' | 'error' = 'list';
  @state() private _errorMsg = '';
  @state() private _workflows: any[] = [];
  @state() private _runs: any[] = [];
  @state() private _currentGraph: any = null;
  @state() private _selectedTaskId: string | null = null;
  @state() private _workflowId: string | null = null;
  @state() private _runId: string | null = null;
  @state() private _inspectorTab: InspectorTab = 'task';
  @state() private _lastUpdatedAt: string | null = null;
  @state() private _inspectorHeightPercent = this._readInspectorHeightPercent();

  private _lastMode = '';
  private _lastWorkflowGraph: any = null;
  private _onWorkflowRunUpdated = (event: Event) => {
    this._applyWorkflowRunUpdate((event as CustomEvent).detail);
  };

  private _currentMode = new StoreController(this, 'currentMode');
  private _currentWorkflowGraph = new StoreController(this, 'currentWorkflowGraph');

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener(WORKFLOW_RUN_UPDATED_EVENT, this._onWorkflowRunUpdated);
  }

  override disconnectedCallback() {
    window.removeEventListener(WORKFLOW_RUN_UPDATED_EVENT, this._onWorkflowRunUpdated);
    super.disconnectedCallback();
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
          this._workflowId = workflowGraph.workflow?.id ?? workflowGraph.workflowId ?? null;
          this._runId = workflowGraph.run?.runId ?? workflowGraph.runId ?? null;
          this._selectedTaskId = this._currentGraph.nodes[0]?.id ?? null;
          this._lastUpdatedAt = new Date().toISOString();
        } else {
          this.openList();
        }
      }
    }
  }

  async openList() {
    this._view = 'loading';
    this._workflowId = null;
    this._runId = null;
    this._currentGraph = null;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('rorschach.workflowWorkspaceView', 'list');
      localStorage.removeItem('rorschach.workflowWorkspaceWorkflowId');
      localStorage.removeItem('rorschach.workflowWorkspaceRunId');
    }
    try {
      const [workflows, runs] = await Promise.all([
        this._fetchJson('workflows'),
        this._fetchJson('workflow-runs'),
      ]);
      this._workflows = Array.isArray(workflows) ? workflows : [];
      this._runs = Array.isArray(runs) ? runs : [];
      this._view = 'list';
    } catch {
      this._errorMsg = 'could not load workflows';
      this._view = 'error';
    }
  }

  async openGraph(workflowId: string, runId?: string) {
    this._view = 'loading';
    this._workflowId = workflowId;
    this._runId = runId ?? null;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('rorschach.workflowWorkspaceView', 'graph');
      localStorage.setItem('rorschach.workflowWorkspaceWorkflowId', workflowId);
      if (runId) localStorage.setItem('rorschach.workflowWorkspaceRunId', runId);
      else localStorage.removeItem('rorschach.workflowWorkspaceRunId');
    }
    try {
      await this._loadGraph(workflowId, runId, false);
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
              ${this._renderToolbarMeta()}
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
        ${this._workflows.map(workflow => {
          const runs = this._runs
            .filter(run => run.workflowId === workflow.id)
            .slice(0, 4);
          return html`
            <div class="plan-list-item">
              <button class="plan-list-main-btn" type="button" @click=${() => this.openGraph(workflow.id)}>
                <span class="plan-list-goal">${workflow.goal}</span>
                <span class="plan-list-meta">${this._formatDateTime(workflow.createdAt)} · ${workflow.taskCount} task${workflow.taskCount === 1 ? '' : 's'}</span>
              </button>
              ${runs.length ? html`
                <div class="workflow-run-list">
                  ${runs.map(run => html`
                    <button class="workflow-run-chip status-${run.status}" type="button" @click=${() => this.openGraph(workflow.id, run.runId)}>
                      <span>${run.status}</span>
                      <span>${this._shortRunId(run.runId)}</span>
                    </button>
                  `)}
                </div>
              ` : ''}
            </div>
          `;
        })}
      </div>
    `;
  }

  private _renderGraphView() {
    if (!this._currentGraph || !this._currentGraph.nodes.length) {
      return html`<div class="plan-empty"><span>workflow has no tasks</span></div>`;
    }
    const graphShellStyle = `grid-template-rows: minmax(180px, 1fr) 9px minmax(120px, ${this._inspectorHeightPercent}%);`;
    return html`
      <div class="plan-run-header">
        <div class="plan-run-title">
          <span class="workflow-status-badge status-${this._currentGraph.run?.status ?? 'not-tracked'}">${this._currentGraph.run?.status ?? 'not tracked'}</span>
          <strong>${this._currentGraph.workflow?.goal ?? 'Workflow'}</strong>
        </div>
        <div class="plan-run-refresh">
          ${this._runId ? html`<span>${isLiveWorkflowRunStatus(this._currentGraph.run?.status) ? 'live' : 'snapshot'}</span>` : html`<span>definition</span>`}
          ${this._lastUpdatedAt ? html`<span>${this._formatTime(this._lastUpdatedAt)}</span>` : nothing}
        </div>
      </div>
      <div class="plan-graph-shell" style=${graphShellStyle}>
        <r-force-graph
          class="plan-graph"
          .planData=${this._currentGraph}
          .selectedTaskId=${this._selectedTaskId}
          @node-select=${(e: CustomEvent) => {
            this._selectedTaskId = e.detail.id;
            this._inspectorTab = 'task';
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem('rorschach.workflowWorkspaceSelectedTaskId', e.detail.id);
            }
          }}
        ></r-force-graph>
        <div
          class="workflow-inspector-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize workflow inspector"
          aria-valuemin=${MIN_INSPECTOR_HEIGHT_PERCENT}
          aria-valuemax=${MAX_INSPECTOR_HEIGHT_PERCENT}
          aria-valuenow=${Math.round(this._inspectorHeightPercent)}
          @pointerdown=${this._handleInspectorResizeStart}
        ></div>
        <div class="plan-task-detail-wrap">
          ${this._renderInspector()}
        </div>
      </div>
    `;
  }

  private _handleInspectorResizeStart(e: PointerEvent) {
    if (e.button !== 0) return;
    const shell = this.querySelector('.plan-graph-shell') as HTMLElement | null;
    if (!shell) return;

    e.preventDefault();
    const resizer = e.currentTarget as HTMLElement;
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('workflow-inspector-resizing');

    const updateFromPointer = (clientY: number) => {
      const rect = shell.getBoundingClientRect();
      if (rect.height <= 0) return;
      const next = ((rect.bottom - clientY) / rect.height) * 100;
      this._inspectorHeightPercent = clampWorkflowInspectorHeightPercent(next);
    };

    const onPointerMove = (moveEv: PointerEvent) => {
      updateFromPointer(moveEv.clientY);
    };

    const onPointerUp = () => {
      if (resizer.hasPointerCapture(e.pointerId)) {
        resizer.releasePointerCapture(e.pointerId);
      }
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      document.body.classList.remove('workflow-inspector-resizing');
      this._persistInspectorHeightPercent();
    };

    updateFromPointer(e.clientY);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  private _renderInspector() {
    return html`
      <div class="workflow-inspector-tabs">
        ${(['task', 'workflow', 'run', 'events'] as InspectorTab[]).map(tab => html`
          <button
            class=${this._inspectorTab === tab ? 'active' : ''}
            type="button"
            @click=${() => { this._inspectorTab = tab; }}
          >${tab}</button>
        `)}
      </div>
      ${this._inspectorTab === 'task' ? this._renderTaskDetail(this._taskById(this._selectedTaskId!)) : nothing}
      ${this._inspectorTab === 'workflow' ? this._renderWorkflowDetail() : nothing}
      ${this._inspectorTab === 'run' ? this._renderRunDetail() : nothing}
      ${this._inspectorTab === 'events' ? this._renderEvents() : nothing}
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
          ${task.attempts !== undefined ? html`<dt>Attempts</dt><dd>${task.attempts}</dd>` : nothing}
          ${task.startedAt ? html`<dt>Started</dt><dd>${this._formatDateTime(task.startedAt)}</dd>` : nothing}
          ${task.completedAt ? html`<dt>Completed</dt><dd>${this._formatDateTime(task.completedAt)}</dd>` : nothing}
          ${task.startedAt && task.completedAt ? html`<dt>Duration</dt><dd>${this._formatDuration(task.startedAt, task.completedAt)}</dd>` : nothing}
          ${task.summary ? html`<dt>Summary</dt><dd>${task.summary}</dd>` : nothing}
          ${task.outputs ? html`<dt>Outputs</dt><dd>${this._renderValueMap(task.outputs)}</dd>` : nothing}
          ${task.error ? html`<dt>Error</dt><dd>${task.error}</dd>` : nothing}
          ${task.blockedReason ? html`<dt>Blocked reason</dt><dd>${this._renderJson(task.blockedReason)}</dd>` : nothing}
        </dl>
      </div>
    `;
  }

  private _renderWorkflowDetail() {
    const workflow = this._currentGraph?.workflow;
    if (!workflow) return html`<div class="plan-task-placeholder">No workflow details available.</div>`;
    return html`
      <div class="plan-task-detail">
        <div class="plan-task-status">workflow</div>
        <h3>${workflow.goal}</h3>
        <dl>
          <dt>Context</dt>
          <dd>${workflow.context || 'No context'}</dd>
          <dt>Created</dt>
          <dd>${this._formatDateTime(workflow.createdAt)}</dd>
          <dt>Execution tools</dt>
          <dd>${workflow.executionTools?.length ? workflow.executionTools.join(', ') : 'none'}</dd>
          <dt>Declared inputs</dt>
          <dd>${this._renderSpecs(workflow.inputs)}</dd>
          <dt>Declared outputs</dt>
          <dd>${this._renderSpecs(workflow.outputs)}</dd>
        </dl>
      </div>
    `;
  }

  private _renderRunDetail() {
    const run = this._currentGraph?.run;
    if (!run) return html`<div class="plan-task-placeholder">No run selected.</div>`;
    return html`
      <div class="plan-task-detail">
        <div class="plan-task-status">run · ${run.status}</div>
        <h3>${run.runId}</h3>
        <dl>
          <dt>Inputs</dt>
          <dd>${this._renderValueMap(run.inputs ?? {})}</dd>
          <dt>Outputs</dt>
          <dd>${this._renderValueMap(run.outputs ?? {})}</dd>
          <dt>Active tasks</dt>
          <dd>${run.activeTaskIds?.length ? run.activeTaskIds.map((id: string) => this._taskById(id)?.label || id).join(', ') : 'none'}</dd>
          <dt>Pending jobs</dt>
          <dd>${this._renderPendingJobs(run.pendingJobs ?? {})}</dd>
        </dl>
      </div>
    `;
  }

  private _renderEvents() {
    const events = this._currentGraph?.run?.events ?? [];
    if (!events.length) return html`<div class="plan-task-placeholder">No run events available.</div>`;
    return html`
      <div class="workflow-event-list">
        ${events.map((event: any) => html`
          <div class="workflow-event-row">
            <span class="workflow-event-time">${this._formatTime(event.timestamp)}</span>
            <span class="workflow-event-type">${event.type}</span>
            <span class="workflow-event-message">
              ${event.taskId ? html`<strong>${this._taskById(event.taskId)?.label || event.taskId}</strong> ` : nothing}
              ${event.message}
            </span>
          </div>
        `)}
      </div>
    `;
  }

  private _renderSpecs(specs: Record<string, any> | undefined) {
    const entries = Object.entries(specs ?? {});
    if (!entries.length) return html`<span class="workflow-muted">none</span>`;
    return html`
      <div class="workflow-kv-list">
        ${entries.map(([key, spec]) => html`
          <div class="workflow-kv-row">
            <span class="workflow-kv-key">${key}</span>
            <span class="workflow-kv-value">
              ${spec?.type ?? 'unknown'}${spec?.required === false ? ' optional' : ' required'}${spec?.description ? html` · ${spec.description}` : nothing}
            </span>
          </div>
        `)}
      </div>
    `;
  }

  private _renderPendingJobs(jobs: Record<string, any>) {
    const entries = Object.entries(jobs);
    if (!entries.length) return html`<span class="workflow-muted">none</span>`;
    return html`
      <div class="workflow-kv-list">
        ${entries.map(([jobId, job]) => html`
          <div class="workflow-kv-row">
            <span class="workflow-kv-key">${this._shortRunId(jobId)}</span>
            <span class="workflow-kv-value">
              ${job.toolName ?? 'tool'} for ${this._taskById(job.taskId)?.label || job.taskId || 'task'}${job.startedAt ? html` · ${this._formatDateTime(job.startedAt)}` : nothing}
            </span>
          </div>
        `)}
      </div>
    `;
  }

  private _renderValueMap(values: Record<string, unknown>) {
    const entries = Object.entries(values);
    if (!entries.length) return html`<span class="workflow-muted">none</span>`;
    return html`
      <div class="workflow-output-list">
        ${entries.map(([key, value]) => html`
          <div class="workflow-output-row">
            <div class="workflow-output-key">${key}</div>
            <div class="workflow-output-value">${this._renderValue(value)}</div>
          </div>
        `)}
      </div>
    `;
  }

  private _renderValue(value: unknown) {
    if (this._isArtifactRef(value)) {
      const href = this._artifactHref(value);
      if (!href) return this._renderJson(value);
      return html`
        <a class="workflow-artifact-link" href=${href} target="_blank" rel="noopener noreferrer">
          ${this.renderIcon('file-text')}
          <span>${value.path ?? value.url}</span>
        </a>
      `;
    }
    if (typeof value === 'string') return html`<pre>${value}</pre>`;
    return this._renderJson(value);
  }

  private _renderJson(value: unknown) {
    return html`<pre>${JSON.stringify(value, null, 2)}</pre>`;
  }

  private _renderToolbarMeta() {
    const workflow = this._currentGraph?.workflow;
    if (!workflow) return nothing;
    return html`${this._formatDateTime(workflow.createdAt)} · ${workflow.taskCount} tasks${this._runId ? html` · ${this._currentGraph.run?.status ?? 'running'} · ${this._shortRunId(this._runId)}` : ''}`;
  }

  private async _loadGraph(workflowId: string, runId?: string, preserveSelection = true) {
    const path = runId
      ? `workflows/${encodeURIComponent(workflowId)}/graph?runId=${encodeURIComponent(runId)}`
      : `workflows/${encodeURIComponent(workflowId)}/graph`;
    const graph = await this._fetchJson(path);
    this._currentGraph = graph;
    this._workflowId = workflowId;
    this._runId = graph.run?.runId ?? runId ?? null;
    const savedTaskId = typeof localStorage !== 'undefined' ? localStorage.getItem('rorschach.workflowWorkspaceSelectedTaskId') : null;
    const candidate = preserveSelection ? this._selectedTaskId : savedTaskId;
    this._selectedTaskId = candidate && graph.nodes.some((n: any) => n.id === candidate)
      ? candidate
      : (graph.nodes[0]?.id ?? null);
    this._lastUpdatedAt = new Date().toISOString();
  }

  private _applyWorkflowRunUpdate(frame: any) {
    const workflowId = frame?.workflowId;
    const runId = frame?.runId;
    const run = frame?.run;
    if (!workflowId || !runId || !run) return;

    if (this._view === 'graph' && this._workflowId === workflowId && this._runId === runId && this._currentGraph) {
      const selectedTaskId = this._selectedTaskId;
      this._currentGraph = mergeWorkflowRunIntoGraph(this._currentGraph, run);
      this._selectedTaskId = selectedTaskId && this._currentGraph.nodes.some((node: any) => node.id === selectedTaskId)
        ? selectedTaskId
        : (this._currentGraph.nodes[0]?.id ?? null);
      this._lastUpdatedAt = new Date().toISOString();
      return;
    }

    if (this._view === 'list' && this._workflows.some(workflow => workflow.id === workflowId)) {
      const existingIndex = this._runs.findIndex(existing => existing.runId === runId);
      this._runs = existingIndex >= 0
        ? this._runs.map((existing, index) => index === existingIndex ? run : existing)
        : [run, ...this._runs];
    }
  }

  private async _fetchJson(path: string) {
    const res = await fetch(new URL(path, location.href));
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }

  private _readInspectorHeightPercent() {
    if (typeof localStorage === 'undefined') return DEFAULT_INSPECTOR_HEIGHT_PERCENT;
    return clampWorkflowInspectorHeightPercent(localStorage.getItem(INSPECTOR_HEIGHT_STORAGE_KEY));
  }

  private _persistInspectorHeightPercent() {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(INSPECTOR_HEIGHT_STORAGE_KEY, String(Math.round(this._inspectorHeightPercent)));
  }

  private _isArtifactRef(value: unknown): value is { type: 'artifact'; path?: string; url?: string; mimeType?: string } {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      (value as any).type === 'artifact' &&
      (typeof (value as any).path === 'string' || typeof (value as any).url === 'string');
  }

  private _artifactHref(value: { path?: string; url?: string }) {
    if (value.url) return value.url;
    if (value.path && this._runId) return `workflow-runs/${encodeURIComponent(this._runId)}/artifact?path=${encodeURIComponent(value.path)}`;
    return null;
  }

  private _formatDateTime(value: any) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  private _formatTime(value: any) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
  }

  private _formatDuration(start: string, end: string) {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 'unknown';
    const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${minutes}m ${rest}s`;
  }

  private _shortRunId(value: string) {
    return value.length > 8 ? value.slice(0, 8) : value;
  }
}
