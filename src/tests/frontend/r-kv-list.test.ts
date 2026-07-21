import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mountClass, cleanup } from '../helpers/frontend.js'
import { RKVList } from '../../frontend/webkit/r-kv-list.js'

beforeEach(cleanup)
afterEach(cleanup)

describe('r-kv-list', () => {
  test('renders list items with accent-styled keys', async () => {
    const el = await mountClass(RKVList) as RKVList
    el.items = [
      { key: 'status', label: 'Status', value: 'Active' },
      { key: 'count', value: 42 },
    ]
    await el.updateComplete

    const keys = el.shadowRoot!.querySelectorAll('.kv-key')
    expect(keys.length).toBe(2)
    expect(keys[0]!.textContent).toBe('Status')
    expect(keys[1]!.textContent).toBe('count')
  })

  test('renders empty text when no items are provided', async () => {
    const el = await mountClass(RKVList) as RKVList
    el.items = []
    el.emptyText = 'No items found'
    await el.updateComplete

    const muted = el.shadowRoot!.querySelector('.kv-muted')
    expect(muted).not.toBeNull()
    expect(muted!.textContent).toBe('No items found')
  })
})
