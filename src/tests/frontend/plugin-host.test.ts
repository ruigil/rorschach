import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { store, __resetStoreForTests } from '../../frontend/webkit/store.js'
import { pluginHost } from '../../frontend/shell/plugin-host.js'
import type { ShellState } from '../../frontend/types/state.js'
import type { UiSurfaceRegistration } from '../../types/ui-surface.js'

beforeEach(() => {
  __resetStoreForTests()
  localStorage.clear()
  pluginHost.windowRegistry.clear()
  pluginHost.surfaces.clear()
  store.namespace<ShellState>('shell').init({
    isConnected: false,
    isWaiting: false,
    currentUserId: null,
    currentUserRoles: [],
    agents: [],
    currentMode: '',
    currentModeDisplayName: '',
    topics: [],
    actors: [],
    logs: [],
    traces: [],
    usage: [],
    tools: {},
    ws: null,
    messages: [],
    activeTab: 'chat',
    observeActiveTab: 'metrics',
    activeStream: { isActive: false, reasoning: '', text: '', sources: [], attachments: [] },
    windows: {},
    activeWindowIds: [],
    activeWorkspaceTab: 'docs',
  })
})

afterEach(() => {
  __resetStoreForTests()
  localStorage.clear()
  pluginHost.windowRegistry.clear()
  pluginHost.surfaces.clear()
})

describe('pluginHost.dispatch (register)', () => {
  test('registers a window in the registry', async () => {
    const reg: UiSurfaceRegistration = {
      id: 'test-surface',
      version: '1.0.0',
      window: {
        title: 'Test',
        icon: 'file',
        contentTag: 'r-empty-state',
        defaultWidth: 300,
        defaultHeight: 400,
        minWidth: 200,
        minHeight: 200,
      },
      moduleUrl: '/plugins/test/ui/index.js',
    }

    // Mock dynamic import — the module doesn't exist, so it will fail
    // gracefully and swap to r-surface-error
    pluginHost.dispatch(reg)
    // Wait for the async _register to complete
    await new Promise(r => setTimeout(r, 50))

    expect(pluginHost.surfaces.get('test-surface')).toBeDefined()
    expect(pluginHost.windowRegistry.get('test-surface')).toBeDefined()
    expect(pluginHost.windowRegistry.get('test-surface')!.title).toBe('Test')
  })

  test('opens window when modes includes currentMode (late-registration guard)', async () => {
    store.namespace<ShellState>('shell').set('currentMode', 'testmode')

    const reg: UiSurfaceRegistration = {
      id: 'mode-surface',
      version: '1.0.0',
      window: {
        title: 'Mode Test',
        icon: 'file',
        contentTag: 'r-empty-state',
        defaultWidth: 300,
        defaultHeight: 400,
        minWidth: 200,
        minHeight: 200,
        modes: ['testmode'],
      },
      moduleUrl: '/plugins/test/ui/index.js',
    }

    pluginHost.dispatch(reg)
    await new Promise(r => setTimeout(r, 50))

    const win = store.namespace<ShellState>('shell').get('windows')['mode-surface']
    expect(win).toBeDefined()
    expect(win!.isOpen).toBe(true)
  })

  test('does not open window when modes does not include currentMode', async () => {
    store.namespace<ShellState>('shell').set('currentMode', 'othermode')

    const reg: UiSurfaceRegistration = {
      id: 'no-open-surface',
      version: '1.0.0',
      window: {
        title: 'No Open',
        icon: 'file',
        contentTag: 'r-empty-state',
        defaultWidth: 300,
        defaultHeight: 400,
        minWidth: 200,
        minHeight: 200,
        modes: ['testmode'],
      },
      moduleUrl: '/plugins/test/ui/index.js',
    }

    pluginHost.dispatch(reg)
    await new Promise(r => setTimeout(r, 50))

    const win = store.namespace<ShellState>('shell').get('windows')['no-open-surface']
    expect(win).toBeDefined()
    // The window is seeded by ensureWindow but should NOT be open (isOpen
    // defaults to false for non-chat windows)
    expect(win!.isOpen).toBe(false)
  })
})

describe('pluginHost.dispatch (unregister/tombstone)', () => {
  test('removes the surface and window from registries', async () => {
    // First register
    const reg: UiSurfaceRegistration = {
      id: 'unreg-test',
      version: '1.0.0',
      window: {
        title: 'Unreg',
        icon: 'file',
        contentTag: 'r-empty-state',
        defaultWidth: 300,
        defaultHeight: 400,
        minWidth: 200,
        minHeight: 200,
      },
      moduleUrl: '/plugins/test/ui/index.js',
      frameTypes: ['testFrame'],
    }
    pluginHost.dispatch(reg)
    await new Promise(r => setTimeout(r, 50))
    expect(pluginHost.surfaces.has('unreg-test')).toBe(true)

    // Now tombstone
    pluginHost.dispatch({ id: 'unreg-test', window: null, moduleUrl: null, frameTypes: null })
    expect(pluginHost.surfaces.has('unreg-test')).toBe(false)
    expect(pluginHost.windowRegistry.has('unreg-test')).toBe(false)
  })
})

describe('pluginHost.routeFrame', () => {
  test('returns false for unclaimed frame types', () => {
    expect(pluginHost.routeFrame({ type: 'unknownFrame' })).toBe(false)
  })

  test('routes claimed frame types to the surface reducer (returns true even if import failed)', async () => {
    const reg: UiSurfaceRegistration = {
      id: 'route-test',
      version: '1.0.0',
      window: {
        title: 'Route',
        icon: 'file',
        contentTag: 'r-empty-state',
        defaultWidth: 300,
        defaultHeight: 400,
        minWidth: 200,
        minHeight: 200,
      },
      moduleUrl: '/plugins/test/ui/index.js',
      frameTypes: ['myFrame'],
    }

    pluginHost.dispatch(reg)
    await new Promise(r => setTimeout(r, 50))

    // The import fails (module doesn't exist), but frameOwners IS set
    // (the for-loop runs after the try/catch). routeFrame returns true
    // and the reducer is a no-op (surfaceReducers has no entry).
    expect(pluginHost.routeFrame({ type: 'myFrame' })).toBe(true)
  })
})

describe('pluginHost._startModeWatcher', () => {
  test('opens windows whose modes contain the new mode', async () => {
    // Start the mode watcher (normally called by init())
    ;(pluginHost as any)._startModeWatcher()

    // Register a surface with modes
    const reg: UiSurfaceRegistration = {
      id: 'watch-test',
      version: '1.0.0',
      window: {
        title: 'Watch',
        icon: 'file',
        contentTag: 'r-empty-state',
        defaultWidth: 300,
        defaultHeight: 400,
        minWidth: 200,
        minHeight: 200,
        modes: ['watchmode'],
      },
      moduleUrl: '/plugins/test/ui/index.js',
    }
    pluginHost.dispatch(reg)
    await new Promise(r => setTimeout(r, 50))

    // Change mode to 'watchmode' — the mode-watcher should open the window
    store.namespace<ShellState>('shell').set('currentMode', 'watchmode')
    await new Promise(r => setTimeout(r, 10))

    const win = store.namespace<ShellState>('shell').get('windows')['watch-test']
    expect(win).toBeDefined()
    expect(win!.isOpen).toBe(true)
  })
})
