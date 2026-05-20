import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mountClass, cleanup } from '../helpers/frontend.js'
import { RFlashMessage } from '../../frontend/components/r-flash-message.js'

beforeEach(cleanup)
afterEach(cleanup)

describe('r-flash-message', () => {
  test('renders message when show() is called', async () => {
    const el = await mountClass(RFlashMessage) as any
    await el.updateComplete

    el.show('save', 'saved successfully')
    await el.updateComplete

    const msg = el.shadowRoot!.querySelector('.msg')
    expect(msg).toBeTruthy()
    expect(msg!.textContent).toContain('saved successfully')
    expect(msg!.classList.contains('visible')).toBe(true)
    expect(msg!.classList.contains('save')).toBe(true)
  })

  test('save() shows default saved message', async () => {
    const el = await mountClass(RFlashMessage) as any
    await el.updateComplete

    el.save()
    await el.updateComplete

    const msg = el.shadowRoot!.querySelector('.msg')
    expect(msg!.textContent!.trim()).toBe('saved')
    expect(msg!.classList.contains('save')).toBe(true)
  })

  test('error() shows error message', async () => {
    const el = await mountClass(RFlashMessage) as any
    await el.updateComplete

    el.error('connection failed')
    await el.updateComplete

    const msg = el.shadowRoot!.querySelector('.msg')
    expect(msg!.textContent!.trim()).toBe('connection failed')
    expect(msg!.classList.contains('error')).toBe(true)
  })

  test('message auto-hides after duration', async () => {
    const el = await mountClass(RFlashMessage) as any
    await el.updateComplete

    el.show('save', 'done', 50)
    await el.updateComplete

    const msg = el.shadowRoot!.querySelector('.msg')
    expect(msg!.classList.contains('visible')).toBe(true)

    await new Promise(r => setTimeout(r, 100))
    await el.updateComplete

    expect(msg!.classList.contains('visible')).toBe(false)
  })
})
