// ─── Window & mode actions ───
//
// Pure store helpers that live in the kit so both the shell and plugin UI
// modules can import them without crossing the plugin/shell boundary. They
// operate on the generic 'shell' namespace — the same namespace the kit's
// store.ensureWindow / store.closeWindow already use for window runtime
// state. The shell seeds richer state (messages, logs, …) into the same
// namespace; these actions only touch the window/mode slice.

import { store } from './store.js'
import { modeLabel } from './utils.js'
import type { WindowRuntimeState } from './host-types.js'

interface ShellWindowSlice {
  currentMode: string
  currentModeDisplayName: string
  isWaiting: boolean
  windows: Record<string, WindowRuntimeState>
  activeWindowIds: string[]
  activeWorkspaceTab: string
}

const shell = () => store.namespace<ShellWindowSlice>('shell')

function persistWindowState(id: string, state: WindowRuntimeState) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(`rorschach.window_state.${id}`, JSON.stringify(state))
  }
}

export function setMode(mode: string, displayName?: string) {
  shell().set('currentMode', mode)
  shell().set('currentModeDisplayName', displayName || modeLabel(mode))
  shell().set('isWaiting', false)
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('rorschach.currentMode', mode)
  }
}

export function setActiveWorkspaceTab(id: string) {
  shell().set('activeWorkspaceTab', id)
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('rorschach.activeWorkspaceTab', id)
  }
}

export function updateWindowState(id: string, updates: Partial<WindowRuntimeState>) {
  const windows = { ...shell().get('windows') }
  const target = windows[id]
  if (!target) return false

  const nextState = { ...target, ...updates }
  windows[id] = nextState
  shell().set('windows', windows)
  persistWindowState(id, nextState)
  return true
}

export function undockWindow(id: string) {
  return updateWindowState(id, { isDocked: false })
}

export function focusWindow(id: string) {
  const activeIds = [...shell().get('activeWindowIds')]
  const idx = activeIds.indexOf(id)
  if (idx !== -1) activeIds.splice(idx, 1)
  activeIds.push(id)
  shell().set('activeWindowIds', activeIds)

  const windows = { ...shell().get('windows') }
  activeIds.forEach((activeId, index) => {
    if (windows[activeId]) {
      windows[activeId].zIndex = 1000 + index
    }
  })
  shell().set('windows', windows)
}

export function openWindow(id: string) {
  const windows = { ...shell().get('windows') }
  const winState = windows[id]
  if (!winState) return

  winState.isOpen = true
  winState.isMinimized = false

  if (winState.isDocked && id !== 'chat') {
    setActiveWorkspaceTab(id)
  }

  shell().set('windows', windows)
  focusWindow(id)

  if (typeof localStorage !== 'undefined') {
    persistWindowState(id, winState)
  }
}

export function closeWindow(id: string) {
  const windows = { ...shell().get('windows') }
  const winState = windows[id]
  if (!winState) return

  winState.isOpen = false
  shell().set('windows', windows)

  const activeIds = [...shell().get('activeWindowIds')]
  const idx = activeIds.indexOf(id)
  if (idx !== -1) {
    activeIds.splice(idx, 1)
    shell().set('activeWindowIds', activeIds)
  }

  if (typeof localStorage !== 'undefined') {
    persistWindowState(id, winState)
  }
}
