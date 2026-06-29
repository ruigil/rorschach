import type { UiSurfaceRegistration } from '../../types/ui-surface.js'
import type { PluginHostActions, WindowConfig } from '@rorschach/frontend/webkit/host-types.js'
import { store } from '@rorschach/frontend/webkit/store.js'
import { openWindow, closeWindow, setMode } from '@rorschach/frontend/webkit/window-actions.js'
import type { ShellState } from '../types/state.js'

// ─── Plugin-host — runtime surface registry ───
//
// Owns the runtime `windowRegistry` Map, the `surfaces` Map (source of truth
// for surface registrations), the `frameOwners` Map (frameType → surfaceId),
// and the `surfaceReducers` Map (surfaceId → reducer). Imports nothing
// plugin-specific, only from `@rorschach/frontend/webkit/`.
//
// `pluginHost.init()` is called once at boot. It seeds the shell-owned
// `chat` surface (no moduleUrl — `r-chat-panel` is a shell component already
// in the shell bundle) and the two legacy plugin surfaces (`docs`,
// `workflows`) that have not yet been migrated to publish their own
// `UiSurfaceRegistration`. The legacy seeds dynamic-import their plugin UI
// module so the custom element is defined. They are removed in Phase 2
// (docs) and Phase 3 (workflows).

const surfaces = new Map<string, UiSurfaceRegistration>()
const windowRegistry = new Map<string, WindowConfig>()
const frameOwners = new Map<string, string>()
const surfaceReducers = new Map<string, (frame: any, host: PluginHostActions) => void>()

// Facade passed to reducers. Bound to the shell's actions; plugins import
// only the PluginHostActions *type* from the kit, never the implementation.
const host: PluginHostActions = {
  openWindow: (id) => openWindow(id),
  closeWindow: (id) => closeWindow(id),
  setMode: (mode) => setMode(mode),
}

export const pluginHost = {
  windowRegistry,
  surfaces,

  async init() {
    // Shell-owned surface: no import needed (component is in the shell
    // bundle, loaded by index.html before pluginHost.init() runs).
    const chatCfg: WindowConfig = {
      id: 'chat',
      title: 'Chat',
      icon: 'message-square',
      contentTag: 'r-chat-panel',
      defaultWidth: 320,
      defaultHeight: 600,
      minWidth: 300,
      minHeight: 300,
    }
    windowRegistry.set('chat', chatCfg)
    store.ensureWindow('chat', chatCfg)

    const configCfg: WindowConfig = {
      id: 'config',
      title: 'Configuration',
      icon: 'settings',
      contentTag: 'r-config-form',
      defaultWidth: 600,
      defaultHeight: 500,
    }
    windowRegistry.set('config', configCfg)
    store.ensureWindow('config', configCfg)

    const observeCfg: WindowConfig = {
      id: 'observe',
      title: 'Observation',
      icon: 'activity',
      contentTag: 'r-observe-panel',
      defaultWidth: 800,
      defaultHeight: 600,
    }
    windowRegistry.set('observe', observeCfg)
    store.ensureWindow('observe', observeCfg)

    // All plugin surfaces (docs, workflows, ...) are now driven by
    // UiSurfaceRegistration WS frames. No legacy seeds remain.
    this._startModeWatcher()
  },

  dispatch(reg: UiSurfaceRegistration) {
    if (reg.moduleUrl === null) {
      this._unregister(reg.id)
      return
    }
    void this._register(reg)
  },

  async _register(reg: UiSurfaceRegistration) {
    surfaces.set(reg.id, reg)
    if (reg.window) {
      const cfg: WindowConfig = { ...reg.window, id: reg.id }
      windowRegistry.set(reg.id, cfg)
      store.ensureWindow(reg.id, cfg)
    }
    if (reg.moduleUrl) {
      try {
        const mod = await import(/* @vite-ignore */ reg.moduleUrl)
        surfaceReducers.set(reg.id, mod.reduceFrame ?? (() => {}))
      } catch (err) {
        console.error(`plugin-host: failed to load surface module ${reg.moduleUrl}:`, err)
        if (reg.window) {
          windowRegistry.set(reg.id, { ...reg.window, id: reg.id, contentTag: 'r-surface-error' })
        }
      }
    }
    for (const ft of reg.frameTypes ?? []) frameOwners.set(ft, reg.id)
    // Late-registration guard: if the surface's modes include the currently
    // active mode, open the window now. Handles WS reconnect (retained
    // surfaces replayed) and runtime plugin load — both arrive after
    // currentMode is already set. Idempotent.
    if (reg.window?.modes) {
      const currentMode = store.namespace<ShellState>('shell').get('currentMode')
      if (currentMode && reg.window.modes.includes(currentMode)) openWindow(reg.id)
    }
  },

  _unregister(id: string) {
    const reg = surfaces.get(id)
    if (!reg) return
    surfaces.delete(id)
    windowRegistry.delete(id)
    store.closeWindow(id)
    for (const ft of reg.frameTypes ?? []) frameOwners.delete(ft)
    store.namespace(id).reset()
    surfaceReducers.delete(id)
    // Note: customElements.define is irreversible — see plan §16.4
  },

  routeFrame(frame: { type: string; [k: string]: any }): boolean {
    const owner = frameOwners.get(frame.type)
    if (!owner) return false
    surfaceReducers.get(owner)?.(frame, host)
    return true
  },

  /** Open windows whose surface declares `modes` containing the new mode.
   *  No auto-close on mode-away (closing stays a user action — see plan
   *  §16.9). Replaces the old r-shell.ts mode→window logic. */
  _startModeWatcher() {
    store.namespace<ShellState>('shell').subscribe('currentMode', (mode) => {
      for (const [id, reg] of surfaces) {
        if (reg.window?.modes?.includes(mode)) {
          openWindow(id)
        }
      }
    })
  },
}
