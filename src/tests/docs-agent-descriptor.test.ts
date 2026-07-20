import { describe, expect, test } from 'bun:test'
import { DocsAgentDescriptor } from '../plugins/coding/docs-agent.ts'
import { writeDocPageTool, writeTocTool, deleteDocTool } from '../plugins/coding/documentation.ts'
import { codingBashTool, codingReadTool } from '../plugins/coding/project-shell.ts'

describe('DocsAgentDescriptor', () => {
  test('creates a valid AgentDescriptor with userVisible: false and internalTools', () => {
    const mockTools = {
      bash: codingBashTool,
      read: codingReadTool,
      write_doc_page: writeDocPageTool,
      write_toc: writeTocTool,
      delete_doc: deleteDocTool,
    } as any

    const descriptor = DocsAgentDescriptor({
      model: 'test-model',
      maxToolLoops: 20,
      projectMount: '/rorschach',
      tools: mockTools,
    })

    expect(descriptor.mode).toBe('docs')
    expect(descriptor.role).toBe('docs')
    expect(descriptor.displayName).toBe('Documentation Generator')
    expect(descriptor.capabilities).toEqual({ userVisible: false })
    expect(descriptor.model).toBe('test-model')
    expect(descriptor.maxToolLoops).toBe(20)

    expect(descriptor.systemPrompt).toContain('/rorschach')
    expect(descriptor.systemPrompt).toContain('write_doc_page')
    expect(descriptor.systemPrompt).toContain('write_toc')

    expect(descriptor.internalTools).toHaveLength(5)
    const toolNames = descriptor.internalTools.map(t => t.name)
    expect(toolNames).toContain('bash')
    expect(toolNames).toContain('read')
    expect(toolNames).toContain('write_doc_page')
    expect(toolNames).toContain('write_toc')
    expect(toolNames).toContain('delete_doc')
  })
})
