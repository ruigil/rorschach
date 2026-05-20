import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mountClass, cleanup, mockStore } from '../helpers/frontend.js'
import { RChatInput } from '../../frontend/components/r-chat-input.js'
import '../../frontend/components/r-media-previews.js'

beforeEach(cleanup)
afterEach(cleanup)

describe('r-chat-input', () => {
  test('renders textarea and buttons', async () => {
    mockStore('isConnected', true)
    const el = await mountClass(RChatInput) as any
    await el.updateComplete

    expect(el.querySelector('#input')).toBeTruthy()
    expect(el.querySelector('#send')).toBeTruthy()
    expect(el.querySelector('#attach-btn')).toBeTruthy()
    expect(el.querySelector('#mic-btn')).toBeTruthy()
  })

  test('dispatches chat-submit on Enter', async () => {
    mockStore('isConnected', true)
    const el = await mountClass(RChatInput) as any
    await el.updateComplete

    const textarea = el.querySelector('#input') as HTMLTextAreaElement
    textarea.value = 'hello world'

    const events: any[] = []
    el.addEventListener('chat-submit', (e: any) => events.push(e.detail))

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(events.length).toBe(1)
    expect(events[0].text).toBe('hello world')
  })

  test('does not dispatch on Shift+Enter', async () => {
    mockStore('isConnected', true)
    const el = await mountClass(RChatInput) as any
    await el.updateComplete

    const textarea = el.querySelector('#input') as HTMLTextAreaElement
    textarea.value = 'hello'

    let fired = false
    el.addEventListener('chat-submit', () => fired = true)

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))

    expect(fired).toBe(false)
  })

  test('does not dispatch when empty', async () => {
    mockStore('isConnected', true)
    const el = await mountClass(RChatInput) as any
    await el.updateComplete

    const textarea = el.querySelector('#input') as HTMLTextAreaElement
    textarea.value = '   '

    let fired = false
    el.addEventListener('chat-submit', () => fired = true)

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(fired).toBe(false)
  })

  test('textarea is disabled when not connected', async () => {
    mockStore('isConnected', false)
    const el = await mountClass(RChatInput) as any
    await el.updateComplete

    const textarea = el.querySelector('#input') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
  })

  test('textarea is disabled when waiting', async () => {
    mockStore('isConnected', true)
    mockStore('isWaiting', true)
    const el = await mountClass(RChatInput) as any
    await el.updateComplete

    const textarea = el.querySelector('#input') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
  })

  test('send button is disabled when not connected', async () => {
    mockStore('isConnected', false)
    const el = await mountClass(RChatInput) as any
    await el.updateComplete

    const sendBtn = el.querySelector('#send') as HTMLButtonElement
    expect(sendBtn.disabled).toBe(true)
  })

  test('clears textarea after submit', async () => {
    mockStore('isConnected', true)
    const el = await mountClass(RChatInput) as any
    await el.updateComplete

    const textarea = el.querySelector('#input') as HTMLTextAreaElement
    textarea.value = 'test message'

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(textarea.value).toBe('')
  })
})
