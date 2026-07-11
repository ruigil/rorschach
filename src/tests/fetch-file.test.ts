import { describe, test, expect, afterEach } from 'bun:test'
import { AgentSystem, ask } from '../system/index.ts'
import { FetchFile } from '../plugins/tools/fetch-file.ts'
import type { ToolInvokeMsg, ToolReply } from '../types/tools.ts'
import { MockPersistenceActor } from './mock-persistence.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('fetch-file actor', () => {
  test('preserves original filename and stores via obj.putStream', async () => {
    const mockContent = new TextEncoder().encode('hello world')

    globalThis.fetch = (async () => new Response(mockContent, {
      status: 200,
      headers: { 
        'Content-Type': 'text/plain',
        'Content-Length': String(mockContent.byteLength)
      },
    })) as unknown as typeof fetch

    const system = await AgentSystem()
    const persistenceRef = system.spawn('mock-persistence', MockPersistenceActor())
    const ref = system.spawn('fetch-file', FetchFile())
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
      expect(reply.result.text).toContain('Downloaded and stored to persistence key:')
      expect(reply.result.text).toContain('inbound/test.txt')
      expect(reply.result.text).toContain('11 bytes')
    }

    await system.shutdown()
  })

  test('falls back to UUID filename when URL has no path segment', async () => {
    const mockContent = new TextEncoder().encode('data')

    globalThis.fetch = (async () => new Response(mockContent, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    })) as unknown as typeof fetch

    const system = await AgentSystem()
    const persistenceRef = system.spawn('mock-persistence', MockPersistenceActor())
    const ref = system.spawn('fetch-file', FetchFile())
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

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result.text).toContain('inbound/rorschach-')
      expect(reply.result.text).toContain('.bin')
    }

    await system.shutdown()
  })

  test('returns toolError on failed fetch (404)', async () => {
    globalThis.fetch = (async () => new Response('Not Found', {
      status: 404,
    })) as unknown as typeof fetch

    const system = await AgentSystem()
    const persistenceRef = system.spawn('mock-persistence', MockPersistenceActor())
    const ref = system.spawn('fetch-file', FetchFile())
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

    const system = await AgentSystem()
    const persistenceRef = system.spawn('mock-persistence', MockPersistenceActor())
    const ref = system.spawn('fetch-file', FetchFile())
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