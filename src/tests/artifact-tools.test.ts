import { expect, test, describe } from 'bun:test'
import { pageShell, indexShell } from '../plugins/coding/artifact-tools.ts'

describe('Artifact Tools Templates', () => {
  test('pageShell includes Highlight.js stylesheet, scripts, and copyCode helper', () => {
    const title = 'Test Architecture Page'
    const bodyHtml = '<pre><code class="language-typescript">const x = 42;</code></pre>'
    const shell = pageShell(title, bodyHtml)

    expect(shell).toContain('Test Architecture Page')
    expect(shell).toContain('https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/base16/ocean.min.css')
    expect(shell).toContain('https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js')
    expect(shell).toContain('const copyCode = (btn) => {')
    expect(shell).toContain('const lang = langClass ? langClass.replace(\'language-\', \'\') : \'code\';')
    expect(shell).toContain('hljs.highlightElement(block);')
    expect(shell).toContain(bodyHtml)
  })

  test('indexShell renders Documentation Index title and manifest info', () => {
    const manifest = {
      generatedAt: '2026-05-24T01:23:42.000Z',
      query: 'System Architecture & Design',
      pages: []
    }
    const shell = indexShell(manifest)

    expect(shell).toContain('Documentation Index')
    expect(shell).toContain('System Architecture &amp; Design')
    expect(shell).toContain('Generated at 2026-05-24T01:23:42.000Z')
  })
})
