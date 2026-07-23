// Notebook plugin UI module.
// Defines the r-notebook-workspace custom element.

import { RNotebookWorkspace } from './r-notebook-workspace.js'
import { store } from '@rorschach/webkit';

export { RNotebookWorkspace }

export type NotebookState = {
  activeTab: string
  splitPercent: number
  todos: any[]
  highlightedDays: string[]
  selectedDate: string | null
  selectedEntry: string | null
  habits: any[]
  trackerEntries: any[]
  trackerStats: any | null
  errorMessage: string | null
}

store.namespace<NotebookState>('notebook').init(
  {
    activeTab: 'journal',
    splitPercent: 70,
    todos: [],
    highlightedDays: [],
    selectedDate: null,
    selectedEntry: null,
    habits: [],
    trackerEntries: [],
    trackerStats: null,
    errorMessage: null,
  },
  { persist: ['splitPercent'] },
)

export const reduceFrame = (frame: any) => {
  const ns = store.namespace<NotebookState>('notebook')
  if (frame.type === 'notebook.todos.list') {
    ns.set('todos', frame.todos)
  } else if (frame.type === 'notebook.journal.months') {
    ns.set('highlightedDays', frame.days)
  } else if (frame.type === 'notebook.journal.entry') {
    ns.set('selectedDate', frame.date)
    ns.set('selectedEntry', frame.content)
    ns.set('activeTab', 'journal')
  } else if (frame.type === 'notebook.tracker.habits') {
    ns.set('habits', frame.habits)
  } else if (frame.type === 'notebook.tracker.entries') {
    ns.set('trackerEntries', frame.entries)
  } else if (frame.type === 'notebook.tracker.stats') {
    ns.set('trackerStats', frame.stats)
  } else if (frame.type === 'notebook.error') {
    ns.set('errorMessage', frame.message)
  }
}

declare module '@rorschach/webkit/runtime/store.js' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface NamespaceRegistry {
    notebook: NotebookState
  }
}
