import { describe, test, expect, afterEach } from 'bun:test'
import { createPluginSystem, ask } from '../system/index.ts'
import { createFetchFileActor } from '../plugins/tools/fetch-file.ts'
import type { ToolInvokeMsg, ToolReply } from '../types/tools.ts'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'

const tick = (ms = 50) => Bun.sleep(ms)

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('fetch-file actor', () => {
  test('preserves original filename', async () => {
    const mockContent = new TextEncoder().encode('hello world')

    globalThis.fetch = (async () => new Response(mockContent, {
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
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result).toContain('Downloaded to:')
      expect(reply.result).toContain('test.txt')
      expect(reply.result).toContain('11 bytes')

      const pathMatch = reply.result.match(/Downloaded to: (.*)\b/)
      if (pathMatch && pathMatch[1]) {
        const filePath = pathMatch[1]!.split(' (')[0]!
        try { await unlink(filePath) } catch { /* ignore cleanup errors */ }
      }
    }

    await system.shutdown()
  })

  test('adds numeric suffix when filename collides', async () => {
    const mockContent = new TextEncoder().encode('file content')
    const runId = crypto.randomUUID().slice(0, 8)
    const filename = `collision-test-${runId}.txt`

    globalThis.fetch = (async () => new Response(mockContent, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })) as unknown as typeof fetch

    const system = await createPluginSystem()
    const ref = system.spawn('fetch-file', createFetchFileActor(), null)
    await tick()

    const reply1 = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'fetch_file',
        arguments: JSON.stringify({ url: `https://example.com/${filename}` }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )
    expect(reply1.type).toBe('toolResult')
    if (reply1.type !== 'toolResult') return
    const pathMatch1 = reply1.result.match(/Downloaded to: (.*?) \(/)
    if (!pathMatch1) return
    const filePath1 = pathMatch1[1]!

    const reply2 = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'fetch_file',
        arguments: JSON.stringify({ url: `https://example.com/${filename}` }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 1000 },
    )
    expect(reply2.type).toBe('toolResult')
    if (reply2.type !== 'toolResult') return
    const pathMatch2 = reply2.result.match(/Downloaded to: (.*?) \(/)
    if (!pathMatch2) return
    const filePath2 = pathMatch2[1]!

    expect(filePath1).toContain(filename)
    expect(filePath2).toContain(`collision-test-${runId}-1.txt`)

    try { await unlink(filePath1) } catch { /* ignore */ }
    try { await unlink(filePath2) } catch { /* ignore */ }
    await system.shutdown()
  })

  test('falls back to UUID filename when URL has no path segment', async () => {
    const mockContent = new TextEncoder().encode('data')

    globalThis.fetch = (async () => new Response(mockContent, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    })) as unknown as typeof fetch

    const system = await createPluginSystem()
    const ref = system.spawn('fetch-file', createFetchFileActor(), null)
    await tick(200)

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'fetch_file',
        arguments: JSON.stringify({ url: 'https://example.com/' }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 2000 },
    )

    if (reply.type === 'toolError') {
      console.error('UUID test error:', reply.error)
    }
    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result).toMatch(/Downloaded to: /)
      const pathMatch = reply.result.match(/Downloaded to: (.*?) \(/)
      expect(pathMatch).not.toBeNull()
      const filePath = pathMatch![1]!
      expect(filePath).toMatch(/rorschach-[a-f0-9-]+\.bin$/)
      try { await unlink(filePath) } catch { /* ignore */ }
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
        replyTo,
        userId: 'test-user',
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
        replyTo,
        userId: 'test-user',
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