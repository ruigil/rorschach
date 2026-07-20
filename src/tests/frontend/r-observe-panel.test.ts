import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mountClass, cleanup } from '../helpers/frontend.js'
import { store } from '../../frontend/webkit/runtime/store.js'
import { RObservePanel } from '../../plugins/observability/ui/r-observe-panel.js'

beforeEach(cleanup)
afterEach(cleanup)

describe('r-observe-panel', () => {
  test('renders observability workspace layout with left sidebar tree and main panel', async () => {
    const el = await mountClass(RObservePanel) as any
    await el.updateComplete

    const sidebar = el.shadowRoot.querySelector('.ws-sidebar') || el.shadowRoot.querySelector('.obs-sidebar')
    const main = el.shadowRoot.querySelector('.ws-main') || el.shadowRoot.querySelector('.obs-main')
    const tree = el.shadowRoot.querySelector('r-tree')

    expect(sidebar).toBeTruthy()
    expect(main).toBeTruthy()
    expect(tree).toBeTruthy()
    expect(el.shadowRoot.textContent).toContain('Observability')
  })

  test('populates tree badges reactively from store state', async () => {
    store.namespace('observe').set('actors', [{ name: 'actor-1' }, { name: 'actor-2' }] as any)
    store.namespace('observe').set('logs', [{ message: 'log-1' }] as any)

    const el = await mountClass(RObservePanel) as any
    await el.updateComplete

    const tree = el.shadowRoot.querySelector('r-tree') as any
    expect(tree).toBeTruthy()
    expect(tree.data).toBeTruthy()

    const telemetryCat = tree.data.find((node: any) => node.id === 'cat-telemetry')
    expect(telemetryCat).toBeTruthy()

    const metricsNode = telemetryCat.children.find((c: any) => c.id === 'metrics')
    const logsNode = telemetryCat.children.find((c: any) => c.id === 'logs')

    expect(metricsNode.badge).toBe(2)
    expect(logsNode.badge).toBe(1)
  })

  test('switches active subpanel when a valid tree node is selected', async () => {
    const el = await mountClass(RObservePanel) as any
    await el.updateComplete

    const tree = el.shadowRoot.querySelector('r-tree') as any
    tree.dispatchEvent(new CustomEvent('node-select', {
      bubbles: true,
      composed: true,
      detail: { node: { id: 'logs', label: 'Logs' } },
    }))

    await el.updateComplete

    expect(store.namespace('observe').get('activeTab')).toBe('logs')
    const activeSubpanel = el.shadowRoot.querySelector('.obs-subpanel.active')
    expect(activeSubpanel.getAttribute('data-observe-tab')).toBe('logs')

    const activePill = el.shadowRoot.querySelector('.ws-title-active') || el.shadowRoot.querySelector('.obs-title-active')
    expect(activePill).toBeTruthy()
    expect(activePill.textContent).toBe('Logs')
  })
})
