import type { ShellState } from '../../frontend/types/state.js'
import { describe, test, expect, beforeEach } from 'bun:test'

import { store } from '../../frontend/webkit/store.js'
import { resetStore } from '../helpers/frontend.js'
import { setMode, setActiveWorkspaceTab, updateViewState } from '../../frontend/shell/view-actions.js'
import {
  addLog,
  appendMessage,
  updateActiveStream,
  commitActiveStream,
} from '../../frontend/shell/actions.js'

beforeEach(() => {
  localStorage.clear()
  resetStore()
})

describe('setMode', () => {
  test('sets currentMode in store', () => {
    setMode('planner')
    expect(store.namespace<ShellState>('shell').get('currentMode')).toBe('planner')
  })

  test('sets displayName from argument', () => {
    setMode('planner', 'Planner Mode')
    expect(store.namespace<ShellState>('shell').get('currentModeDisplayName')).toBe('Planner Mode')
  })

  test('derives displayName from mode when not provided', () => {
    setMode('chatbot')
    expect(store.namespace<ShellState>('shell').get('currentModeDisplayName')).toBe('Chatbot')
  })

  test('clears isWaiting', () => {
    store.namespace<ShellState>('shell').set('isWaiting', true)
    setMode('chatbot')
    expect(store.namespace<ShellState>('shell').get('isWaiting')).toBe(false)
  })

  test('persists mode to localStorage', () => {
    setMode('planner')
    expect(localStorage.getItem('rorschach.store.shell.currentMode')).toBe(JSON.stringify('planner'))
  })
})

describe('addLog', () => {
  test('prepends log to logs array', () => {
    addLog({ message: 'first' })
    addLog({ message: 'second' })
    const logs = store.namespace<ShellState>('shell').get('logs')
    expect(logs[0]!.message).toBe('second')
    expect(logs[1]!.message).toBe('first')
  })

  test('caps logs at 500 entries', () => {
    for (let i = 0; i < 510; i++) {
      addLog({ message: `log-${i}` })
    }
    expect(store.namespace<ShellState>('shell').get('logs').length).toBe(500)
    expect(store.namespace<ShellState>('shell').get('logs')[0]!.message).toBe('log-509')
  })
})

describe('appendMessage', () => {
  test('appends message to messages array', () => {
    appendMessage({ id: '1', role: 'user', text: 'hello', timestamp: Date.now() })
    appendMessage({ id: '2', role: 'assistant', text: 'hi', timestamp: Date.now() })
    const msgs = store.namespace<ShellState>('shell').get('messages')
    expect(msgs.length).toBe(2)
    expect(msgs[0]!.text).toBe('hello')
    expect(msgs[1]!.text).toBe('hi')
  })

  test('persists last 10 messages to localStorage', () => {
    for (let i = 0; i < 15; i++) {
      appendMessage({ id: String(i), role: 'user', text: `msg-${i}`, timestamp: Date.now() })
    }
    const stored = JSON.parse(localStorage.getItem('rorschach.store.shell.lastMessages')!)
    expect(stored.length).toBe(10)
    expect(stored[0].text).toBe('msg-5')
    expect(stored[9].text).toBe('msg-14')
  })

  test('persists attachment metadata without payload data', () => {
    appendMessage({
      id: '1',
      role: 'user',
      text: 'with attachment',
      attachments: [
        { kind: 'image', data: 'data:image/png;base64,large', url: 'blob:local', name: 'screen.png' },
      ],
      timestamp: Date.now(),
    })

    const stored = JSON.parse(localStorage.getItem('rorschach.store.shell.lastMessages')!)
    expect(stored[0].attachments).toEqual([{ kind: 'image', name: 'screen.png' }])
    expect(store.namespace<ShellState>('shell').get('messages')[0]!.attachments![0]!.data).toBe('data:image/png;base64,large')
  })
})

describe('updateActiveStream', () => {
  test('patches activeStream properties', () => {
    updateActiveStream({ isActive: true, text: 'hello' })
    const stream = store.namespace<ShellState>('shell').get('activeStream')
    expect(stream.isActive).toBe(true)
    expect(stream.text).toBe('hello')
    expect(stream.reasoning).toBe('')
  })

  test('preserves unpatched properties', () => {
    updateActiveStream({ text: 'first' })
    updateActiveStream({ reasoning: 'thinking' })
    const stream = store.namespace<ShellState>('shell').get('activeStream')
    expect(stream.text).toBe('first')
    expect(stream.reasoning).toBe('thinking')
  })
})

describe('commitActiveStream', () => {
  test('creates assistant message from active stream', () => {
    updateActiveStream({ isActive: true, text: 'response', reasoning: 'thought' })
    commitActiveStream()
    const msgs = store.namespace<ShellState>('shell').get('messages')
    expect(msgs.length).toBe(1)
    expect(msgs[0]!.role).toBe('assistant')
    expect(msgs[0]!.text).toBe('response')
    expect(msgs[0]!.reasoning).toBe('thought')
  })

  test('resets activeStream after commit', () => {
    updateActiveStream({ isActive: true, text: 'data' })
    commitActiveStream()
    const stream = store.namespace<ShellState>('shell').get('activeStream')
    expect(stream.isActive).toBe(false)
    expect(stream.text).toBe('')
    expect(stream.reasoning).toBe('')
  })

  test('clears isWaiting after commit', () => {
    store.namespace<ShellState>('shell').set('isWaiting', true)
    updateActiveStream({ text: 'x' })
    commitActiveStream()
    expect(store.namespace<ShellState>('shell').get('isWaiting')).toBe(false)
  })

  test('commits as error role with override text', () => {
    updateActiveStream({ text: 'partial' })
    commitActiveStream('error', 'something broke')
    const msgs = store.namespace<ShellState>('shell').get('messages')
    expect(msgs[0]!.role).toBe('error')
    expect(msgs[0]!.text).toBe('something broke')
  })

  test('copies sources and attachments', () => {
    updateActiveStream({
      sources: [{ url: 'http://x.com', title: 'X' }],
      attachments: [{ kind: 'image', data: 'data:img' }],
    })
    commitActiveStream()
    const msg = store.namespace<ShellState>('shell').get('messages')[0]!
    expect(msg.sources).toHaveLength(1)
    expect(msg.sources![0]!.url).toBe('http://x.com')
    expect(msg.attachments).toHaveLength(1)
    expect(msg.attachments![0]!.kind).toBe('image')
  })
})

describe('view state actions', () => {
  test('setActiveWorkspaceTab updates store and localStorage', () => {
    setActiveWorkspaceTab('plans')

    expect(store.namespace<ShellState>('shell').get('activeWorkspaceTab')).toBe('plans')
    expect(localStorage.getItem('rorschach.store.shell.activeWorkspaceTab')).toBe(JSON.stringify('plans'))
  })

  test('updateViewState updates and persists the target view', () => {
    store.namespace<ShellState>('shell').set('views', {
      docs: {
        id: 'docs',
        isOpen: true,
        params: {},
      },
    })

    expect(updateViewState('docs', { params: { docId: 42 } })).toBe(true)

    const view = store.namespace<ShellState>('shell').get('views').docs!
    expect(view.params.docId).toBe(42)

    const stored = JSON.parse(localStorage.getItem('rorschach.view_state.docs')!)
    expect(stored.params.docId).toBe(42)
  })

})
