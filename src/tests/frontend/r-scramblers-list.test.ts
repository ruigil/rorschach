import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mountClass, cleanup } from '../helpers/frontend.js'
import { store } from '../../frontend/webkit/runtime/store.js'
import { RScramblersList } from '../../plugins/observability/ui/r-scramblers-list.js'

beforeEach(cleanup)
afterEach(cleanup)

describe('r-scramblers-list', () => {
  test('renders empty state when no scramblers registered', async () => {
    store.namespace('observe').set('scramblers', {})

    const el = await mountClass(RScramblersList) as any
    await el.updateComplete

    expect(el.shadowRoot.querySelector('r-empty-state')).toBeTruthy()
  })

  test('renders scrambler cards when scramblers store is populated', async () => {
    store.namespace('observe').set('scramblers', {
      'scr:leaf:test.summarizer': {
        urn: 'scr:leaf:test.summarizer',
        kind: 'leaf',
        description: 'Summarizes text inputs',
        schema: {
          inputSchema: { type: 'string' },
          outputSchema: { type: 'string' }
        },
        tags: ['nlp', 'utility'],
        yieldsPending: false
      },
      'scr:reasoner:test.planner': {
        urn: 'scr:reasoner:test.planner',
        kind: 'reasoner',
        description: 'Thinks before acting',
        schema: {},
        tags: ['planning'],
        yieldsPending: true
      }
    })

    const el = await mountClass(RScramblersList) as any
    await el.updateComplete

    const cards = el.shadowRoot.querySelectorAll('.scrambler-card')
    expect(cards.length).toBe(2)

    const textContent = el.shadowRoot.textContent
    expect(textContent).toContain('scr:leaf:test.summarizer')
    expect(textContent).toContain('scr:reasoner:test.planner')
    expect(textContent).toContain('Summarizes text inputs')
    expect(textContent).toContain('Thinks before acting')
    expect(textContent).toContain('yields-pending')
    expect(textContent).toContain('nlp')
    expect(textContent).toContain('utility')
    expect(textContent).toContain('planning')

    // Expect schema details element to be present since test.summarizer has a schema
    const details = el.shadowRoot.querySelector('details')
    expect(details).toBeTruthy()
  })
})
