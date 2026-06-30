import { html, nothing } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { RorschachBase } from '@rorschach/frontend/webkit/base.js'
import '@rorschach/frontend/webkit/r-tabs.js'
import '@rorschach/frontend/webkit/r-log-stream.js'
import '@rorschach/frontend/webkit/r-empty-state.js'

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
        outputs: taskState.outputs,
        error: taskState.error,
        blockedReason: taskState.blockedReason,
      }
    }),
  }
}

// Workflow inspector — 4-tab detail panel for the selected workflow graph.
// Extracted from the r-workflow-workspace monolith. Renders to light DOM
// to reuse the global workspace.css styles.

@customElement('r-workflow-inspector')
export class RWorkflowInspector extends RorschachBase {
  @property({ type: Object }) graph: any = null
  @property({ type: String }) selectedTaskId: string | null = null
  @property({ type: String }) tab: InspectorTab = 'task'

  override createRenderRoot() { return this }

  override render() {
    return html`
      <r-tabs 
        @tab-change=${(e: CustomEvent) => this._selectTab(e.detail.tab as any)}
      >
        ${(['task', 'workflow', 'run', 'events'] as InspectorTab[]).map(t => html`
          <button
            ?active=${this.tab === t}
            data-tab=${t}
            type="button"
          >${t}</button>
        `)}
      </r-tabs>
      ${this.tab === 'task' ? this._renderTaskDetail(this._taskById(this.selectedTaskId!)) : nothing}
      ${this.tab === 'workflow' ? this._renderWorkflowDetail() : nothing}
      ${this.tab === 'run' ? this._renderRunDetail() : nothing}
      ${this.tab === 'events' ? this._renderEvents() : nothing}
    `
  }

  private _selectTab(t: InspectorTab) {
    this.dispatchEvent(new CustomEvent('tab-change', { detail: { tab: t }, bubbles: true, composed: true }))
  }

  private _taskById(id: string) {
    return this.graph?.nodes.find((node: any) => node.id === id) ?? null
  }

  private _renderTaskDetail(task: any) {
    if (!task) return html`<div class="plan-task-placeholder">Select a task to inspect details.</div>`
    const deps = task.dependencies.length
      ? task.dependencies.map((id: string) => this._taskById(id)?.label || id).join(', ')
      : 'none'
    const dependents = task.dependents.length
      ? task.dependents.map((id: string) => this._taskById(id)?.label || id).join(', ')
      : 'none'
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
    `
  }

  private _renderWorkflowDetail() {
    const workflow = this.graph?.workflow
    if (!workflow) return html`<div class="plan-task-placeholder">No workflow details available.</div>`
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
    `
  }

  private _renderRunDetail() {
    const run = this.graph?.run
    if (!run) return html`<div class="plan-task-placeholder">No run selected.</div>`
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
      <div class="workflow-event-list" style="padding: 1rem; overflow: auto; height: 100%;">
        <r-log-stream .logs=${logs}></r-log-stream>
      </div>
    `
  }

  private _renderSpecs(specs: Record<string, any> | undefined) {
    const entries = Object.entries(specs ?? {})
    if (!entries.length) return html`<span class="workflow-muted">none</span>`
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
    `
  }

  private _renderPendingJobs(jobs: Record<string, any>) {
    const entries = Object.entries(jobs)
    if (!entries.length) return html`<span class="workflow-muted">none</span>`
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
    `
  }

  private _renderValueMap(values: Record<string, unknown>) {
    const entries = Object.entries(values)
    if (!entries.length) return html`<span class="workflow-muted">none</span>`
    return html`
      <div class="workflow-output-list">
        ${entries.map(([key, value]) => html`
          <div class="workflow-output-row">
            <div class="workflow-output-key">${key}</div>
            <div class="workflow-output-value">${this._renderValue(value)}</div>
          </div>
        `)}
      </div>
    `
  }

  private _renderValue(value: unknown) {
    if (this._isArtifactRef(value)) {
      const href = this._artifactHref(value)
      if (!href) return this._renderJson(value)
      return html`
        <a class="workflow-artifact-link" href=${href} target="_blank" rel="noopener noreferrer">
          ${this.renderIcon('file-text')}
          <span>${(value as any).path ?? (value as any).url}</span>
        </a>
      `
    }
    if (typeof value === 'string') return html`<pre>${value}</pre>`
    return this._renderJson(value)
  }

  private _renderJson(value: unknown) {
    return html`<pre>${JSON.stringify(value, null, 2)}</pre>`
  }

  private _isArtifactRef(value: unknown): value is { type: 'artifact'; path?: string; url?: string; mimeType?: string } {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      (value as any).type === 'artifact' &&
      (typeof (value as any).path === 'string' || typeof (value as any).url === 'string')
  }

  private _artifactHref(value: { path?: string; url?: string }) {
    if (value.url) return value.url
    if (value.path && this.graph?.run?.runId) return `workflow-runs/${encodeURIComponent(this.graph.run.runId)}/artifact?path=${encodeURIComponent(value.path)}`
    return null
  }

  private _formatDateTime(value: any) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
  }

  private _formatTime(value: any) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString()
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
