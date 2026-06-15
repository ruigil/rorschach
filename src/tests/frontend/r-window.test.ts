import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { RWindow } from '../../frontend/components/r-window.js'
import { store } from '../../frontend/store.js'
import { cleanup, mountClass } from '../helpers/frontend.js'

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
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('r-window', () => {
  test('does not render a docked resizer for the workflows workspace', async () => {
    store.set('windows', {
      workflows: dockedWindow('workflows'),
    })
    store.set('activeWindowIds', ['workflows'])

    const el = await mountClass(RWindow, { windowId: 'workflows' }) as RWindow
    await el.updateComplete

    expect(el.querySelector('.r-window-resizer')).toBeNull()
    expect(el.querySelector('r-workflow-workspace')).toBeTruthy()
  })

  test('does not render a docked resizer for the docs workspace', async () => {
    store.set('windows', {
      docs: dockedWindow('docs', 500),
    })
    store.set('activeWindowIds', ['docs'])

    const el = await mountClass(RWindow, { windowId: 'docs' }) as RWindow
    await el.updateComplete

    expect(el.querySelector('.r-window-resizer')).toBeNull()
    expect(el.querySelector('r-doc-workspace')).toBeTruthy()
  })

  test('still renders the docked resizer for chat', async () => {
    store.set('windows', {
      chat: dockedWindow('chat', 320),
    })
    store.set('activeWindowIds', ['chat'])

    const chat = await mountClass(RWindow, { windowId: 'chat' }) as RWindow
    await chat.updateComplete

    expect(chat.querySelector('.r-window-resizer.resizer-right')).toBeTruthy()
  })
})
