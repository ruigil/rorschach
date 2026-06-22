import { describe, test, expect, beforeEach, afterEach } from 'bun:test'

import { mountClass, cleanup, mockStore } from '../helpers/frontend.js'
import { RMessageBubble } from '../../frontend/webkit/r-message-bubble.js'

beforeEach(cleanup)
afterEach(cleanup)

describe('r-message-bubble', () => {
  test('renders user message', async () => {
    mockStore('currentMode', 'chatbot')
    const el = await mountClass(RMessageBubble) as any
    el.message = { id: '1', role: 'user', text: 'hello', timestamp: Date.now() }
    await el.updateComplete

    expect(el.textContent).toContain('You')
    expect(el.textContent).toContain('hello')
  })

  test('renders assistant message', async () => {
    mockStore('currentMode', 'chatbot')
    const el = await mountClass(RMessageBubble) as any
    el.message = { id: '2', role: 'assistant', text: 'hi there', timestamp: Date.now() }
    await el.updateComplete

    expect(el.textContent).toContain('Rorschach')
    expect(el.textContent).toContain('hi there')
  })

  test('renders error message', async () => {
    mockStore('currentMode', 'chatbot')
    const el = await mountClass(RMessageBubble) as any
    el.type = 'error'
    el.message = { id: '3', role: 'error', text: 'something went wrong', timestamp: Date.now() }
    await el.updateComplete

    expect(el.textContent).toContain('Error')
    expect(el.textContent).toContain('something went wrong')
  })

  test('shows mode suffix for non-chatbot modes', async () => {
    mockStore('currentMode', 'planner')
    const el = await mountClass(RMessageBubble) as any
    el.message = { id: '4', role: 'assistant', text: 'plan', timestamp: Date.now() }
    await el.updateComplete

    expect(el.textContent).toContain('[Planner]')
  })

  test('renders reasoning in details element', async () => {
    mockStore('currentMode', 'chatbot')
    const el = await mountClass(RMessageBubble) as any
    el.message = {
      id: '5', role: 'assistant', text: 'answer', timestamp: Date.now(),
      reasoning: 'let me think...',
    }
    await el.updateComplete

    const details = el.querySelector('details')
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

    const sourcesList = el.querySelector('r-sources-list')
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

    const att = el.querySelector('r-attachments')
    expect(att).toBeTruthy()
    expect(att.items).toHaveLength(1)
  })
})
