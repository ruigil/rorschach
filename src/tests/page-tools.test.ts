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
    expect(writeHTMLPageTool.name).toBe('write_html_page')
    expect((writeHTMLPageTool.schema.function.parameters as any).required).toEqual([
      'collection',
      'title',
      'filename',
      'markdown',
    ])
  })

  test('CodingAgentDescriptor registers coding tools including grep/glob/write/str_replace', () => {
    const mockTools = {
      bash: codingBashTool,
      read: codingReadTool,
      grep: codingGrepTool,
      glob: codingGlobTool,
      write: codingWriteTool,
      str_replace: codingStrReplaceTool,
      write_html_page: writeHTMLPageTool,
    } as any

    const descriptor = CodingAgentDescriptor({
      model: 'test-model',
      projectMount: '/rorschach',
      tools: mockTools,
    })

    expect(descriptor.mode).toBe('coding')
    expect(descriptor.capabilities).toEqual({ userVisible: true })
    expect(descriptor.systemPrompt).toContain('write_html_page')
    expect(descriptor.systemPrompt).toContain('grep')
    expect(descriptor.systemPrompt).toContain('glob')
    expect(descriptor.systemPrompt).toContain('write:')
    expect(descriptor.systemPrompt).toContain('str_replace')
    expect(descriptor.systemPrompt).toContain('LINE|')

    const toolNames = descriptor.internalTools.map(t => t.name)
    expect(toolNames).toContain('bash')
    expect(toolNames).toContain('read')
    expect(toolNames).toContain('grep')
    expect(toolNames).toContain('glob')
    expect(toolNames).toContain('write')
    expect(toolNames).toContain('str_replace')
    expect(toolNames).toContain('write_html_page')
  })
})
