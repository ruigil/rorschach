import { store } from '@rorschach/webkit';
import type { ViewConfig, ViewRuntimeState } from './types.js';

type ShellViewSlice = {
  currentMode: string
  currentModeDisplayName: string
  isWaiting: boolean
  views: Record<string, ViewRuntimeState>
  activeWorkspaceTab: string
};

const shell = () => store.namespace<ShellViewSlice>('shell')

export const readSavedViewState = (id: string, _cfg: ViewConfig): ViewRuntimeState => {
  const defaultState: ViewRuntimeState = {
    id,
    isOpen: false,
    params: {},
  }

  if (typeof localStorage === 'undefined') return defaultState

  const saved = localStorage.getItem(`rorschach.view_state.${id}`)
  if (saved) {
    try {
      const parsed = JSON.parse(saved)
      return { ...defaultState, ...parsed }
    } catch { /* fall through */ }
  }

  return defaultState
}

/** Persist a single view's runtime state. The companion reader
 *  `readSavedViewState` lives in `view-state.ts` so both halves of the
 *  view-state persistence contract share one file. */
const persistViewState = (id: string, state: ViewRuntimeState) => {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(`rorschach.view_state.${id}`, JSON.stringify(state))
  }
}

export const ensureView = (id: string, cfg: ViewConfig): void => {
  const views = { ...shell().get('views') }
  if (views[id]) return

  const state = readSavedViewState(id, cfg)
  views[id] = state
  shell().set('views', views)
}

export const setMode = (mode: string, displayName?: string) => {
  shell().set('currentMode', mode)
  shell().set('currentModeDisplayName', displayName ?? mode)
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

export const closeView = (id: string, persist = true) => {
  const views = { ...shell().get('views') }
  const viewState = views[id]
  if (!viewState) return

  viewState.isOpen = false
  shell().set('views', views)
  if (persist) {
    persistViewState(id, viewState)
  }

  setActiveWorkspaceTab(Object.keys(views).find(k => views[k]?.isOpen) ?? 'none')
}

