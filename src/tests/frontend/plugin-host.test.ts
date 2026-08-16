import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { store, __resetStoreForTests } from '../../frontend/webkit/runtime/store.js'
import { pluginHost, __resetPluginHostForTests } from '../../frontend/shell/plugin-host.js'
import type { ShellState } from '../../frontend/shell/types.js'
import type { UiSurfaceRegistration } from '../../types/ui-surface.js'

beforeEach(() => {
  __resetStoreForTests()
  __resetPluginHostForTests()
  localStorage.clear()
  store.namespace<ShellState>('shell').init({
    isConnected: false,
    isWaiting: false,
    currentUserId: null,
    currentUserRoles: [],
    messages: [],
    lastMessages: [],
    activeStream: { isActive: false, reasoning: '', text: '', sources: [], attachments: [], toolCalls: [] },
    views: {},
    activeWorkspaceTab: 'none',
    workspaceTabOrder: [],
  })
})

afterEach(() => {
  __resetStoreForTests()
  __resetPluginHostForTests()
  localStorage.clear()
})

describe('pluginHost.dispatch (register)', () => {
  test('registers a view in the registry', async () => {
    const reg: UiSurfaceRegistration = {
      id: 'test-surface',
      version: '1.0.0',
      view: {
        title: 'Test',
        icon: 'file',
        contentTag: 'r-empty-state',
      },
      moduleUrl: '/js/plugins/test.js',
    }

    // Mock dynamic import — the module doesn't exist, so it will fail
    // gracefully and swap to r-surface-error
    const p = pluginHost()
    p.dispatch(reg)
    // Wait for the async _register to complete
    await new Promise(r => setTimeout(r, 50))

    expect(p.getViewConfig('test-surface')).toBeDefined()
    expect(p.getViewConfig('test-surface')!.title).toBe('Test')
  })
})

describe('pluginHost.dispatch (unregister/tombstone)', () => {
  test('removes the surface and view from registries', async () => {
    // First register
    const reg: UiSurfaceRegistration = {
      id: 'unreg-test',
      version: '1.0.0',
      view: {
        title: 'Unreg',
        icon: 'file',
        contentTag: 'r-empty-state',
      },
      moduleUrl: '/js/plugins/test.js',
      frameTypes: ['testFrame'],
    }
    const ph = pluginHost()
    ph.dispatch(reg)
    await new Promise(r => setTimeout(r, 50))

    // Now tombstone
    ph.dispatch({ id: 'unreg-test', view: null, moduleUrl: null, frameTypes: null })
    expect(ph.getViewConfig('unreg-test')).toBeUndefined()
  })
})

describe('pluginHost.routeFrame', () => {
  test('returns false for unclaimed frame types', () => {
    expect(pluginHost().routeFrame({ type: 'unknownFrame' })).toBe(false)
  })

  test('routes claimed frame types to the surface reducer (returns true even if import failed)', async () => {
    const reg: UiSurfaceRegistration = {
      id: 'route-test',
      version: '1.0.0',
      view: {
        title: 'Route',
        icon: 'file',
        contentTag: 'r-empty-state',
      },
      moduleUrl: '/js/plugins/test.js',
      frameTypes: ['myFrame'],
    }
    const ph = pluginHost()
    ph.dispatch(reg)
    await new Promise(r => setTimeout(r, 50))

    // The import fails (module doesn't exist), but frameOwners IS set
    // (the for-loop runs after the try/catch). routeFrame returns true
    // and the reducer is a no-op (surfaceReducers has no entry).
    expect(ph.routeFrame({ type: 'myFrame' })).toBe(true)
  })
})

