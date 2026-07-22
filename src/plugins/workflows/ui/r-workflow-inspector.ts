import {
  css,
  customElement,
  html,
  nothing,
  property,
  RorschachBase,
  sharedStyles,
  state,
  store,
  StoreController,
} from '@rorschach/webkit';

import type { WorkflowsState } from './index.js';

type InspectorTab = 'task' | 'workflow' | 'run' | 'events'

export const isLiveWorkflowRunStatus = (status: unknown): boolean =>
  status === 'running' || status === 'blocked'

export const mergeWorkflowRunIntoGraph = (graph: any, run: any) => {
  if (!graph || !run) return graph
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
      const taskState = run.taskStates?.[node.id]
      if (!taskState) return node
      return {
        ...node,
        status: taskState.status,
        attempts: taskState.attempts,
        startedAt: taskState.startedAt,
        completedAt: taskState.completedAt,
        summary: taskState.summary,
        outputs: taskState.outputs ?? node.outputs,
        error: taskState.error,
        blockedReason: taskState.blockedReason,
      }
    }),
  }
}

// Workflow inspector — renders horizontal collapse panels for workflow or run details & graph.

@customElement('r-workflow-inspector')
export class RWorkflowInspector extends RorschachBase {
  @property({ type: Object }) graph: any = null
  @property({ type: String }) selectedTaskId: string | null = null
  @property({ type: String }) tab: InspectorTab = 'task'
  @state() private _confirmDeleteId: string | null = null

  private _confirmTimer: ReturnType<typeof setTimeout> | null = null
  private _storePanelStates = new StoreController(this, ['workflows', 'panelStates'])

