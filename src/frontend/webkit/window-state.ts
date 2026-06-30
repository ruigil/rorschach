// ─── Window-state persistence ───
//
// Both halves of the per-window runtime-state persistence contract live here:
// `readSavedWindowState` (used by `store.ensureWindow`) and the write side
// (in `window-actions.ts` via `persistWindowState`). Keeping the reader in
// its own module avoids a circular import between `store.ts` (which needs to
// read saved state when seeding a window) and `window-actions.ts` (which
// imports `store`). The writer still lives in `window-actions.ts` because it
// is only called from action helpers; this module owns only the read/merge
// shape so `store.ts` can import it without pulling in the action layer.

import type { WindowConfig, WindowRuntimeState } from './host-types.js'

export const readSavedWindowState = (id: string, cfg: WindowConfig): WindowRuntimeState => {
  const defaultX = typeof window !== 'undefined' ? window.innerWidth - 420 : 800
  const defaultY = 100

  const defaultState: WindowRuntimeState = {
    id,
    isOpen: id === 'chat',
    isMinimized: false,
    x: defaultX,
    y: defaultY,
    w: cfg.defaultWidth,
    h: cfg.defaultHeight,
    zIndex: 1000,
    params: {},
  }

  if (typeof localStorage === 'undefined') return defaultState

  const saved = localStorage.getItem(`rorschach.window_state.${id}`)
  if (saved) {
    try {
      const parsed = JSON.parse(saved)
      return { ...defaultState, ...parsed }
    } catch { /* fall through */ }
  }

  return defaultState
}
