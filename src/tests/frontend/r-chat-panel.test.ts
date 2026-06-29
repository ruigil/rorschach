import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mountClass, cleanup, mockStore } from '../helpers/frontend.js'
import { RChatPanel } from '../../frontend/shell/r-chat-panel.js'
import '../../frontend/webkit/r-message-bubble.js'
import '../../frontend/shell/r-chat-input.js'
import '../../frontend/webkit/r-empty-state.js'

beforeEach(() => {
  cleanup()
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('r-chat-panel', () => {
  test('renders messages and input footer', async () => {
    mockStore('isConnected', true)
    mockStore('messages', [
      { id: '1', role: 'user', text: 'hello', timestamp: Date.now() },
      { id: '2', role: 'assistant', text: 'hi', timestamp: Date.now() }
    ])
    mockStore('activeStream', { isActive: false, text: '' })
    mockStore('windows', { chat: {} })
    
    const el = await mountClass(RChatPanel) as any
    await el.updateComplete

    expect(el.querySelector('.chat-main')).toBeTruthy()
    expect(el.querySelector('.chat-window-content')).toBeTruthy()
    expect(el.querySelector('.chat-window-footer')).toBeTruthy()
    expect(el.querySelector('r-chat-input')).toBeTruthy()

    // Shows all messages
    const bubbles = el.querySelectorAll('r-message-bubble')
    expect(bubbles.length).toBe(2)
    expect(bubbles[0].message.text).toBe('hello')
    expect(bubbles[1].message.text).toBe('hi')
  })

  test('renders empty state when there are no messages', async () => {
    mockStore('isConnected', true)
    mockStore('messages', [])
    mockStore('activeStream', { isActive: false, text: '' })
    
    const el = await mountClass(RChatPanel) as any
    await el.updateComplete

    expect(el.querySelector('r-empty-state')).toBeTruthy()
    expect(el.querySelector('r-empty-state').getAttribute('text')).toBe('Signal detected')
  })

  test('renders active stream when active', async () => {
    mockStore('isConnected', true)
    mockStore('messages', [])
    mockStore('activeStream', { isActive: true, text: 'typing...' })
    
    const el = await mountClass(RChatPanel) as any
    await el.updateComplete

    const bubbles = el.querySelectorAll('r-message-bubble')
    expect(bubbles.length).toBe(1)
    expect(bubbles[0].stream.text).toBe('typing...')
  })
})
