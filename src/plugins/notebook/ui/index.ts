// Notebook plugin UI module.
// Defines the r-notebook-workspace custom element.

import { RNotebookWorkspace } from './r-notebook-workspace.js'
import { store } from '@rorschach/frontend/webkit/store.js'

export { RNotebookWorkspace }

export type NotebookState = {
  activeTab: string
}

store.namespace<NotebookState>('notebook').init({ activeTab: 'todos' })

export const reduceFrame = () => {
  // Read-only plugin, no WS frames to route
}
