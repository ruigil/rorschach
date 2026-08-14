import { expect, test, describe } from 'bun:test'
import { pageShell, safePathFilename, updateTocTree, writeHTMLPageTool } from '../plugins/coding/page-tools.ts'
import { CodingAgentDescriptor } from '../plugins/coding/coding-agent.ts'
import {
  codingBashTool,
  codingGlobTool,
  codingGrepTool,
  codingReadTool,
  codingStrReplaceTool,
  codingWriteTool,
} from '../plugins/coding/project-shell.ts'
import type { TocNode } from '../plugins/coding/types.ts'

describe('Page Tools Suite', () => {
  test('pageShell includes stylesheets, scripts, and content', () => {
    const title = 'Test Architecture Page'
    const bodyHtml = '<pre><code class="language-typescript">const x = 42;</code></pre>'
    const shell = pageShell(title, bodyHtml)

    expect(shell).toContain('Test Architecture Page')
    expect(shell).toContain('https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/base16/ocean.min.css')
    expect(shell).toContain('https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js')
    expect(shell).toContain(bodyHtml)
  })

  test('safePathFilename preserves subdirectories and sanitizes filenames', () => {
    expect(safePathFilename('architecture')).toBe('architecture.html')
    expect(safePathFilename('guides/getting-started')).toBe('guides/getting-started.html')
    expect(safePathFilename('../secret/config.html')).toBe('secret/config.html')
    expect(safePathFilename('api/v1/users.html')).toBe('api/v1/users.html')
  })

  test('updateTocTree incrementally builds nested TOC tree', () => {
    let tree: TocNode[] = []

    // 1. Add root page
    tree = updateTocTree(tree, 'index.html', 'Home')
    expect(tree).toHaveLength(1)
    expect(tree[0]).toEqual({ title: 'Home', filename: 'index.html' })

    // 2. Add page under 'guides' folder
    tree = updateTocTree(tree, 'guides/getting-started.html', 'Getting Started')
    expect(tree).toHaveLength(2)
    expect(tree[1]!.title).toBe('Guides')
    expect(tree[1]!.children).toHaveLength(1)
    expect(tree[1]!.children![0]).toEqual({ title: 'Getting Started', filename: 'guides/getting-started.html' })

    // 3. Add sibling under 'guides' folder
    tree = updateTocTree(tree, 'guides/advanced-concepts.html', 'Advanced Concepts')
    expect(tree[1]!.children).toHaveLength(2)
    expect(tree[1]!.children![1]).toEqual({ title: 'Advanced Concepts', filename: 'guides/advanced-concepts.html' })

    // 4. Update title of existing page
    tree = updateTocTree(tree, 'guides/getting-started.html', 'Getting Started Guide')
    expect(tree[1]!.children![0]!.title).toBe('Getting Started Guide')
  })

  test('writeHTMLPageTool has correct schema and registration name', () => {
    expect(writeHTMLPageTool.name).toBe('coding_html_write_page')
    expect((writeHTMLPageTool.schema.function.parameters as any).required).toEqual([
      'collection',
      'title',
      'filename',
      'markdown',
    ])
  })

  test('CodingAgentDescriptor registers coding tools including coding_file_grep/coding_file_glob/coding_file_write/coding_file_replace_string', () => {
    const descriptor = CodingAgentDescriptor({
      model: 'test-model',
      projectMount: '/rorschach',
      agentSCRs: [
        'scr:leaf:coding.shellExec',
        'scr:leaf:coding.fileRead',
        'scr:leaf:coding.grep',
        'scr:leaf:coding.glob',
        'scr:leaf:coding.write',
        'scr:leaf:coding.strReplace',
        'scr:leaf:coding.htmlWritePage',
      ],
    })

    expect(descriptor.mode).toBe('coding')
    expect(descriptor.capabilities).toEqual({ userVisible: true })
    expect(descriptor.systemPrompt).toContain('coding_html_write_page')
    expect(descriptor.systemPrompt).toContain('coding_file_grep')
    expect(descriptor.systemPrompt).toContain('coding_file_glob')
    expect(descriptor.systemPrompt).toContain('coding_file_write:')
    expect(descriptor.systemPrompt).toContain('coding_file_replace_string')
    expect(descriptor.systemPrompt).toContain('LINE|')

    expect(descriptor.agentSCRs).toContain('scr:leaf:coding.shellExec')
    expect(descriptor.agentSCRs).toContain('scr:leaf:coding.fileRead')
    expect(descriptor.agentSCRs).toContain('scr:leaf:coding.grep')
    expect(descriptor.agentSCRs).toContain('scr:leaf:coding.glob')
    expect(descriptor.agentSCRs).toContain('scr:leaf:coding.write')
    expect(descriptor.agentSCRs).toContain('scr:leaf:coding.strReplace')
    expect(descriptor.agentSCRs).toContain('scr:leaf:coding.htmlWritePage')
  })
})
