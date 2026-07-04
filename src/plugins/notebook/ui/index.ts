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
  if (frame.type === 'notebookTodosList') {
    ns.set('todos', frame.todos)
  } else if (frame.type === 'notebookJournalMonths') {
    const yearStr = String(frame.year)
    const monthStr = String(frame.month).padStart(2, '0')
    const highlighted = frame.days.map((d: any) => `${yearStr}-${monthStr}-${String(d).padStart(2, '0')}`)
    ns.set('highlightedDays', highlighted)
  } else if (frame.type === 'notebookJournalEntry') {
    ns.set('selectedEntry', frame.content)
  } else if (frame.type === 'notebookTrackerHabits') {
    ns.set('habits', frame.habits)
  } else if (frame.type === 'notebookTrackerEntries') {
    ns.set('trackerEntries', frame.entries)
  } else if (frame.type === 'notebookTrackerStats') {
    ns.set('trackerStats', frame.stats)
  } else if (frame.type === 'notebookError') {
    ns.set('errorMessage', frame.message)
  }
}

declare module '@rorschach/webkit/runtime/store.js' {
  interface NamespaceRegistry {
    notebook: NotebookState
  }
}
