import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mountClass, cleanup } from '../helpers/frontend.js'
import { store } from '../../frontend/webkit/runtime/store.js'
import { RAgentsList } from '../../plugins/observability/ui/r-agents-list.js'

beforeEach(cleanup)
afterEach(cleanup)

describe('r-agents-list', () => {
  test('renders empty state when no agents registered', async () => {
    store.namespace('observe').set('agents', [])
    store.namespace('shell').set('agents', [])

    const el = await mountClass(RAgentsList) as any
    await el.updateComplete

    expect(el.shadowRoot.querySelector('r-empty-state')).toBeTruthy()
  })

  test('renders agent cards when observe agents store is populated', async () => {
    store.namespace('observe').set('agents', [
      { mode: 'chatbot', displayName: 'Chatbot', shortDesc: 'Main chatbot agent', userVisible: true, model: 'claude-3-5-sonnet' },
      { mode: 'docs', displayName: 'Docs Generator', shortDesc: 'Generates documentation', userVisible: false, model: 'claude-3-5-haiku' },
    ])

    const el = await mountClass(RAgentsList) as any
    await el.updateComplete

    const cards = el.shadowRoot.querySelectorAll('.agent-card')
    expect(cards.length).toBe(2)
    expect(el.shadowRoot.textContent).toContain('Chatbot')
    expect(el.shadowRoot.textContent).toContain('Docs Generator')
    expect(el.shadowRoot.textContent).toContain('user-facing')
    expect(el.shadowRoot.textContent).toContain('internal')
  })

  test('fallbacks to shell agents store when observe agents is empty', async () => {
    store.namespace('observe').set('agents', [])
    store.namespace('shell').set('agents', [
      { mode: 'coding', displayName: 'Coding Agent', shortDesc: 'Software engineer assistant' },
    ])

    const el = await mountClass(RAgentsList) as any
    await el.updateComplete

    const cards = el.shadowRoot.querySelectorAll('.agent-card')
    expect(cards.length).toBe(1)
    expect(el.shadowRoot.textContent).toContain('Coding Agent')
  })
})
