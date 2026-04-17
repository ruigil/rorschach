import { describe, test, expect, afterEach } from 'bun:test'
import { createPluginSystem, ask } from '../system/index.ts'
import { createFetchFileActor } from '../plugins/tools/fetch-file.ts'
import type { ToolInvokeMsg, ToolReply } from '../types/tools.ts'
import { unlink } from 'node:fs/promises'

const tick = (ms = 50) => Bun.sleep(ms)

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('fetch-file actor', () => {
  test('downloads a file and returns the path', async () => {
    const mockContent = 'hello world'
    const mockBuffer = new TextEncoder().encode(mockContent)

    globalThis.fetch = (async () => new Response(mockBuffer, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })) as unknown as typeof fetch

    const system = await createPluginSystem()
    const ref = system.spawn('fetch-file', createFetchFileActor(), null)
    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'fetch_file',
        arguments: JSON.stringify({ url: 'https://example.com/test.txt' }),
        replyTo
      }),
      { timeoutMs: 1000 },
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result).toContain('Downloaded to:')
      expect(reply.result).toContain('.txt')
      expect(reply.result).toContain('11 bytes')

      // Extract path and clean up
      const pathMatch = reply.result.match(/Downloaded to: (.*\.txt)/)
      if (pathMatch && pathMatch[1]) {
        const filePath = pathMatch[1]!.split(' (')[0]!
        try { await unlink(filePath) } catch (e) {
            // ignore cleanup errors in test
        }
      }
    }

    await system.shutdown()
  })

  test('returns toolError on failed fetch (404)', async () => {
    globalThis.fetch = (async () => new Response('Not Found', {
      status: 404,
    })) as unknown as typeof fetch

    const system = await createPluginSystem()
    const ref = system.spawn('fetch-file', createFetchFileActor(), null)
    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'fetch_file',
        arguments: JSON.stringify({ url: 'https://example.com/missing' }),
        replyTo
      }),
      { timeoutMs: 1000 },
    )

    expect(reply.type).toBe('toolError')
    if (reply.type === 'toolError') {
      expect(reply.error).toContain('HTTP 404')
    }

    await system.shutdown()
  })

  test('returns toolError on network failure', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Network failure')
    }) as unknown as typeof fetch

    const system = await createPluginSystem()
    const ref = system.spawn('fetch-file', createFetchFileActor(), null)
    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'fetch_file',
        arguments: JSON.stringify({ url: 'https://example.com/fail' }),
        replyTo
      }),
      { timeoutMs: 1000 },
    )

    expect(reply.type).toBe('toolError')
    if (reply.type === 'toolError') {
      expect(reply.error).toContain('Network failure')
    }

    await system.shutdown()
  })
})
