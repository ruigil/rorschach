// Workflows plugin UI module.
//
// Defines the r-workflow-workspace custom element (which composes
// r-workflow-list and r-workflow-inspector) and exports a reduceFrame that
// handles workflowGraph and workflowRunUpdated frames.

import { RWorkflowWorkspace } from './r-workflow-workspace.js'
import { RWorkflowList } from './r-workflow-list.js'
import { RWorkflowInspector } from './r-workflow-inspector.js'
import { store } from '@rorschach/frontend/webkit/store.js'
import type { PluginHostActions } from '@rorschach/frontend/webkit/host-types.js'
import { mergeWorkflowRunIntoGraph } from './r-workflow-workspace.js'

export { RWorkflowWorkspace, RWorkflowList, RWorkflowInspector }

export interface WorkflowsState {
  currentGraph: any | null
}

store.namespace<WorkflowsState>('workflows').init({ currentGraph: null })

export const WORKFLOW_RUN_UPDATED_EVENT = 'workflow-run-updated'

export function reduceFrame(frame: any, host: PluginHostActions) {
  if (frame.type === 'workflowGraph') {
    store.namespace<WorkflowsState>('workflows').set('currentGraph', frame)
    host.openWindow('workflows')
  } else if (frame.type === 'workflowRunUpdated') {
    const current = store.namespace<WorkflowsState>('workflows').get('currentGraph')
    if (current) {
      const merged = mergeWorkflowRunIntoGraph(current, frame.run)
      store.namespace<WorkflowsState>('workflows').set('currentGraph', merged)
    }
    // Also dispatch the window event for the list view's run chip updates.
    // The container's _applyWorkflowRunUpdate handler updates the list view's
    // _runs array when a run update arrives while in list view.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(WORKFLOW_RUN_UPDATED_EVENT, { detail: frame }))
    }
  }
}
