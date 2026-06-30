import type { UiSurfaceRegistration } from '../../types/ui-surface.js'
import type { PluginHostActions, ViewConfig } from '@rorschach/frontend/webkit/host-types.js'
import { store } from '@rorschach/frontend/webkit/store.js'
import { openView, closeView, setMode } from '@rorschach/frontend/webkit/view-actions.js'
import type { ShellState } from '../types/state.js'

// ─── Plugin-host — runtime surface registry ───
//
// Owns the runtime `viewRegistry` Map, the `surfaces` Map (source of truth
// for surface registrations), the `frameOwners` Map (frameType → surfaceId),
// and the `surfaceReducers` Map (surfaceId → reducer). Imports nothing
// plugin-specific, only from `@rorschach/frontend/webkit/`.
//
// `pluginHost.init()` is called once at boot. It seeds the two built-in workspace
// views (`config`, `observe`) that can be opened as tabs.

const surfaces = new Map<string, UiSurfaceRegistration>()
const viewRegistry = new Map<string, ViewConfig>()
const frameOwners = new Map<string, string>()
const surfaceReducers = new Map<string, (frame: any, host: PluginHostActions) => void>()

// Facade passed to reducers. Bound to the shell's actions; plugins import
// only the PluginHostActions *type* from the kit, never the implementation.
const host: PluginHostActions = {
  openView: (id) => openView(id),
  closeView: (id) => closeView(id),
  setMode: (mode) => setMode(mode),
}

export const pluginHost = {
  viewRegistry,
  surfaces,

  async init() {
    const configCfg: ViewConfig = {
      id: 'config',
      title: 'Configuration',
      icon: 'settings',
      contentTag: 'r-config-form',
    }
    viewRegistry.set('config', configCfg)
    store.ensureView('config', configCfg)

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
    if (reg.view) {
      const cfg: ViewConfig = { ...reg.view, id: reg.id }
      viewRegistry.set(reg.id, cfg)
      store.ensureView(reg.id, cfg)
    }
    if (reg.moduleUrl) {
      try {
        const mod = await import(/* @vite-ignore */ reg.moduleUrl)
        surfaceReducers.set(reg.id, mod.reduceFrame ?? (() => {}))
      } catch (err) {
        console.error(`plugin-host: failed to load surface module ${reg.moduleUrl}:`, err)
        if (reg.view) {
          viewRegistry.set(reg.id, { ...reg.view, id: reg.id, contentTag: 'r-surface-error' })
        }
      }
    }
    for (const ft of reg.frameTypes ?? []) frameOwners.set(ft, reg.id)
    // Late-registration guard: if the surface's modes include the currently
    // active mode, open the view now. Handles WS reconnect (retained
    // surfaces replayed) and runtime plugin load — both arrive after
    // currentMode is already set. Idempotent.
    if (reg.view?.modes) {
      const currentMode = store.namespace<ShellState>('shell').get('currentMode')
      if (currentMode && reg.view.modes.includes(currentMode)) openView(reg.id)
    }
  },

  _unregister(id: string) {
    const reg = surfaces.get(id)
    if (!reg) return
    surfaces.delete(id)
    viewRegistry.delete(id)
    store.closeView(id)
    for (const ft of reg.frameTypes ?? []) frameOwners.delete(ft)
    store.namespace(id).reset()
    surfaceReducers.delete(id)
  },

  routeFrame(frame: { type: string; [k: string]: any }): boolean {
    const owner = frameOwners.get(frame.type)
    if (!owner) return false
    surfaceReducers.get(owner)?.(frame, host)
    return true
  },

  /** Open views whose surface declares `modes` containing the new mode. */
  _startModeWatcher() {
    store.namespace<ShellState>('shell').subscribe('currentMode', (mode) => {
      for (const [id, reg] of surfaces) {
        if (reg.view?.modes?.includes(mode)) {
          openView(id)
        }
      }
    })
  },
}
