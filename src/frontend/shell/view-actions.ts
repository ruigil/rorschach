// ─── View & mode actions ───
//
// Pure store helpers that operate on the generic 'shell' namespace.
// Placed in shell to maintain dependency inversion boundaries.

import { store } from '@rorschach/frontend/webkit/store.js'
import { modeLabel } from '@rorschach/frontend/webkit/utils.js'
import { readSavedViewState } from '@rorschach/frontend/webkit/view-state.js'
import type { ViewRuntimeState } from '@rorschach/frontend/webkit/host-types.js'

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
