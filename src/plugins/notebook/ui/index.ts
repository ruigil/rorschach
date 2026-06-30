// Notebook plugin UI module.
// Defines the r-notebook-workspace custom element.

import { RNotebookWorkspace } from './r-notebook-workspace.js'
import { store } from '@rorschach/frontend/webkit/store.js'

export { RNotebookWorkspace }

export type NotebookState = {
  activeTab: string
  splitPercent: number
}

store.namespace<NotebookState>('notebook').init(
  { activeTab: 'journal', splitPercent: 70 },
  { persist: ['splitPercent'] },
)

export const reduceFrame = () => {
  // Read-only plugin, no WS frames to route
}
