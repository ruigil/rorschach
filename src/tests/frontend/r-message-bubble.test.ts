import { describe, test, expect, beforeEach, afterEach } from 'bun:test'

import { mountClass, cleanup, mockStore } from '../helpers/frontend.js'
import { RMessageBubble } from '../../frontend/shell/r-message-bubble.js'

beforeEach(cleanup)
afterEach(cleanup)

describe('r-message-bubble', () => {
  test('renders user message', async () => {
    mockStore('currentMode', 'chatbot')
    const el = await mountClass(RMessageBubble) as any
    el.message = { id: '1', role: 'user', text: 'hello', timestamp: Date.now() }
    await el.updateComplete

    const markdown = el.shadowRoot.querySelector('r-markdown')
    expect(markdown.shadowRoot.textContent).toContain('hello')
    expect(el.getAttribute('type')).toBe('user')
  })

  test('renders assistant message', async () => {
    mockStore('currentMode', 'chatbot')
    const el = await mountClass(RMessageBubble) as any
    el.message = { id: '2', role: 'assistant', text: 'hi there', timestamp: Date.now() }
    await el.updateComplete

    const markdown = el.shadowRoot.querySelector('r-markdown')
    expect(markdown.shadowRoot.textContent).toContain('hi there')
    expect(el.getAttribute('type')).toBe('assistant')
  })

  test('renders error message', async () => {
    mockStore('currentMode', 'chatbot')
    const el = await mountClass(RMessageBubble) as any
    el.type = 'error'
    el.message = { id: '3', role: 'error', text: 'something went wrong', timestamp: Date.now() }
    await el.updateComplete

    const markdown = el.shadowRoot.querySelector('r-markdown')
    expect(markdown.shadowRoot.textContent).toContain('something went wrong')
    expect(el.getAttribute('type')).toBe('error')
  })

  test('renders reasoning in details element', async () => {
    mockStore('currentMode', 'chatbot')
    const el = await mountClass(RMessageBubble) as any
    el.message = {
      id: '5', role: 'assistant', text: 'answer', timestamp: Date.now(),
      reasoning: 'let me think...',
    }
    await el.updateComplete

    const details = el.shadowRoot.querySelector('details')
    expect(details).toBeTruthy()
    expect(details!.textContent).toContain('let me think...')
  })

  test('renders sources when present', async () => {
    mockStore('currentMode', 'chatbot')
    const el = await mountClass(RMessageBubble) as any
    el.message = {
      id: '6', role: 'assistant', text: 'answer', timestamp: Date.now(),
      sources: [{ url: 'http://example.com', title: 'Example' }],
    }
    await el.updateComplete

    const sourcesList = el.shadowRoot.querySelector('r-sources-list')
    expect(sourcesList).toBeTruthy()
    expect(sourcesList.sources).toHaveLength(1)
  })

  test('renders attachments when present', async () => {
    mockStore('currentMode', 'chatbot')
    const el = await mountClass(RMessageBubble) as any
    el.message = {
      id: '7', role: 'assistant', text: 'look', timestamp: Date.now(),
      attachments: [{ kind: 'image', data: 'data:img' }],
    }
    await el.updateComplete

    const att = el.shadowRoot.querySelector('r-attachments')
    expect(att).toBeTruthy()
    expect(att.items).toHaveLength(1)
  })

  test('renders toolCalls in r-tool-history when present on message', async () => {
    mockStore('currentMode', 'chatbot')
    const el = await mountClass(RMessageBubble) as any
    el.message = {
      id: '8',
      role: 'assistant',
      text: 'result',
      timestamp: Date.now(),
      toolCalls: [{ name: 'web_search', arguments: '{"q":"test"}' }],
    }
    await el.updateComplete

    const toolHistory = el.shadowRoot.querySelector('r-tool-history')
    expect(toolHistory).toBeTruthy()
    expect(toolHistory.tools).toHaveLength(1)
  })

  test('renders toolCalls in r-tool-history when streaming', async () => {
    mockStore('currentMode', 'chatbot')
    const el = await mountClass(RMessageBubble) as any
    el.stream = {
      isActive: true,
      text: 'in progress',
      reasoning: '',
      sources: [],
      attachments: [],
      toolCalls: [{ name: 'web_search', arguments: '{"q":"test"}' }],
    }
    await el.updateComplete

    const toolHistory = el.shadowRoot.querySelector('r-tool-history')
    expect(toolHistory).toBeTruthy()
    expect(toolHistory.tools).toHaveLength(1)
    expect(toolHistory.hasAttribute('active')).toBe(true)
  })
})
