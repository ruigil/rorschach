import { describe, test, expect, afterEach } from 'bun:test'
import { createPluginSystem } from '../system/index.ts'
import { WsSendTopic } from '../system/topics.ts'
import { createReActActor, type ReActState } from '../plugins/cognitive/react.ts'
import { createLlmProviderActor, createOpenRouterAdapter } from '../plugins/cognitive/llm-provider.ts'
import toolsPlugin from '../plugins/tools/tools.plugin.ts'
import type { BraveLlmContextResponse } from '../plugins/tools/web-search.ts'


// ─── Helpers ───

const tick = (ms = 100) => Bun.sleep(ms)

const CLIENT_ID = 'client-1'

const LLM_PROVIDER_ADAPTER_OPTS = {
  apiKey: 'test-openrouter-key',
  model: 'openai/gpt-4o-mini',
}

const INITIAL_REACT_STATE: ReActState = {
  history:          [],
  tools:            {},
  modelInfo:        null,
  sessionUsage:     { promptTokens: 0, completionTokens: 0 },
  requestId:        null,
  turnMessages:     null,
  spanHandles:      null,
  pendingUsage:     { promptTokens: 0, completionTokens: 0 },
  pending:          '',
  pendingReasoning: '',
  pendingBatch:     null,
}

const mockBraveResponse: BraveLlmContextResponse = {
  grounding: {
    generic: [
      { url: 'https://example.com/page', title: 'Example Page', snippets: ['Relevant snippet.'] },
    ],
    poi: null,
    map: [],
  },
  sources: {
    'example.com': { title: 'Example', hostname: 'example.com', age: [null] },
  },
}

// ─── SSE helpers ───

