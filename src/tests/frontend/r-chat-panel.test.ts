import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mountClass, cleanup, mockStore } from '../helpers/frontend.js'
import { RChatPanel } from '../../frontend/components/r-chat-panel.js'
import '../../frontend/components/r-message-bubble.js'
import '../../frontend/components/r-chat-input.js'
import '../../frontend/components/r-media-previews.js'
import '../../frontend/components/r-empty-state.js'

beforeEach(() => {
  cleanup()
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('r-chat-panel', () => {
  test('renders header, content, and footer in docked mode', async () => {
    mockStore('isConnected', true)
    mockStore('messages', [
      { id: '1', role: 'user', text: 'hello', timestamp: Date.now() },
      { id: '2', role: 'assistant', text: 'hi', timestamp: Date.now() }
    ])
    
    const el = await mountClass(RChatPanel) as any
    await el.updateComplete

    expect(el.querySelector('.chat-window-header')).toBeTruthy()
    expect(el.querySelector('.chat-window-content')).toBeTruthy()
    expect(el.querySelector('.chat-window-footer')).toBeTruthy()
    
    // Header should say "Chat" when docked
    expect(el.querySelector('.chat-window-status').textContent.trim()).toBe('Chat')

    // Docked mode shows all messages
    const bubbles = el.querySelectorAll('r-message-bubble')
    expect(bubbles.length).toBe(2)
  })

  test('toggles undocked mode and updates elements', async () => {
    mockStore('isConnected', true)
    mockStore('messages', [
      { id: '1', role: 'user', text: 'user msg 1', timestamp: Date.now() },
      { id: '2', role: 'assistant', text: 'bot msg 1', timestamp: Date.now() },
      { id: '3', role: 'user', text: 'user msg 2', timestamp: Date.now() },
      { id: '4', role: 'assistant', text: 'bot msg 2', timestamp: Date.now() }
    ])

    const el = await mountClass(RChatPanel) as any
    await el.updateComplete

    // Docked shows all 4 messages
    expect(el.querySelectorAll('r-message-bubble').length).toBe(4)

    // Trigger undock
    const dockBtn = el.querySelector('.dock-btn')
    expect(dockBtn).toBeTruthy()
    dockBtn.click()
    await el.updateComplete

    // Should have "undocked" class
    expect(el.classList.contains('undocked')).toBe(true)
    expect(el.querySelector('.chat-window-status').textContent.trim()).toBe('Mini Chat')

    // Undocked mode only shows the last user message and the last assistant message (2 messages total)
    const bubbles = el.querySelectorAll('r-message-bubble')
    expect(bubbles.length).toBe(2)
    
    // Bubble contents should match the last pair
    expect(bubbles[0].message.text).toBe('user msg 2')
    expect(bubbles[1].message.text).toBe('bot msg 2')
  })

  test('shows simplified empty state when undocked and empty', async () => {
    mockStore('isConnected', true)
    mockStore('messages', [])

    const el = await mountClass(RChatPanel) as any
    await el.updateComplete

    // Toggle undock
    el.querySelector('.dock-btn').click()
    await el.updateComplete

    // Check simplified empty state is rendered
    expect(el.querySelector('.mini-empty-state')).toBeTruthy()
    expect(el.querySelector('.mini-empty-state').textContent).toContain('Awaiting transmission')
  })

  test('collapse toggle hides content but keeps header and footer visible', async () => {
    mockStore('isConnected', true)
    mockStore('messages', [
      { id: '1', role: 'user', text: 'hello', timestamp: Date.now() }
    ])

    const el = await mountClass(RChatPanel) as any
    await el.updateComplete

    // Toggle undock
    el.querySelector('.dock-btn').click()
    await el.updateComplete

    // Ensure content is visible initially
    expect(el.querySelector('.chat-window-content').hasAttribute('hidden')).toBe(false)

    // Trigger collapse
    const collapseBtn = el.querySelector('.collapse-btn')
    expect(collapseBtn).toBeTruthy()
    collapseBtn.click()
    await el.updateComplete

    // Class "collapsed" should be added to the host
    expect(el.classList.contains('collapsed')).toBe(true)

    // Content should now be hidden
    expect(el.querySelector('.chat-window-content').hasAttribute('hidden')).toBe(true)

    // Header and footer must still be present
    expect(el.querySelector('.chat-window-header')).toBeTruthy()
    expect(el.querySelector('.chat-window-footer')).toBeTruthy()
  })
})
