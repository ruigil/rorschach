import { describe, test, expect, afterEach } from 'bun:test'
import { AgentSystem, ask, staticSource} from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import {
  WebSearch,
} from '../plugins/tools/web-search.ts'
import type { WebSearchMsg, BraveLlmContextResponse } from '../plugins/tools/types.ts'
import { SCRRegistrationTopic, type SCRRegistrationEvent, type SCRInvokeMsg, type SCRReply } from '../types/scr.ts'
import toolsPlugin from '../plugins/tools/tools.plugin.ts'
import { MockPersistenceActor } from './mock-persistence.ts'

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
  test('sends result to replyTo on successful Brave API response', async () => {
    stubFetchOk(mockBraveResponse)

    const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor()] }) })
    const ref = system.spawn('web-search', WebSearch({ apiKey: 'test-key' }))
    await tick()

    const reply = await ask<SCRInvokeMsg, SCRReply>(
      ref,
      (replyTo) => ({ type: 'invoke', urn: 'scr:leaf:tools.web_search', input: { query: 'bun runtime' }, replyTo }),
      { timeoutMs: 500 },
    )

    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      const output = reply.output as { text: string; sources?: Array<{ url: string }> }
      expect(output.text).toContain('Example Page')
      expect(output.sources).toHaveLength(1)
      expect(output.sources?.[0]?.url).toBe('https://example.com/page')
    }

    await system.shutdown()
  })

  test('sends error to replyTo when Brave API returns non-ok status', async () => {
    stubFetchError(429, 'Rate limit exceeded')

    const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor()] }) })
    const ref = system.spawn('web-search', WebSearch({ apiKey: 'test-key' }))
    await tick()

    const reply = await ask<SCRInvokeMsg, SCRReply>(
      ref,
      (replyTo) => ({ type: 'invoke', urn: 'scr:leaf:tools.web_search', input: { query: 'anything' }, replyTo }),
      { timeoutMs: 500 },
    )

    expect(reply.type).toBe('error')
    if (reply.type === 'error') {
      expect(reply.error).toContain('429')
    }

    await system.shutdown()
  })

  test('sends error to replyTo when fetch throws a network error', async () => {
    stubFetchThrow('network unreachable')

    const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor()] }) })
    const ref = system.spawn('web-search', WebSearch({ apiKey: 'test-key' }))
    await tick()

    const reply = await ask<SCRInvokeMsg, SCRReply>(
      ref,
      (replyTo) => ({ type: 'invoke', urn: 'scr:leaf:tools.web_search', input: { query: 'anything' }, replyTo }),
      { timeoutMs: 500 },
    )

    expect(reply.type).toBe('error')
    if (reply.type === 'error') {
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

    const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor()] }) })
    const ref = system.spawn('web-search', WebSearch({ apiKey: 'test-key', count: 7 }))
    await tick()

    await ask<SCRInvokeMsg, SCRReply>(
      ref,
      (replyTo) => ({ type: 'invoke', urn: 'scr:leaf:tools.web_search', input: { query: 'test' }, replyTo }),
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

    const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor()] }) })
    const ref = system.spawn('web-search', WebSearch({ apiKey: 'my-secret-key' }))
    await tick()

    await ask<SCRInvokeMsg, SCRReply>(
      ref,
      (replyTo) => ({ type: 'invoke', urn: 'scr:leaf:tools.web_search', input: { query: 'test' }, replyTo }),
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

    const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor(), toolsPlugin], config: { tools: { webSearch: { apiKey: 'test-key', count: 10 } } } }) })
    await tick()

    const status = system.control()
      .snapshotActual()
      .plugins.find((p) => p.id === 'tools')
    expect(status?.status).toBe('active')

    // Probe actor: subscribe to SCRRegistrationTopic, fire an invoke, collect the reply
    type ProbeMsg = SCRReply | { type: 'registered'; event: SCRRegistrationEvent }
    const replies: SCRReply[] = []

    const probeDef: ActorDef<ProbeMsg, null> = {
      lifecycle: (state, event, ctx) => {
        if (event.type === 'start') {
          ctx.subscribe(SCRRegistrationTopic, (ev): ProbeMsg => ({ type: 'registered', event: ev }))
        }
        return { state }
      },
      handler: (state, msg, ctx) => {
        if (msg.type === 'registered' && msg.event.type === 'register' && msg.event.descriptor.urn === 'scr:leaf:tools.web_search') {
          msg.event.descriptor.target.send({
            type: 'invoke',
            urn: 'scr:leaf:tools.web_search',
            input: { query: 'probe' },
            replyTo: ctx.self as unknown as ActorRef<SCRReply>,
          }, { userId: 'test-user' })
        }
        if (msg.type === 'result' || msg.type === 'error') {
          replies.push(msg)
        }
        return { state }
      },
    }

    system.spawn('probe', probeDef)
    await tick(200)

    expect(replies).toHaveLength(1)
    expect(replies[0]!.type).toBe('result')

    await system.shutdown()
  })

  test('maskState redacts the API key', () => {
    const state = {
      initialized: true,
      webSearch: { config: { apiKey: 'super-secret', count: 20 }, ref: null, gen: 0 },
      vision:    { config: null, ref: null, gen: 0 },
      audio:     { config: null, ref: null, gen: 0 },
      video:     { config: null, ref: null, gen: 0 },
      cron:       { config: null, ref: null, gen: 0 },
      pdf:        { config: null, ref: null, gen: 0 },
      fetchFile:  { config: null, ref: null, gen: 0 },
      toolStatus: { config: null, ref: null, gen: 0 },
      llmRef:     null,
      tools: {},
    }

    const masked = toolsPlugin.maskState!(state as any)

    expect((masked as typeof state).webSearch.config?.apiKey).toBe('[redacted]')
    expect((masked as typeof state).webSearch.config?.count).toBe(20)
  })

  test('maskState handles null webSearchConfig gracefully', () => {
    const state = {
      initialized: false,
      webSearch: { config: null, ref: null, gen: 0 },
      vision:    { config: null, ref: null, gen: 0 },
      audio:     { config: null, ref: null, gen: 0 },
      video:     { config: null, ref: null, gen: 0 },
      cron:       { config: null, ref: null, gen: 0 },
      pdf:        { config: null, ref: null, gen: 0 },
      fetchFile:  { config: null, ref: null, gen: 0 },
      toolStatus: { config: null, ref: null, gen: 0 },
      llmRef:     null,
      tools: {},
    }

    const masked = toolsPlugin.maskState!(state as any)

    expect((masked as typeof state).webSearch.config).toBeNull()
  })

  test('config change replaces web-search child actor', async () => {
    stubFetchOk(mockBraveResponse)

    const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor(), toolsPlugin], config: { tools: { webSearch: { apiKey: 'initial-key', count: 5 } } } }) })
    await tick()

    // Track tools_web_search registrations to verify config change spawns a new actor
    let webSearchRegistrationCount = 0
    system.subscribe(SCRRegistrationTopic, (event) => {
      const e = event as SCRRegistrationEvent
      if (e.type === 'register' && e.descriptor.urn === 'scr:leaf:tools.web_search') webSearchRegistrationCount++
    })
    // The retained event replays immediately on subscribe (gen-0 actor)
    expect(webSearchRegistrationCount).toBe(1)

    await system.control().applyConfig({
      tools: { webSearch: { apiKey: 'updated-key', count: 15 } },
    })
    await tick()

    // After config change a new actor registers (gen-1)
    expect(webSearchRegistrationCount).toBe(2)

    await system.shutdown()
  })
})
