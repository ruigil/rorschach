import { describe, test, expect, afterEach } from 'bun:test'
import { createPluginSystem, ask } from '../system/index.ts'
import type { ActorDef } from '../system/index.ts'
import {
  createWebSearchActor,
  type WebSearchMsg,
  type BraveLlmContextResponse,
} from '../plugins/tools/web-search.ts'
import { ToolRegistrationTopic } from '../types/tools.ts'
import type { ToolInvokeMsg, ToolReply, ToolRegistrationEvent } from '../types/tools.ts'
import toolsPlugin from '../plugins/tools/tools.plugin.ts'

// ─── Helpers ───

const tick = (ms = 50) => Bun.sleep(ms)

const mockBraveResponse: BraveLlmContextResponse = {
  grounding: {
    generic: [
      { url: 'https://example.com/page', title: 'Example Page', snippets: ['Relevant snippet about the query.'] },
    ],
    poi: null,
    map: [],
  },
  sources: {
    'https://example.com/page': { title: 'Example Page', hostname: 'example.com', age: [null] },
  },
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ─── Fetch stubs ───

const stubFetchOk = (body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch
}

const stubFetchError = (status: number, body = 'Internal Server Error') => {
  globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch
}

const stubFetchThrow = (message: string) => {
  globalThis.fetch = (async () => { throw new Error(message) }) as unknown as typeof fetch
}

// ═══════════════════════════════════════════════════════════════════
// Web-Search Actor
// ═══════════════════════════════════════════════════════════════════

describe('web-search actor', () => {
  test('sends toolResult to replyTo on successful Brave API response', async () => {
    stubFetchOk(mockBraveResponse)

    const system = await createPluginSystem()
    const ref = system.spawn('web-search', createWebSearchActor({ apiKey: 'test-key' }), null)
    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({ type: 'invoke', toolName: 'web_search', arguments: JSON.stringify({ query: 'bun runtime' }), replyTo }),
      { timeoutMs: 500 },
    )

    expect(reply.type).toBe('toolResult')
    if (reply.type === 'toolResult') {
      expect(reply.result).toContain('Example Page')
      expect(reply.sources).toHaveLength(1)
      expect(reply.sources?.[0]?.url).toBe('https://example.com/page')
    }

    await system.shutdown()
  })

  test('sends toolError to replyTo when Brave API returns non-ok status', async () => {
    stubFetchError(429, 'Rate limit exceeded')

    const system = await createPluginSystem()
    const ref = system.spawn('web-search', createWebSearchActor({ apiKey: 'test-key' }), null)
    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({ type: 'invoke', toolName: 'web_search', arguments: JSON.stringify({ query: 'anything' }), replyTo }),
      { timeoutMs: 500 },
    )

    expect(reply.type).toBe('toolError')
    if (reply.type === 'toolError') {
      expect(reply.error).toContain('429')
    }

    await system.shutdown()
  })

  test('sends toolError to replyTo when fetch throws a network error', async () => {
    stubFetchThrow('network unreachable')

    const system = await createPluginSystem()
    const ref = system.spawn('web-search', createWebSearchActor({ apiKey: 'test-key' }), null)
    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({ type: 'invoke', toolName: 'web_search', arguments: JSON.stringify({ query: 'anything' }), replyTo }),
      { timeoutMs: 500 },
    )

    expect(reply.type).toBe('toolError')
    if (reply.type === 'toolError') {
      expect(reply.error).toContain('network unreachable')
    }

    await system.shutdown()
  })

  test('includes count param in the request URL', async () => {
    let capturedUrl: string | undefined

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = input.toString()
      return new Response(JSON.stringify(mockBraveResponse), { status: 200 })
    }) as unknown as typeof fetch

    const system = await createPluginSystem()
    const ref = system.spawn('web-search', createWebSearchActor({ apiKey: 'test-key', count: 7 }), null)
    await tick()

    await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({ type: 'invoke', toolName: 'web_search', arguments: JSON.stringify({ query: 'test' }), replyTo }),
      { timeoutMs: 500 },
    )

    expect(capturedUrl).toContain('count=7')
    expect(capturedUrl).toContain('q=test')

    await system.shutdown()
  })

  test('sends the API key as X-Subscription-Token header', async () => {
    let capturedHeaders: Headers | undefined

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers)
      return new Response(JSON.stringify(mockBraveResponse), { status: 200 })
    }) as unknown as typeof fetch

    const system = await createPluginSystem()
    const ref = system.spawn('web-search', createWebSearchActor({ apiKey: 'my-secret-key' }), null)
    await tick()

    await ask<ToolInvokeMsg, ToolReply>(
      ref,
      (replyTo) => ({ type: 'invoke', toolName: 'web_search', arguments: JSON.stringify({ query: 'test' }), replyTo }),
      { timeoutMs: 500 },
    )

    expect(capturedHeaders?.get('X-Subscription-Token')).toBe('my-secret-key')

    await system.shutdown()
  })
})

