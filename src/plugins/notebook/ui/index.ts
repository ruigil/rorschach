// Notebook plugin UI module.
// Defines the r-notebook-workspace custom element.

import { RNotebookWorkspace } from './r-notebook-workspace.js'
import { store } from '@rorschach/frontend/webkit/store.js'

export { RNotebookWorkspace }

export type NotebookState = {
  activeTab: string
  splitPercent: number
}

const savedSplit = typeof localStorage !== 'undefined'
  ? Number(localStorage.getItem('rorschach.notebook.splitPercent') ?? 0)
  : 0

store.namespace<NotebookState>('notebook').init({
  activeTab: 'journal',
  splitPercent: savedSplit || 70
})

export const reduceFrame = () => {
  // Read-only plugin, no WS frames to route
}
