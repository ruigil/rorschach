import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mountClass, cleanup, mockStore } from '../helpers/frontend.js'
import { RModeSelect } from '../../frontend/shell/r-mode-select.js'

beforeEach(cleanup)
afterEach(cleanup)

describe('r-mode-select', () => {
  test('renders loading state when no agents', async () => {
    mockStore('agents', [])
    mockStore('currentMode', '')
    mockStore('isConnected', true)
    const el = await mountClass(RModeSelect) as any
    await el.updateComplete

    const select = el.querySelector('#mode-select') as HTMLSelectElement
    expect(select).toBeTruthy()
    expect(select.disabled).toBe(true)
    expect(select.textContent).toContain('loading')
  })

  test('renders single agent from currentMode fallback', async () => {
    mockStore('agents', [])
    mockStore('currentMode', 'chatbot')
    mockStore('currentModeDisplayName', 'Chatbot')
    mockStore('isConnected', true)
    const el = await mountClass(RModeSelect) as any
    await el.updateComplete

    const select = el.querySelector('#mode-select') as HTMLSelectElement
    expect(select.options.length).toBe(1)
    expect(select.options[0]!.textContent!.trim()).toBe('Chatbot')
  })

  test('renders multiple agents', async () => {
    mockStore('agents', [
      { mode: 'chatbot', displayName: 'Chatbot', shortDesc: '' },
      { mode: 'planner', displayName: 'Planner', shortDesc: '' },
    ])
    mockStore('currentMode', 'chatbot')
    mockStore('isConnected', true)
    const el = await mountClass(RModeSelect) as any
    await el.updateComplete

    const select = el.querySelector('#mode-select') as HTMLSelectElement
    expect(select.options.length).toBe(2)
    expect(select.options[0]!.textContent.trim()).toBe('Chatbot')
    expect(select.options[1]!.textContent.trim()).toBe('Planner')
  })

  test('updates select value when currentMode changes', async () => {
    mockStore('agents', [
      { mode: 'chatbot', displayName: 'Chatbot', shortDesc: '' },
      { mode: 'workflows', displayName: 'Workflows', shortDesc: '' },
    ])
    mockStore('currentMode', 'chatbot')
    mockStore('isConnected', true)
    const el = await mountClass(RModeSelect) as any
    await el.updateComplete

    const select = el.querySelector('#mode-select') as HTMLSelectElement
    expect(select.value).toBe('chatbot')

    mockStore('currentMode', 'workflows')
    await el.updateComplete
    expect(select.value).toBe('workflows')
  })

  test('select is disabled when disconnected', async () => {
    mockStore('agents', [
      { mode: 'chatbot', displayName: 'Chatbot', shortDesc: '' },
      { mode: 'planner', displayName: 'Planner', shortDesc: '' },
    ])
    mockStore('currentMode', 'chatbot')
    mockStore('isConnected', false)
    const el = await mountClass(RModeSelect) as any
    await el.updateComplete

    const select = el.querySelector('#mode-select') as HTMLSelectElement
    expect(select.disabled).toBe(true)
  })

  test('select is disabled when fewer than 2 agents', async () => {
    mockStore('agents', [
      { mode: 'chatbot', displayName: 'Chatbot', shortDesc: '' },
    ])
    mockStore('currentMode', 'chatbot')
    mockStore('isConnected', true)
    const el = await mountClass(RModeSelect) as any
    await el.updateComplete

    const select = el.querySelector('#mode-select') as HTMLSelectElement
    expect(select.disabled).toBe(true)
  })
})
