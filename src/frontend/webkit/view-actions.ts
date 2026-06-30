// ─── View & mode actions ───
//
// Pure store helpers that live in the kit so both the shell and plugin UI
// modules can import them without crossing the plugin/shell boundary. They
// operate on the generic 'shell' namespace — the same namespace the kit's
// store.ensureView / store.closeView already use for view runtime
// state. The shell seeds richer state (messages, logs, …) into the same
// namespace; these actions only touch the view/mode slice.
//
// `currentMode` and `activeWorkspaceTab` are persisted via the store's
// `persist` option (seeded in `rorschach.ts`), so these actions only call
// `set` and the store handles localStorage automatically. View runtime
// state uses a dedicated helper below because it is keyed
// per-view and merges with the `ViewConfig` defaults on read.

import { store } from './store.js'
import { modeLabel } from './utils.js'
import { readSavedViewState } from './view-state.js'
import type { ViewRuntimeState } from './host-types.js'

type ShellViewSlice = {
  currentMode: string
  currentModeDisplayName: string
  isWaiting: boolean
  views: Record<string, ViewRuntimeState>
  activeWorkspaceTab: string
};

const shell = () => store.namespace<ShellViewSlice>('shell')

/** Persist a single view's runtime state. The companion reader
 *  `readSavedViewState` lives in `view-state.ts` so both halves of the
 *  view-state persistence contract share one file. */
const persistViewState = (id: string, state: ViewRuntimeState) => {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(`rorschach.view_state.${id}`, JSON.stringify(state))
  }
}

export const setMode = (mode: string, displayName?: string) => {
  shell().set('currentMode', mode)
  shell().set('currentModeDisplayName', displayName || modeLabel(mode))
  shell().set('isWaiting', false)
}

export const setActiveWorkspaceTab = (id: string) => {
  shell().set('activeWorkspaceTab', id)
}

export const updateViewState = (id: string, updates: Partial<ViewRuntimeState>) => {
  const views = { ...shell().get('views') }
  const target = views[id]
  if (!target) return false

  const nextState = { ...target, ...updates }
  views[id] = nextState
  shell().set('views', views)
  persistViewState(id, nextState)
  return true
}

export const openView = (id: string) => {
  const views = { ...shell().get('views') }
  const viewState = views[id]
  if (!viewState) return

  viewState.isOpen = true
  setActiveWorkspaceTab(id)

  shell().set('views', views)
  persistViewState(id, viewState)
}

export const closeView = (id: string) => {
  const views = { ...shell().get('views') }
  const viewState = views[id]
  if (!viewState) return

  viewState.isOpen = false
  shell().set('views', views)
  persistViewState(id, viewState)
}

export { readSavedViewState }