// ═══════════════════════════════════════════════════════════════════
// Tools Plugin
// ═══════════════════════════════════════════════════════════════════

describe('tools plugin', () => {
  test('activates and spawns web-search child actor', async () => {
    stubFetchOk(mockBraveResponse)

    const system = await createPluginSystem({
      config: { tools: { webSearch: { apiKey: 'test-key', count: 10 } } },
      plugins: [toolsPlugin],
    })
    await tick()

    const status = system.getPluginStatus('tools')
    expect(status?.status).toBe('active')

    // Probe actor: subscribe to ToolRegistrationTopic, fire an invoke, collect the reply
    type ProbeMsg = ToolReply | { type: 'registered'; event: ToolRegistrationEvent }
    const replies: ToolReply[] = []

    const probeDef: ActorDef<ProbeMsg, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          ctx.subscribe(ToolRegistrationTopic, (ev): ProbeMsg => ({ type: 'registered', event: ev }))
        }
        return { state }
      },
      handler: (state, msg, ctx) => {
        if (msg.type === 'registered' && msg.event.ref !== null && msg.event.name === 'web_search') {
          msg.event.ref.send({
            type: 'invoke',
            toolName: 'web_search',
            arguments: JSON.stringify({ query: 'probe' }),
            replyTo: ctx.self as unknown as import('../system/types.ts').ActorRef<ToolReply>,
          })
        }
        if (msg.type === 'toolResult' || msg.type === 'toolError') {
          replies.push(msg)
        }
        return { state }
      },
    }

    system.spawn('probe', probeDef, null)
    await tick(200)

    expect(replies).toHaveLength(1)
    expect(replies[0]!.type).toBe('toolResult')

    await system.shutdown()
  })

  test('maskState redacts the API key', () => {
    const state = {
      initialized: true,
      webSearch: { config: { apiKey: 'super-secret', count: 20 }, ref: null, gen: 0 },
      bash:      { config: null, ref: null, gen: 0 },
      vision:    { config: null, ref: null, gen: 0 },
      llmRef:    null,
      tools: {},
    }

    const masked = toolsPlugin.maskState!(state)

    expect((masked as typeof state).webSearch.config?.apiKey).toBe('[redacted]')
    expect((masked as typeof state).webSearch.config?.count).toBe(20)
  })

  test('maskState handles null webSearchConfig gracefully', () => {
    const state = {
      initialized: false,
      webSearch: { config: null, ref: null, gen: 0 },
      bash:      { config: null, ref: null, gen: 0 },
      vision:    { config: null, ref: null, gen: 0 },
      llmRef:    null,
      tools: {},
    }

    const masked = toolsPlugin.maskState!(state)

    expect((masked as typeof state).webSearch.config).toBeNull()
  })

  test('config change replaces web-search child actor', async () => {
    stubFetchOk(mockBraveResponse)

    const system = await createPluginSystem({
      config: { tools: { webSearch: { apiKey: 'initial-key', count: 5 } } },
      plugins: [toolsPlugin],
    })
    await tick()

    // Track web_search registrations to verify config change spawns a new actor
    let webSearchRegistrationCount = 0
    system.subscribe(ToolRegistrationTopic, (event) => {
      const e = event as ToolRegistrationEvent
      if (e.name === 'web_search' && e.ref !== null) webSearchRegistrationCount++
    })
    // The retained event replays immediately on subscribe (gen-0 actor)
    expect(webSearchRegistrationCount).toBe(1)

    system.updateConfig({ tools: { webSearch: { apiKey: 'updated-key', count: 15 } } })
    await tick()

    // After config change a new actor registers (gen-1)
    expect(webSearchRegistrationCount).toBe(2)

    await system.shutdown()
  })
})
