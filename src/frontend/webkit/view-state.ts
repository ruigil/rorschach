// ─── View-state persistence ───
//
// Both halves of the per-view runtime-state persistence contract live here:
// `readSavedViewState` (used by `store.ensureView`) and the write side
// (in `view-actions.ts` via `persistViewState`). Keeping the reader in
// its own module avoids a circular import between `store.ts` (which needs to
// read saved state when seeding a view) and `view-actions.ts` (which
// imports `store`). The writer still lives in `view-actions.ts` because it
// is only called from action helpers; this module owns only the read/merge
// shape so `store.ts` can import it without pulling in the action layer.

import type { ViewConfig, ViewRuntimeState } from './host-types.js'

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

