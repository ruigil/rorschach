import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mountClass, cleanup } from '../helpers/frontend.js'
import { RIcon } from '../../frontend/webkit/r-icon.js'

beforeEach(cleanup)
afterEach(cleanup)

describe('r-icon', () => {
  test('renders SVG for known icon name', async () => {
    const el = await mountClass(RIcon) as any
    el.name = 'send'
    await el.updateComplete

    const svg = el.shadowRoot!.querySelector('svg')
    expect(svg).toBeTruthy()
  })

  test('renders nothing for unknown icon', async () => {
    const el = await mountClass(RIcon) as any
    el.name = 'nonexistent'
    await el.updateComplete

    const svg = el.shadowRoot!.querySelector('svg')
    expect(svg).toBeNull()
  })

  test('renders nothing when no name', async () => {
    const el = await mountClass(RIcon) as any
    await el.updateComplete

    expect(el.shadowRoot!.querySelector('svg')).toBeNull()
  })

  test('defaults size to md', async () => {
    const el = await mountClass(RIcon) as any
    await el.updateComplete

    expect(el.size).toBe('md')
  })

  test('accepts size attribute', async () => {
    const el = await mountClass(RIcon) as any
    el.setAttribute('size', 'lg')
    await el.updateComplete

    expect(el.getAttribute('size')).toBe('lg')
  })

  test('size attribute is reflected', async () => {
    const el = await mountClass(RIcon) as any
    el.size = 'xl'
    await el.updateComplete

    expect(el.getAttribute('size')).toBe('xl')
  })
})
