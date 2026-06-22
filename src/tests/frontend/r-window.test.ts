import type { ShellState } from '../../frontend/types/state.js'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { RWindow } from '../../frontend/shell/r-window.js'
import { store } from '../../frontend/webkit/store.js'
import { cleanup, mountClass } from '../helpers/frontend.js'
import { pluginHost } from '../../frontend/shell/plugin-host.js'
import '../../plugins/coding/ui/r-doc-workspace.js'
import '../../plugins/workflows/ui/r-workflow-workspace.js'

const dockedWindow = (id: string, w = 460) => ({
  id,
  isOpen: true,
  isDocked: true,
  isMinimized: false,
  x: 0,
  y: 0,
  w,
  h: 600,
  zIndex: 1000,
  params: {},
})

beforeEach(() => {
  cleanup()
  localStorage.clear()
  pluginHost.windowRegistry.set('chat', {
    id: 'chat', title: 'Chat', icon: 'message-square', contentTag: 'r-chat-panel',
    defaultWidth: 320, defaultHeight: 600, minWidth: 300, minHeight: 300,
  })
  // docs and workflows are now seeded by their plugin UI modules in production,
  // but for unit tests we seed them manually (no pluginHost.init() in tests).
  pluginHost.windowRegistry.set('docs', {
    id: 'docs', title: 'Documentation', icon: 'file-text', contentTag: 'r-doc-workspace',
    dockResizable: false, defaultWidth: 500, defaultHeight: 600, minWidth: 350, minHeight: 200,
  })
  pluginHost.windowRegistry.set('workflows', {
    id: 'workflows', title: 'Workflows', icon: 'git-branch', contentTag: 'r-workflow-workspace',
    dockResizable: false, defaultWidth: 460, defaultHeight: 600, minWidth: 320, minHeight: 200,
  })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  pluginHost.windowRegistry.clear()
})

describe('r-window', () => {
  test('does not render a docked resizer for the workflows workspace', async () => {
    store.namespace<ShellState>('shell').set('windows', {
      workflows: dockedWindow('workflows'),
    })
    store.namespace<ShellState>('shell').set('activeWindowIds', ['workflows'])

    const el = await mountClass(RWindow, { windowId: 'workflows' }) as RWindow
    await el.updateComplete

    expect(el.querySelector('.r-window-resizer')).toBeNull()
    expect(el.querySelector('r-workflow-workspace')).toBeTruthy()
  })

  test('does not render a docked resizer for the docs workspace', async () => {
    store.namespace<ShellState>('shell').set('windows', {
      docs: dockedWindow('docs', 500),
    })
    store.namespace<ShellState>('shell').set('activeWindowIds', ['docs'])

    const el = await mountClass(RWindow, { windowId: 'docs' }) as RWindow
    await el.updateComplete

    expect(el.querySelector('.r-window-resizer')).toBeNull()
    expect(el.querySelector('r-doc-workspace')).toBeTruthy()
  })

  test('still renders the docked resizer for chat', async () => {
    store.namespace<ShellState>('shell').set('windows', {
      chat: dockedWindow('chat', 320),
    })
    store.namespace<ShellState>('shell').set('activeWindowIds', ['chat'])

    const chat = await mountClass(RWindow, { windowId: 'chat' }) as RWindow
    await chat.updateComplete

    expect(chat.querySelector('.r-window-resizer.resizer-right')).toBeTruthy()
  })
})