const makeSSEResponse = (payloads: unknown[]): Response => {
  const encoder = new TextEncoder()
  const body = payloads.map(p => `data: ${JSON.stringify(p)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

const toolCallPayloads = (id: string, query: string) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'web_search', arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ query }) } }] } }] },
]

const contentPayloads = (text: string) => [
  { choices: [{ delta: { content: text } }] },
]

// Sequence-aware fetch stub: each call returns the next factory's result
const originalFetch = globalThis.fetch

const stubFetchSequence = (factories: (() => Response)[]) => {
  let i = 0
  globalThis.fetch = (async () => factories[i++]?.() ?? new Response('stub exhausted', { status: 500 })) as unknown as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ─── Collect WsSendTopic events ───

type ParsedEvent = Record<string, unknown> & { type: string }

const collectEvents = (system: Awaited<ReturnType<typeof createPluginSystem>>): ParsedEvent[] => {
  const events: ParsedEvent[] = []
  system.subscribe(WsSendTopic, ({ text }) => {
    try { events.push(JSON.parse(text) as ParsedEvent) } catch { /* ignore */ }
  })
  return events
}

// ─── Model info stub ───
// The LlmProviderActor fetches model info on startup via fetchModelInfo.
// Tests that use stubFetchSequence must prepend this stub as the first slot.
const modelInfoStub = () => new Response('Not Found', { status: 404 })

// ─── Spawn helpers ───

const spawnReAct = (system: Awaited<ReturnType<typeof createPluginSystem>>) => {
  const llmRef = system.spawn('llm-provider', createLlmProviderActor({ adapter: createOpenRouterAdapter(LLM_PROVIDER_ADAPTER_OPTS) }), null)
  return system.spawn('react', createReActActor({ clientId: CLIENT_ID, llmRef, model: LLM_PROVIDER_ADAPTER_OPTS.model }), INITIAL_REACT_STATE)
}

// ═══════════════════════════════════════════════════════════════════
// Chatbot + search integration
// ═══════════════════════════════════════════════════════════════════

describe('ReAct search integration', () => {
  test('emits searching event and tool call flow when LLM returns a tool_call', async () => {
    stubFetchSequence([
      modelInfoStub,
      () => makeSSEResponse(toolCallPayloads('call_abc', 'latest AI news')),
      () => new Response(JSON.stringify(mockBraveResponse), { status: 200 }),
      () => makeSSEResponse(contentPayloads('Here is what I found.')),
    ])

    const system = await createPluginSystem({
      config: { tools: { webSearch: { apiKey: 'brave-key' } } },
      plugins: [toolsPlugin],
    })
    const events = collectEvents(system)
    const react = spawnReAct(system)

    await tick()
    react.send({ type: 'userMessage', text: 'What is the latest AI news?', traceId: 'test-trace-1', parentSpanId: 'test-span-1' })
    await tick(400)

    const types = events.map(e => e.type)
    expect(types).toContain('searching')
    expect(types).toContain('chunk')
    expect(types).toContain('done')
    // searching must arrive before the first chunk
    expect(types.indexOf('searching')).toBeLessThan(types.indexOf('chunk'))

    await system.shutdown()
  })

  test('emits sources event with grounding items before done', async () => {
    stubFetchSequence([
      modelInfoStub,
      () => makeSSEResponse(toolCallPayloads('call_xyz', 'test query')),
      () => new Response(JSON.stringify(mockBraveResponse), { status: 200 }),
      () => makeSSEResponse(contentPayloads('Answer based on search results.')),
    ])

    const system = await createPluginSystem({
      config: { tools: { webSearch: { apiKey: 'brave-key' } } },
      plugins: [toolsPlugin],
    })
    const events = collectEvents(system)
    const react = spawnReAct(system)

    await tick()
    react.send({ type: 'userMessage', text: 'search for something', traceId: 'test-trace-1', parentSpanId: 'test-span-1' })
    await tick(400)

    const sourcesEvent = events.find(e => e.type === 'sources')
    expect(sourcesEvent).toBeDefined()

    const sources = sourcesEvent?.sources as Array<{ url: string; title: string }>
    expect(sources).toHaveLength(1)
    expect(sources[0]?.url).toBe('https://example.com/page')
    expect(sources[0]?.title).toBe('Example Page')

    // sources must arrive before done
    const types = events.map(e => e.type)
    expect(types.indexOf('sources')).toBeLessThan(types.indexOf('done'))

    await system.shutdown()
  })

  test('calls LLM without tools when web-search actor is not available', async () => {
    let capturedBody: { tools?: unknown } | undefined

    globalThis.fetch = (async (_: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string) as typeof capturedBody
      return makeSSEResponse(contentPayloads('Direct answer, no search needed.'))
    }) as unknown as typeof fetch

    // No tools plugin — ReAct has no registered tools, LLM call uses empty tool list
    const system = await createPluginSystem()
    const events = collectEvents(system)
    const react = spawnReAct(system)

    await tick()
    react.send({ type: 'userMessage', text: 'hello', traceId: 'test-trace-1', parentSpanId: 'test-span-1' })
    await tick(300)

    expect(capturedBody?.tools).toBeUndefined()
    expect(events.some(e => e.type === 'done')).toBe(true)

    await system.shutdown()
  })

  test('continues with LLM call using error content when search returns an error', async () => {
    stubFetchSequence([
      modelInfoStub,
      () => makeSSEResponse(toolCallPayloads('call_err', 'failing query')),
      () => new Response('Rate limited', { status: 429 }),
      () => makeSSEResponse(contentPayloads('I could not search but here is my best answer.')),
    ])

    const system = await createPluginSystem({
      config: { tools: { webSearch: { apiKey: 'brave-key' } } },
      plugins: [toolsPlugin],
    })
    const events = collectEvents(system)
    const react = spawnReAct(system)

    await tick()
    react.send({ type: 'userMessage', text: 'search for something', traceId: 'test-trace-1', parentSpanId: 'test-span-1' })
    await tick(400)

    const types = events.map(e => e.type)
    // Should get a normal response, not an error bubble
    expect(types).toContain('done')
    expect(types).not.toContain('error')
    // No sources since search failed
    expect(types).not.toContain('sources')

    await system.shutdown()
  })

  test('includes tools in LLM request when web-search actor is available', async () => {
    let capturedBody: { tools?: Array<{ function: { name: string } }> } | undefined

    // Intercept and capture the request body
    globalThis.fetch = (async (_: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string) as typeof capturedBody
      return makeSSEResponse(contentPayloads('No tool call needed.'))
    }) as unknown as typeof fetch

    const system = await createPluginSystem({
      config: { tools: { webSearch: { apiKey: 'brave-key' } } },
      plugins: [toolsPlugin],
    })
    const react = spawnReAct(system)

    await tick()
    react.send({ type: 'userMessage', text: 'hello', traceId: 'test-trace-1', parentSpanId: 'test-span-1' })
    await tick(300)

    expect(capturedBody?.tools).toBeDefined()
    expect(capturedBody?.tools?.[0]?.function?.name).toBe('web_search')

    await system.shutdown()
  })
})
