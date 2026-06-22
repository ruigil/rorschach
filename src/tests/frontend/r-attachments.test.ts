import { describe, test, expect, beforeEach, afterEach } from 'bun:test'

import { mountClass, cleanup } from '../helpers/frontend.js'
import { RAttachments } from '../../frontend/webkit/r-attachments.js'

beforeEach(cleanup)
afterEach(cleanup)

describe('r-attachments', () => {
  test('renders pdf attachments as links when a source is present', async () => {
    const el = await mountClass(RAttachments) as RAttachments
    el.items = [{ kind: 'pdf', url: '/files/report.pdf', name: 'report.pdf' }]
    await el.updateComplete

    const link = el.shadowRoot!.querySelector('a.attachment-pdf')
    expect(link).toBeTruthy()
    expect(link!.getAttribute('href')).toBe('/files/report.pdf')
    expect(link!.getAttribute('target')).toBe('_blank')
    expect(link!.textContent).toContain('report.pdf')
  })

  test('renders pdf attachments without sources as labels', async () => {
    const el = await mountClass(RAttachments) as RAttachments
    el.items = [{ kind: 'pdf', name: 'report.pdf' }]
    await el.updateComplete

    expect(el.shadowRoot!.querySelector('a.attachment-pdf')).toBeNull()
    expect(el.shadowRoot!.querySelector('.attachment-pdf')!.textContent).toContain('report.pdf')
  })
})
