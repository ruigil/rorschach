import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mountClass, cleanup, mockStore } from '../helpers/frontend.js'
import { RStatusDot } from '../../frontend/shell/r-status-dot.js'

beforeEach(cleanup)
afterEach(cleanup)

describe('r-status-dot', () => {
  test('shows connected status when isConnected is true', async () => {
    mockStore('isConnected', true)
    const el = await mountClass(RStatusDot) as any
    await el.updateComplete

    expect(el.status).toBe('connected')
    expect(el.getAttribute('status')).toBe('connected')
  })

  test('shows disconnected status when isConnected is false', async () => {
    mockStore('isConnected', false)
    const el = await mountClass(RStatusDot) as any
    await el.updateComplete

    expect(el.status).toBe('disconnected')
    expect(el.getAttribute('status')).toBe('disconnected')
  })

  test('renders dot and label', async () => {
    mockStore('isConnected', true)
    const el = await mountClass(RStatusDot) as any
    await el.updateComplete

    const dot = el.shadowRoot!.querySelector('.dot')
    const label = el.shadowRoot!.querySelector('.label')
    expect(dot).toBeTruthy()
    expect(label).toBeTruthy()
  })

  test('shows "connected" label when connected', async () => {
    mockStore('isConnected', true)
    const el = await mountClass(RStatusDot) as any
    await el.updateComplete

    const label = el.shadowRoot!.querySelector('.label')
    expect(label!.textContent).toBe('connected')
  })

  test('shows "reconnecting…" label when disconnected', async () => {
    mockStore('isConnected', false)
    const el = await mountClass(RStatusDot) as any
    await el.updateComplete

    const label = el.shadowRoot!.querySelector('.label')
    expect(label!.textContent).toBe('reconnecting\u2026')
  })
})
