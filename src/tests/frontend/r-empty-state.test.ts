import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mountClass, cleanup } from '../helpers/frontend.js'
import { REmptyState } from '../../frontend/webkit/r-empty-state.js'

beforeEach(cleanup)
afterEach(cleanup)

describe('r-empty-state', () => {
  test('renders text', async () => {
    const el = await mountClass(REmptyState) as any
    el.text = 'no data'
    await el.updateComplete

    const text = el.shadowRoot!.querySelector('.text')
    expect(text).toBeTruthy()
    expect(text!.textContent).toBe('no data')
  })

  test('renders subtext', async () => {
    const el = await mountClass(REmptyState) as any
    el.text = 'empty'
    el.subtext = 'try again'
    await el.updateComplete

    const subtext = el.shadowRoot!.querySelector('.subtext')
    expect(subtext).toBeTruthy()
    expect(subtext!.textContent).toBe('try again')
  })

  test('renders icon by name', async () => {
    const el = await mountClass(REmptyState) as any
    el.name = 'monitor'
    await el.updateComplete

    const icon = el.shadowRoot!.querySelector('.icon')
    expect(icon).toBeTruthy()
    expect(icon!.querySelector('svg')).toBeTruthy()
  })

  test('reflects variant attribute', async () => {
    const el = await mountClass(REmptyState) as any
    el.variant = 'chat'
    el.text = 'say hi'
    await el.updateComplete

    expect(el.getAttribute('variant')).toBe('chat')
  })

  test('renders nothing when no props', async () => {
    const el = await mountClass(REmptyState) as any
    await el.updateComplete

    const text = el.shadowRoot!.querySelector('.text')
    expect(text).toBeNull()
  })
})
