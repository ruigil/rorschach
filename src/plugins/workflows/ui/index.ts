// Workflows plugin UI module.
//
// Defines the r-workflow-workspace custom element (which composes
// r-workflow-list and r-workflow-inspector) and exports a reduceFrame that
// handles workflowGraph and workflowRunUpdated frames.

import { RWorkflowWorkspace } from './r-workflow-workspace.js'
import { RWorkflowList } from './r-workflow-list.js'
import { RWorkflowInspector } from './r-workflow-inspector.js'
import { store, type PluginHostActions } from '@rorschach/webkit';

import { mergeWorkflowRunIntoGraph } from './r-workflow-workspace.js'

export { RWorkflowWorkspace, RWorkflowList, RWorkflowInspector }

export type WorkflowsState = {
  currentGraph: any | null
  inspectorWidthPercent: number
  /** Persisted view-state for the workspace container. */
  workspaceView: 'list' | 'graph'
  workspaceWorkflowId: string | null
  workspaceRunId: string | null
  workspaceSelectedTaskId: string | null
  workflows: any[]
  runs: any[]
  errorMessage: string | null
};

store.namespace<WorkflowsState>('workflows').init(
  {
    currentGraph: null,
    inspectorWidthPercent: 34,
    workspaceView: 'list',
    workspaceWorkflowId: null,
    workspaceRunId: null,
    workspaceSelectedTaskId: null,
    workflows: [],
    runs: [],
    errorMessage: null,
  },
  {
    persist: [
      'inspectorWidthPercent',
      'workspaceView',
      'workspaceWorkflowId',
      'workspaceRunId',
      'workspaceSelectedTaskId',
    ],
  },
)

export const WORKFLOW_RUN_UPDATED_EVENT = 'workflow-run-updated'

export const reduceFrame = (frame: any, host: PluginHostActions) => {
  const ns = store.namespace<WorkflowsState>('workflows')
  if (frame.type === 'workflowGraph') {
    ns.set('currentGraph', frame)
    ns.set('errorMessage', null)
    host.openView('workflows')
  } else if (frame.type === 'workflowsList') {
    ns.set('workflows', frame.workflows)
  } else if (frame.type === 'workflowRunsList') {
    ns.set('runs', frame.runs)
  } else if (frame.type === 'workflowError') {
    ns.set('errorMessage', frame.message)
  } else if (frame.type === 'workflowRunUpdated') {
    const current = ns.get('currentGraph')
    if (current && (current.run?.runId === frame.runId || current.runId === frame.runId)) {
      const merged = mergeWorkflowRunIntoGraph(current, frame.run)
      ns.set('currentGraph', merged)
    }
    const runs = ns.get('runs') ?? []
    const existingIndex = runs.findIndex((r: any) => r.runId === (frame.runId || frame.run?.runId))
    const nextRuns = existingIndex >= 0
      ? runs.map((r: any, idx: number) => idx === existingIndex ? frame.run : r)
      : [frame.run, ...runs]
    ns.set('runs', nextRuns)

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(WORKFLOW_RUN_UPDATED_EVENT, { detail: frame }))
    }
  }
}

declare module '@rorschach/webkit/store.js' {
  interface NamespaceRegistry {
    workflows: WorkflowsState
  }
}
