import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mountClass, cleanup } from '../helpers/frontend.js'
import { RBadge } from '../../frontend/webkit/r-badge.js'

beforeEach(cleanup)
afterEach(cleanup)

describe('r-badge', () => {
  test('renders slot content', async () => {
    const el = await mountClass(RBadge)
    el.textContent = 'INFO'
    await el.updateComplete

    const slot = el.shadowRoot!.querySelector('slot')
    expect(slot).toBeTruthy()
  })

  test('accepts level attribute', async () => {
    const el = await mountClass(RBadge)
    el.setAttribute('level', 'error')
    await el.updateComplete

    expect(el.getAttribute('level')).toBe('error')
  })

  test('accepts variant and status attributes', async () => {
    const el = await mountClass(RBadge)
    el.setAttribute('variant', 'actor')
    el.setAttribute('status', 'running')
    await el.updateComplete

    expect(el.getAttribute('variant')).toBe('actor')
    expect(el.getAttribute('status')).toBe('running')
  })

  test('defaults level to empty string', async () => {
    const el = await mountClass(RBadge) as any
    await el.updateComplete

    expect(el.level).toBe('')
  })
})
