import type { UiSurfaceRegistration } from '../../types/ui-surface.js'
import { store, type PluginHostActions } from '@rorschach/webkit';
import { openView, closeView, setMode, ensureView } from './view-actions.js'
import type { ViewConfig, ShellState } from './types.js'

// ─── Plugin-host — runtime surface registry ───
//
// Owns the runtime `viewRegistry` Map, the `surfaces` Map (source of truth
// for surface registrations), the `frameOwners` Map (frameType → surfaceId),
// and the `surfaceReducers` Map (surfaceId → reducer). Imports nothing
// plugin-specific, only from `@rorschach/webkit/`.
//
// `pluginHost().init()` is called once at boot. It seeds the built-in config
// view that can be opened as a tab.


type PluginHostInstance = {
  init: () => void;
  dispatch: (reg: UiSurfaceRegistration) => void;
  routeFrame: (frame: Record<string, any>) => boolean;
  getViewConfig: (id: string) => ViewConfig | undefined;
  setViewConfig: (id: string, config: ViewConfig) => void;
}

let instance: PluginHostInstance | null = null;

const createPluginHost = (): PluginHostInstance => {
  const surfaces = new Map<string, UiSurfaceRegistration>()
  const viewRegistry = new Map<string, ViewConfig>()
  const frameOwners = new Map<string, string>()
  const surfaceReducers = new Map<string, (frame: Record<string, any>, host: PluginHostActions) => void>()

  const init = () => {
    const configCfg: ViewConfig = {
      id: 'config',
      title: 'Configuration',
      icon: 'settings',
      contentTag: 'r-config-form',
    }
    viewRegistry.set('config', configCfg)
    ensureView('config', configCfg)

    startModeWatcher()
  };

  const dispatch = (reg: UiSurfaceRegistration) => {
    if (reg.moduleUrl === null) {
      unregister(reg.id)
      return
    }
    register(reg)
  }

  const register = async (reg: UiSurfaceRegistration) => {
    surfaces.set(reg.id, reg)
    if (reg.view) {
      const cfg: ViewConfig = { ...reg.view, id: reg.id }
      viewRegistry.set(reg.id, cfg)
      ensureView(reg.id, cfg)
    }
    for (const ft of reg.frameTypes ?? []) frameOwners.set(ft, reg.id)
    if (reg.moduleUrl) {
      try {
        const mod = await import(reg.moduleUrl)
        surfaceReducers.set(reg.id, mod.reduceFrame ?? (() => {}))
      } catch (err) {
        //console.error(`plugin-host: failed to load surface module ${reg.moduleUrl}:`, err)
        if (reg.view) {
          viewRegistry.set(reg.id, { ...reg.view, id: reg.id, contentTag: 'r-surface-error' })
        }
      }
    }
    // Late-registration guard: if the surface's modes include the currently
    // active mode, open the view now. Handles WS reconnect (retained
    // surfaces replayed) and runtime plugin load — both arrive after
    // currentMode is already set. Idempotent.
    if (reg.view?.modes) {
      const currentMode = store.namespace<ShellState>('shell').get('currentMode')
      if (currentMode && reg.view.modes.includes(currentMode)) openView(reg.id)
    }
  }

  const unregister = (id: string) => {
    const reg = surfaces.get(id)
    if (!reg) return
    surfaces.delete(id)
    viewRegistry.delete(id)
    closeView(id, false)
    for (const ft of reg.frameTypes ?? []) frameOwners.delete(ft)
    store.namespace(id).reset()
    surfaceReducers.delete(id)
  }

  const routeFrame = (frame: Record<string, any>): boolean => {
    //console.log('pluginHost.routeFrame called with frame:', frame)
    const owner = frameOwners.get(frame.type)
    if (!owner) return false
    surfaceReducers.get(owner)?.(frame, { openView, closeView, setMode })
    return true
  }

  /** Open views whose surface declares `modes` containing the new mode. */
  const startModeWatcher = () => {
    store.namespace<ShellState>('shell').subscribe('currentMode', (mode) => {
      for (const [id, reg] of surfaces) {
        if (reg.view?.modes?.includes(mode)) {
          openView(id)
        }
      }
    })
  }

  const getViewConfig = (id: string): ViewConfig | undefined => {
    return viewRegistry.get(id)
  }
  const setViewConfig = (id: string, config: ViewConfig) => {
    viewRegistry.set(id, config)
  }

  return {
    init,
    dispatch,
    routeFrame,
    getViewConfig,
    setViewConfig
  }
}

export const pluginHost = () => {
  if (!instance) {
    instance = createPluginHost()
  }
  return instance
}

export const __resetPluginHostForTests = () => {
  instance = null
}

