import { html, nothing } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { RorschachBase } from '@rorschach/frontend/webkit/base.js'
import '@rorschach/frontend/webkit/r-tabs.js'
import '@rorschach/frontend/webkit/r-log-stream.js'
import '@rorschach/frontend/webkit/r-empty-state.js'
import '@rorschach/frontend/webkit/r-badge.js'
import '@rorschach/frontend/webkit/r-kv-list.js'
import '@rorschach/frontend/webkit/r-icon.js'
import '@rorschach/frontend/webkit/r-panel.js'
import '@rorschach/frontend/webkit/r-toolbar.js'

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
      <r-panel elevation="2" style="height: 100%;">
        <r-toolbar slot="header-container">
          <r-tabs 
            @tab-change=${(e: CustomEvent) => this._selectTab(e.detail.tab as any)}
          >
            ${(['workflow', 'task', 'run', 'events'] as InspectorTab[]).map(t => html`
              <button
                ?active=${this.tab === t}
                data-tab=${t}
                type="button"
              >${t}</button>
            `)}
          </r-tabs>
        </r-toolbar>
        <div class="inspector-content-body" style="height: 100%; overflow-y: auto;">
          ${this.tab === 'task' ? this._renderTaskDetail(this._taskById(this.selectedTaskId!)) : nothing}
          ${this.tab === 'workflow' ? this._renderWorkflowDetail() : nothing}
          ${this.tab === 'run' ? this._renderRunDetail() : nothing}
          ${this.tab === 'events' ? this._renderEvents() : nothing}
        </div>
      </r-panel>
    `
  }

  private _selectTab(t: InspectorTab) {
    this.dispatchEvent(new CustomEvent('tab-change', { detail: { tab: t }, bubbles: true, composed: true }))
  }

  private _taskById(id: string) {
    return this.graph?.nodes.find((node: any) => node.id === id) ?? null
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
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <r-badge status=${task.status ?? 'pending'}>${task.status ?? 'pending'}</r-badge>
        </div>
        <h3>${task.label}</h3>
        <r-kv-list .items=${[
          { key: 'description', label: 'Description', value: task.description || 'No description' },
          { key: 'validation', label: 'Validation', value: task.validationCriteria || 'No validation criteria' },
          { key: 'dependsOn', label: 'Depends on', value: deps },
          { key: 'unlocks', label: 'Unlocks', value: dependents },
          ...(task.attempts !== undefined ? [{ key: 'attempts', label: 'Attempts', value: task.attempts }] : []),
          ...(task.startedAt ? [{ key: 'started', label: 'Started', value: this._formatDateTime(task.startedAt) }] : []),
          ...(task.completedAt ? [{ key: 'completed', label: 'Completed', value: this._formatDateTime(task.completedAt) }] : []),
          ...(task.startedAt && task.completedAt ? [{ key: 'duration', label: 'Duration', value: this._formatDuration(task.startedAt, task.completedAt) }] : []),
          ...(task.summary ? [{ key: 'summary', label: 'Summary', value: task.summary }] : []),
          ...(task.outputs && Object.keys(task.outputs).length > 0 ? [{ key: 'outputs', label: 'Outputs', type: 'html' as const, value: html`<r-kv-list .items=${this._kvItemsForOutputs(task.outputs)}></r-kv-list>` }] : []),
          ...(task.error ? [{ key: 'error', label: 'Error', value: task.error }] : []),
          ...(task.blockedReason ? [{ key: 'blockedReason', label: 'Blocked reason', value: JSON.stringify(task.blockedReason, null, 2) }] : []),
        ]}></r-kv-list>
      </div>
    `
  }

  private _renderWorkflowDetail() {
    const workflow = this.graph?.workflow
    if (!workflow) return html`<div class="plan-task-placeholder">No workflow details available.</div>`
    return html`
      <div class="plan-task-detail">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <r-badge status="pending">Workflow</r-badge>
        </div>
        <h3>${workflow.goal}</h3>
        <r-kv-list .items=${[
          { key: 'context', label: 'Context', value: workflow.context || 'No context' },
          { key: 'created', label: 'Created', value: this._formatDateTime(workflow.createdAt) },
          { key: 'tools', label: 'Execution tools', value: workflow.executionTools?.length ? workflow.executionTools.join(', ') : 'none' },
          { key: 'inputs', label: 'Declared inputs', type: 'html' as const, value: html`<r-kv-list .items=${this._specItems(workflow.inputs)} emptyText="none"></r-kv-list>` },
          { key: 'outputs', label: 'Declared outputs', type: 'html' as const, value: html`<r-kv-list .items=${this._specItems(workflow.outputs)} emptyText="none"></r-kv-list>` },
        ]}></r-kv-list>
      </div>
    `
  }

  private _renderRunDetail() {
    const run = this.graph?.run
    if (!run) return html`<div class="plan-task-placeholder">No run selected.</div>`
    return html`
      <div class="plan-task-detail">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <r-badge status=${run.status}>Run · ${run.status}</r-badge>
        </div>
        <h3>${run.runId}</h3>
        <r-kv-list .items=${[
          { key: 'inputs', label: 'Inputs', type: 'html' as const, value: html`<r-kv-list .items=${this._kvItemsForOutputs(run.inputs)}></r-kv-list>` },
          { key: 'outputs', label: 'Outputs', type: 'html' as const, value: html`<r-kv-list .items=${this._kvItemsForOutputs(run.outputs)}></r-kv-list>` },
          { key: 'activeTasks', label: 'Active tasks', value: run.activeTaskIds?.length ? run.activeTaskIds.map((id: string) => this._taskById(id)?.label || id).join(', ') : 'none' },
          { key: 'pendingJobs', label: 'Pending jobs', type: 'html' as const, value: html`<r-kv-list .items=${this._pendingJobItems(run.pendingJobs ?? {})} emptyText="none"></r-kv-list>` },
        ]}></r-kv-list>
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