  override disconnectedCallback() {
    super.disconnectedCallback()
    if (this._confirmTimer) {
      clearTimeout(this._confirmTimer)
      this._confirmTimer = null
    }
  }

  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        height: 100%;
        width: 100%;
        overflow-y: auto;
        padding: 0.5rem 0.6rem;
        box-sizing: border-box;
      }
      .plan-task-detail {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }
      .plan-task-placeholder {
        color: var(--text-dim);
        font-size: 0.72rem;
        font-family: var(--font-mono);
      }
      .workflow-event-list {
        min-height: 160px;
        max-height: 400px;
        overflow-y: auto;
      }
      .panel-graph-container {
        position: relative;
        height: 380px;
        margin: -0.4rem -0.6rem;
        border: none;
        border-radius: 0;
        overflow: hidden;
        background-color: var(--surface-2, var(--surface));
        background-image: radial-gradient(var(--border-mid, rgba(255, 255, 255, 0.15)) 1px, transparent 1px);
        background-size: 16px 16px;
      }
      .task-selector-bar {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        margin-bottom: 0.4rem;
      }
      .task-chip {
        font-size: 0.68rem;
        padding: 0.15rem 0.5rem;
        border-radius: 4px;
        border: 1px solid var(--border);
        background: var(--surface);
        color: var(--text-dim);
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .task-chip.active {
        border-color: var(--accent);
        background: var(--accent-glow);
        color: var(--accent);
        font-weight: 600;
      }
      .inspector-info-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.8rem;
        padding: 0.5rem 0.75rem;
        margin-bottom: 0.55rem;
        background: var(--surface-2, rgba(255, 255, 255, 0.03));
        border: 1px solid var(--border);
        border-radius: var(--radius, 6px);
      }
      .info-bar-left {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        min-width: 0;
        flex: 1;
      }
      .info-bar-title {
        font-size: 1.05rem;
        font-weight: 700;
        font-family: var(--font-ui, sans-serif);
        color: var(--text-bright, var(--text));
        line-height: 1.3;
        letter-spacing: -0.01em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .info-bar-timing {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.75rem;
        font-family: var(--font-mono);
        font-size: 0.65rem;
        color: var(--text-dim);
      }
      .info-bar-right {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-shrink: 0;
      }
      .timing-item {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        color: var(--text-dim);
      }
      .timing-label {
        font-weight: 500;
        color: var(--text-dim);
      }
      .timing-value {
        color: var(--text);
        font-weight: 600;
      }
      .inspector-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 0.75rem;
        margin-top: 0.2rem;
      }
      .inspector-col {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }
      .task-output-panel {
        margin-top: 0.5rem;
      }
    `
  ];

  private _isPanelOpen(key: string, defaultOpen = false): boolean {
    const states = this._storePanelStates.value || {}
    return states[key] !== undefined ? states[key] : defaultOpen
  }

  private _onPanelToggle(key: string, e: CustomEvent) {
    if (e.target !== e.currentTarget) return
    const open = e.detail.open
    const ns = store.namespace<WorkflowsState>('workflows')
    const current = ns.get('panelStates') || {}
    ns.set('panelStates', { ...current, [key]: open })
  }

  private _requestDelete(targetId: string) {
    if (this._confirmTimer) {
      clearTimeout(this._confirmTimer)
      this._confirmTimer = null
    }
    this._confirmDeleteId = targetId
    this._confirmTimer = setTimeout(() => {
      if (this._confirmDeleteId === targetId) {
        this._confirmDeleteId = null
      }
    }, 3000)
  }

  private _cancelDelete() {
    if (this._confirmTimer) {
      clearTimeout(this._confirmTimer)
      this._confirmTimer = null
    }
    this._confirmDeleteId = null
  }

  private _onWorkflowDelete(workflowId: string) {
    const key = `wf-${workflowId}`
    if (this._confirmDeleteId !== key) {
      this._requestDelete(key)
      return
    }
    this._cancelDelete()
    this.dispatchEvent(new CustomEvent('workflow-delete', { detail: { workflowId }, bubbles: true, composed: true }))
  }

  private _onRunDelete(runId: string, workflowId?: string) {
    const key = `run-${runId}`
    if (this._confirmDeleteId !== key) {
      this._requestDelete(key)
      return
    }
    this._cancelDelete()
    this.dispatchEvent(new CustomEvent('run-delete', { detail: { runId, workflowId }, bubbles: true, composed: true }))
  }

  override render() {
    if (!this.graph) {
      return html`<div class="plan-task-placeholder">No workflow selected.</div>`
    }

    const isRunMode = !!this.graph.run

    if (isRunMode) {
      const selectedTask = this._taskById(this.selectedTaskId!)
      return html`
        <r-collapse-panel
          title="Workflow Run"
          icon="git-branch"
          .open=${this._isPanelOpen('run-info', false)}
          @toggle=${(e: CustomEvent) => this._onPanelToggle('run-info', e)}
        >
          ${this._renderRunDetail()}
        </r-collapse-panel>

        <r-collapse-panel
          title="Task Run"
          icon="check-square"
          .open=${this._isPanelOpen('task-run-state', false)}
          @toggle=${(e: CustomEvent) => this._onPanelToggle('task-run-state', e)}
        >
          ${this._renderTaskSelector()}
          ${this._renderTaskDetail(selectedTask)}
        </r-collapse-panel>

        <r-collapse-panel
          title="Graph"
          icon="share-2"
          .open=${this._isPanelOpen('graph', true)}
          @toggle=${(e: CustomEvent) => this._onPanelToggle('graph', e)}
        >
          ${this._renderGraphPanel()}
        </r-collapse-panel>

        <r-collapse-panel
          title="Run Events"
          icon="terminal"
          .open=${this._isPanelOpen('run-events', false)}
          @toggle=${(e: CustomEvent) => this._onPanelToggle('run-events', e)}
        >
          ${this._renderEvents()}
        </r-collapse-panel>
      `
    }

    return html`
      <r-collapse-panel
        title="Workflow"
        icon="git-branch"
        .open=${this._isPanelOpen('workflow-info', false)}
        @toggle=${(e: CustomEvent) => this._onPanelToggle('workflow-info', e)}
      >
        ${this._renderWorkflowDetail()}
      </r-collapse-panel>

      <r-collapse-panel
        title="Task"
        icon="check-square"
        .open=${this._isPanelOpen('task-info', false)}
        @toggle=${(e: CustomEvent) => this._onPanelToggle('task-info', e)}
      >
        ${this._renderTaskSelector()}
        ${this._renderTaskDetail(this._taskById(this.selectedTaskId!))}
      </r-collapse-panel>

      <r-collapse-panel
        title="Graph"
        icon="share-2"
        .open=${this._isPanelOpen('graph', true)}
        @toggle=${(e: CustomEvent) => this._onPanelToggle('graph', e)}
      >
        ${this._renderGraphPanel()}
      </r-collapse-panel>
    `
  }

  private _taskById(id: string) {
    return this.graph?.nodes?.find((node: any) => node.id === id) ?? null
  }

  private _selectTask(id: string) {
    this.selectedTaskId = id
    this.dispatchEvent(new CustomEvent('task-select', { detail: { id }, bubbles: true, composed: true }))
  }

  private _renderTaskSelector() {
    const nodes = this.graph?.nodes ?? []
    if (nodes.length <= 1) return nothing

    return html`
      <div class="task-selector-bar">
        <span style="font-size: 0.68rem; font-family: var(--font-ui); text-transform: uppercase; color: var(--text-dim); font-weight: 600;">Tasks:</span>
        ${nodes.map((n: any) => html`
          <button
            type="button"
            class="task-chip ${n.id === this.selectedTaskId ? 'active' : ''}"
            @click=${() => this._selectTask(n.id)}
          >
            ${n.label}
          </button>
        `)}
      </div>
    `
  }

  private _renderGraphPanel() {
    return html`
      <div class="panel-graph-container">
        <r-force-graph
          style="width: 100%; height: 100%; display: block;"
          .planData=${this.graph}
          .selectedTaskId=${this.selectedTaskId}
          @node-select=${(e: CustomEvent) => this._selectTask(e.detail.id)}
        ></r-force-graph>
      </div>
    `
  }

  private _kvItemsForOutputs(outputs: Record<string, unknown> | undefined) {
    if (!outputs) return [];
    return Object.entries(outputs).map(([k, v]) => {
      const isRef = this._isArtifactRef(v);
      return {
        key: k,
        value: v,
        type: isRef ? ('artifact' as const) : undefined,
        artifactHref: isRef ? this._artifactHref(v as any) : undefined,
        artifactPath: isRef ? (v as any).path : undefined,
      };
    });
  }

  private _renderIndividualOutputCollapses(ownerId: string, outputs: Record<string, unknown> | undefined) {
    if (!outputs || Object.keys(outputs).length === 0 || this._isSpecMap(outputs)) return nothing;
    const entries = Object.entries(outputs);

    return html`
      <div class="task-output-panel" style="margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.35rem;">
        <div style="font-size: 0.65rem; font-family: var(--font-mono); color: var(--text-dim); text-transform: uppercase; font-weight: 600; margin-bottom: 0.15rem;">
          Outputs (${entries.length})
        </div>
        ${entries.map(([k, v]) => {
          const isRef = this._isArtifactRef(v);
          const item = {
            key: k,
            value: v,
            type: isRef ? ('artifact' as const) : undefined,
            artifactHref: isRef ? (this._artifactHref(v as any) ?? undefined) : undefined,
            artifactPath: isRef ? ((v as any).path || (v as any).key || (v as any).url) : undefined,
          };
          const panelKey = `output-${ownerId}-${k}`;
          return html`
            <r-collapse-panel
              title="Output: ${k}"
              icon="file-text"
              .open=${this._isPanelOpen(panelKey, false)}
              @toggle=${(e: CustomEvent) => { e.stopPropagation(); this._onPanelToggle(panelKey, e); }}
            >
              <r-kv-list .items=${[item]}></r-kv-list>
            </r-collapse-panel>
          `;
        })}
      </div>
    `;
  }

  private _specItems(specs: Record<string, any> | undefined) {
    if (!specs) return [];
    return Object.entries(specs).map(([key, spec]) => {
      const typeStr = `${spec?.type ?? 'unknown'}${spec?.required === false ? ' optional' : ' required'}${spec?.description ? ` · ${spec.description}` : ''}`;
      return { key, value: typeStr };
    });
  }

  private _pendingJobItems(jobs: Record<string, any>) {
    return Object.entries(jobs).map(([jobId, job]) => {
      const desc = `${job.toolName ?? 'tool'} for ${this._taskById(job.taskId)?.label || job.taskId || 'task'}${job.startedAt ? ` · ${this._formatDateTime(job.startedAt)}` : ''}`;
      return { key: this._shortRunId(jobId), value: desc };
    });
  }

  private _renderWorkflowInfoBar(workflow: any) {
    const title = workflow.title || workflow.goal || workflow.id;
    const isConfirming = this._confirmDeleteId === `wf-${workflow.id}`;

    return html`
      <div class="inspector-info-bar">
        <div class="info-bar-left">
          <div class="info-bar-title">${title}</div>
          <div class="info-bar-timing">
            ${workflow.createdAt ? html`
              <div class="timing-item">
                <r-icon name="info" size="sm"></r-icon>
                <span class="timing-label">Created:</span>
                <span class="timing-value">${this._formatDateTime(workflow.createdAt)}</span>
              </div>
            ` : nothing}
          </div>
        </div>
        <div class="info-bar-right">
          ${isConfirming ? html`
            <r-button size="sm" variant="danger" icon="trash" @click=${() => this._onWorkflowDelete(workflow.id)}>Confirm Delete?</r-button>
            <r-button size="sm" variant="ghost" @click=${() => this._cancelDelete()}>Cancel</r-button>
          ` : html`
            <r-button size="sm" variant="danger" icon="trash" @click=${() => this._onWorkflowDelete(workflow.id)}>Delete</r-button>
          `}
        </div>
      </div>
    `;
  }

  private _renderTaskInfoBar(task: any) {
    if (!task) return nothing;
    const isRunMode = !!this.graph?.run;
    const hasStarted = !!task.startedAt;
    const hasCompleted = !!task.completedAt;

    return html`
      <div class="inspector-info-bar">
        <div class="info-bar-left">
          <div class="info-bar-title">${task.label}</div>
          <div class="info-bar-timing">
            ${hasStarted ? html`
              <div class="timing-item">
                <r-icon name="info" size="sm"></r-icon>
                <span class="timing-label">Started:</span>
                <span class="timing-value">${this._formatDateTime(task.startedAt)}</span>
              </div>
            ` : nothing}
            ${hasCompleted ? html`
              <div class="timing-item">
                <r-icon name="check" size="sm"></r-icon>
                <span class="timing-label">Completed:</span>
                <span class="timing-value">${this._formatDateTime(task.completedAt)}</span>
              </div>
            ` : nothing}
            ${hasStarted && hasCompleted ? html`
              <div class="timing-item">
                <r-icon name="info" size="sm"></r-icon>
                <span class="timing-label">Duration:</span>
                <span class="timing-value">${this._formatDuration(task.startedAt, task.completedAt)}</span>
              </div>
            ` : nothing}
          </div>
        </div>
        <div class="info-bar-right">
          ${isRunMode && task.status ? html`<r-badge status=${task.status}>${task.status}</r-badge>` : nothing}
        </div>
      </div>
    `;
  }

  private _isSpecMap(outputs: Record<string, any> | undefined): boolean {
    if (!outputs) return false
    const values = Object.values(outputs)
    if (values.length === 0) return false
    const first = values[0]
    if (!first || typeof first !== 'object') return false
    return ('type' in first) && !('key' in first) && !('path' in first) && !('url' in first) && (('required' in first) || ('description' in first) || ['string', 'number', 'boolean', 'object', 'array', 'artifact'].includes((first as any).type))
  }

  private _renderTaskDetail(task: any) {
    if (!task) return html`<div class="plan-task-placeholder">Select a task to inspect details.</div>`
    const isRunMode = !!this.graph?.run
    const deps = task.dependencies?.length
      ? task.dependencies.map((id: string) => this._taskById(id)?.label || id).join(', ')
      : 'none'
    const dependents = task.dependents?.length
      ? task.dependents.map((id: string) => this._taskById(id)?.label || id).join(', ')
      : 'none'

    const outputItems = this._isSpecMap(task.outputs)
      ? this._specItems(task.outputs)
      : this._kvItemsForOutputs(task.outputs)

    return html`
      <div class="plan-task-detail">
        ${this._renderTaskInfoBar(task)}
        <div class="inspector-grid">
          <div class="inspector-col">
            <r-kv-list .items=${[
              { key: 'agentMode', label: 'Agent mode', value: task.agentMode || 'tool-executor' },
              ...(task.executionTools?.length ? [{ key: 'tools', label: 'Execution tools', value: task.executionTools.join(', ') }] : []),
              { key: 'description', label: 'Description', value: task.description || 'No description' },
              { key: 'validation', label: 'Validation', value: task.validationCriteria || 'No validation criteria' },
              ...(task.attempts !== undefined ? [{ key: 'attempts', label: 'Attempts', value: task.attempts }] : []),
              ...(task.summary ? [{ key: 'summary', label: 'Summary', value: task.summary }] : []),
              ...(task.error ? [{ key: 'error', label: 'Error', value: task.error }] : []),
              ...(task.blockedReason ? [{ key: 'blockedReason', label: 'Blocked reason', value: JSON.stringify(task.blockedReason, null, 2) }] : []),
            ]}></r-kv-list>
          </div>
          <div class="inspector-col">
            <r-kv-list .items=${[
              { key: 'dependsOn', label: 'Depends on', value: deps },
              { key: 'unlocks', label: 'Unlocks', value: dependents },
              ...(!isRunMode ? [{ key: 'outputs', label: 'Task outputs', type: 'html' as const, value: html`<r-kv-list .items=${outputItems} emptyText="none"></r-kv-list>` }] : []),
            ]}></r-kv-list>
          </div>
        </div>
        ${isRunMode ? this._renderIndividualOutputCollapses(`task-${task.id}`, task.outputs) : nothing}
      </div>
    `
  }

  private _renderWorkflowDetail() {
    const workflow = this.graph?.workflow
    if (!workflow) return html`<div class="plan-task-placeholder">No workflow details available.</div>`
    return html`
      <div class="plan-task-detail">
        ${this._renderWorkflowInfoBar(workflow)}
        <div class="inspector-grid">
          <div class="inspector-col">
            <r-kv-list .items=${[
              { key: 'goal', label: 'Goal', value: workflow.goal || 'No goal' },
              { key: 'context', label: 'Context', value: workflow.context || 'No context' },
              { key: 'taskCount', label: 'Tasks', value: `${workflow.taskCount ?? this.graph?.nodes?.length ?? 0} tasks` },
            ]}></r-kv-list>
          </div>
          <div class="inspector-col">
            <r-kv-list .items=${[
              { key: 'inputs', label: 'Declared inputs', type: 'html' as const, value: html`<r-kv-list .items=${this._specItems(workflow.inputs)} emptyText="none"></r-kv-list>` },
              { key: 'outputs', label: 'Declared outputs', type: 'html' as const, value: html`<r-kv-list .items=${this._specItems(workflow.outputs)} emptyText="none"></r-kv-list>` },
            ]}></r-kv-list>
          </div>
        </div>
      </div>
    `
  }

  private _renderRunInfoBar(run: any) {
    if (!run) return nothing;
    const wf = this.graph?.workflow;
    const wfTitle = wf?.title || wf?.goal || wf?.id;
    const shortId = this._shortRunId(run.runId);
    const title = wfTitle ? `${wfTitle} · ${shortId}` : `Run ${shortId}`;

    const startEvent = run.events?.find((e: any) => e.type === 'runStarted') ?? run.events?.[0];
    const endEvent = (run.status === 'completed' || run.status === 'failed')
      ? (run.events?.slice().reverse().find((e: any) => e.type.includes('Completed') || e.type.includes('Failed') || e.type.includes('completed') || e.type.includes('failed')) ?? run.events?.[run.events.length - 1])
      : null;

    const startedAt = startEvent?.timestamp;
    const completedAt = endEvent?.timestamp;
    const isConfirming = this._confirmDeleteId === `run-${run.runId}`;

    return html`
      <div class="inspector-info-bar">
        <div class="info-bar-left">
          <div class="info-bar-title">${title}</div>
          <div class="info-bar-timing">
            ${startedAt ? html`
              <div class="timing-item">
                <r-icon name="info" size="sm"></r-icon>
                <span class="timing-label">Started:</span>
                <span class="timing-value">${this._formatDateTime(startedAt)}</span>
              </div>
            ` : nothing}
            ${completedAt ? html`
              <div class="timing-item">
                <r-icon name="check" size="sm"></r-icon>
                <span class="timing-label">Completed:</span>
                <span class="timing-value">${this._formatDateTime(completedAt)}</span>
              </div>
            ` : nothing}
            ${startedAt && completedAt ? html`
              <div class="timing-item">
                <r-icon name="info" size="sm"></r-icon>
                <span class="timing-label">Duration:</span>
                <span class="timing-value">${this._formatDuration(startedAt, completedAt)}</span>
              </div>
            ` : nothing}
          </div>
        </div>
        <div class="info-bar-right">
          ${run.status ? html`<r-badge status=${run.status}>${run.status}</r-badge>` : nothing}
          ${isConfirming ? html`
            <r-button size="sm" variant="danger" icon="trash" @click=${() => this._onRunDelete(run.runId, run.workflowId)}>Confirm Delete?</r-button>
            <r-button size="sm" variant="ghost" @click=${() => this._cancelDelete()}>Cancel</r-button>
          ` : html`
            <r-button size="sm" variant="danger" icon="trash" @click=${() => this._onRunDelete(run.runId, run.workflowId)}>Delete</r-button>
          `}
        </div>
      </div>
    `;
  }

  private _renderRunDetail() {
    const run = this.graph?.run
    if (!run) return html`<div class="plan-task-placeholder">No run selected.</div>`
    return html`
      <div class="plan-task-detail">
        ${this._renderRunInfoBar(run)}
        <div class="inspector-grid">
          <div class="inspector-col">
            <r-kv-list .items=${[
              ...(run.inputs && Object.keys(run.inputs).length > 0 ? [{ key: 'inputs', label: 'Inputs', type: 'html' as const, value: html`<r-kv-list .items=${this._kvItemsForOutputs(run.inputs)}></r-kv-list>` }] : []),
              { key: 'activeTasks', label: 'Active tasks', value: run.activeTaskIds?.length ? run.activeTaskIds.map((id: string) => this._taskById(id)?.label || id).join(', ') : 'none' },
            ]}></r-kv-list>
          </div>
          <div class="inspector-col">
            <r-kv-list .items=${[
              { key: 'pendingJobs', label: 'Pending jobs', type: 'html' as const, value: html`<r-kv-list .items=${this._pendingJobItems(run.pendingJobs ?? {})} emptyText="none"></r-kv-list>` },
            ]}></r-kv-list>
          </div>
        </div>
        ${this._renderIndividualOutputCollapses(`run-${run.runId}`, run.outputs)}
      </div>
    `
  }

  private _renderEvents() {
    const events = this.graph?.run?.events ?? []
    if (!events.length) {
      return html`<r-empty-state name="terminal" text="No run events available."></r-empty-state>`
    }
    
    const logs = events.map((event: any) => {
      let level: 'debug' | 'info' | 'warn' | 'error' = 'info'
      if (event.type.includes('fail') || event.type.includes('error')) {
        level = 'error'
      } else if (event.type.includes('warn') || event.type.includes('block')) {
        level = 'warn'
      }
      
      const taskLabel = event.taskId ? (this._taskById(event.taskId)?.label || event.taskId) : ''
      const message = taskLabel ? `[${taskLabel}] ${event.message}` : event.message
      
      return {
        timestamp: typeof event.timestamp === 'number' ? event.timestamp : new Date(event.timestamp).getTime(),
        level,
        source: event.type,
        message,
      }
    })

    return html`
      <div class="workflow-event-list">
        <r-log-stream .logs=${logs}></r-log-stream>
      </div>
    `
  }

  private _isArtifactRef(value: unknown): value is { type: 'artifact'; key?: string; url?: string; mimeType?: string } {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      (value as any).type === 'artifact' &&
      (typeof (value as any).key === 'string' || typeof (value as any).url === 'string')
  }

  private _artifactHref(value: { key?: string; url?: string }) {
    if (value.url) return value.url
    if (value.key) return `artifact?key=${encodeURIComponent(value.key)}`
    return null
  }

  private _formatDateTime(value: any) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
  }

  private _formatDuration(start: string, end: string) {
    const startMs = Date.parse(start)
    const endMs = Date.parse(end)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 'unknown'
    const seconds = Math.max(0, Math.round((endMs - startMs) / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const rest = seconds % 60
    return `${minutes}m ${rest}s`
  }

  private _shortRunId(value: string) {
    return value.length > 8 ? value.slice(0, 8) : value
  }
}
