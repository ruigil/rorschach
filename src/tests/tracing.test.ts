import { describe, test, expect, afterEach } from 'bun:test'
import { createPluginSystem, TraceTopic, type TraceSpan } from '../system/index.ts'
import type { MessageHeaders } from '../system/index.ts'
import { WsMessageTopic } from '../plugins/interfaces/http.ts'
import { createChatbotActor, type ChatbotState } from '../plugins/cognitive/chatbot.ts'
import { createLlmProviderActor, createOpenRouterAdapter } from '../plugins/cognitive/llm-provider.ts'
import toolsPlugin from '../plugins/tools/tools.plugin.ts'
import type { ToolInvokeMsg } from '../system/tools.ts'
import { ToolRegistrationTopic } from '../system/tools.ts'
import { WEB_SEARCH_SCHEMA, WEB_SEARCH_TOOL_NAME } from '../plugins/tools/web-search.ts'

// ─── Helpers ───

const tick = (ms = 100) => Bun.sleep(ms)

const CLIENT_ID = 'client-1'
const TRACE_ID = 'testtraceid'
const PARENT_SPAN_ID = 'testparentspan'

const LLM_PROVIDER_ADAPTER_OPTS = {
  apiKey: 'test-key',
  model: 'openai/gpt-4o-mini',
}

const INITIAL_CHATBOT_STATE: ChatbotState = {
  history: {},
  pending: {},
  pendingReasoning: {},
  pendingBatch: {},
  tools: {},
  spanHandles: {},
  sessionUsage: {},
  pendingUsage: {},
  modelInfo: null,
  requestMap: {},
  llmRequests: {},
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

const originalFetch = globalThis.fetch

const stubFetchSequence = (factories: (() => Response)[]) => {
  let i = 0
  globalThis.fetch = (async () => factories[i++]?.() ?? new Response('stub exhausted', { status: 500 })) as unknown as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ─── Model info stub ───
// The LlmProviderActor fetches model info on startup via fetchModelInfo.
// Tests that use stubFetchSequence must prepend this stub as the first slot.
const modelInfoStub = () => new Response('Not Found', { status: 404 })

// ─── Span collection helpers ───

const collectSpans = (system: Awaited<ReturnType<typeof createPluginSystem>>): TraceSpan[] => {
  const spans: TraceSpan[] = []
  system.subscribe(TraceTopic, span => spans.push(span))
  return spans
}

const spanFor = (spans: TraceSpan[], operation: string, status: TraceSpan['status']): TraceSpan | undefined =>
  spans.find(s => s.operation === operation && s.status === status)

// ─── Spawn helpers ───

const spawnChatbot = (system: Awaited<ReturnType<typeof createPluginSystem>>) => {
  const llmRef = system.spawn('llm-provider', createLlmProviderActor({ adapter: createOpenRouterAdapter(LLM_PROVIDER_ADAPTER_OPTS) }), null)
  system.spawn('chatbot', createChatbotActor({ llmRef, model: LLM_PROVIDER_ADAPTER_OPTS.model }), INITIAL_CHATBOT_STATE)
}

// ═══════════════════════════════════════════════════════════════════
// Distributed Tracing
// ═══════════════════════════════════════════════════════════════════

describe('distributed tracing', () => {
  test('emits chatbot and llm-call spans with correct traceId and parent chain for a direct response', async () => {
    globalThis.fetch = (async () => makeSSEResponse(contentPayloads('Hello!'))) as unknown as typeof fetch

    const system = await createPluginSystem()
    const spans = collectSpans(system)
    spawnChatbot(system)

    await tick()
    system.publish(WsMessageTopic, { clientId: CLIENT_ID, text: 'hi', traceId: TRACE_ID, parentSpanId: PARENT_SPAN_ID })
    await tick(300)

    const chatbotStart  = spanFor(spans, 'chatbot',  'started')
    const chatbotDone   = spanFor(spans, 'chatbot',  'done')
    const llmStart      = spanFor(spans, 'llm-call', 'started')
    const llmDone       = spanFor(spans, 'llm-call', 'done')

    expect(chatbotStart).toBeDefined()
    expect(chatbotDone).toBeDefined()
    expect(llmStart).toBeDefined()
    expect(llmDone).toBeDefined()

    // traceId is propagated from the incoming WsMessage
    for (const span of [chatbotStart, chatbotDone, llmStart, llmDone]) {
      expect(span!.traceId).toBe(TRACE_ID)
    }

    // chatbot span is linked to the incoming parent
    expect(chatbotStart!.parentSpanId).toBe(PARENT_SPAN_ID)

    // llm-call is a child of the chatbot span
    expect(llmStart!.parentSpanId).toBe(chatbotStart!.spanId)

    // started spans carry no duration; done spans do
    expect(chatbotStart!.durationMs).toBeUndefined()
    expect(chatbotDone!.durationMs).toBeGreaterThanOrEqual(0)
    expect(llmDone!.durationMs).toBeGreaterThanOrEqual(0)

    await system.shutdown()
  })

  test('emits tool-invoke and llm-response spans as children of the chatbot span', async () => {
    const emptyBraveResponse = {
      grounding: { generic: [], poi: null, map: [] },
      sources: {},
    }
    stubFetchSequence([
      modelInfoStub,
      () => makeSSEResponse(toolCallPayloads('call_abc', 'ai news')),
      () => new Response(JSON.stringify(emptyBraveResponse), { status: 200 }),
      () => makeSSEResponse(contentPayloads('Here is the answer.')),
    ])

    const system = await createPluginSystem({
      config: { tools: { webSearch: { apiKey: 'test-key' } } },
      plugins: [toolsPlugin],
    })
    const spans = collectSpans(system)
    spawnChatbot(system)

    await tick()
    system.publish(WsMessageTopic, { clientId: CLIENT_ID, text: 'search for ai news', traceId: TRACE_ID, parentSpanId: PARENT_SPAN_ID })
    await tick(400)

    const chatbotStart       = spanFor(spans, 'chatbot',      'started')
    const toolInvokeStart    = spanFor(spans, 'tool-invoke',  'started')
    const toolInvokeDone     = spanFor(spans, 'tool-invoke',  'done')
    const llmResponseStart   = spanFor(spans, 'llm-response', 'started')
    const llmResponseDone    = spanFor(spans, 'llm-response', 'done')

    expect(chatbotStart).toBeDefined()
    expect(toolInvokeStart).toBeDefined()
    expect(toolInvokeDone).toBeDefined()
    expect(llmResponseStart).toBeDefined()
    expect(llmResponseDone).toBeDefined()

    // all spans share the same traceId
    for (const span of [toolInvokeStart, toolInvokeDone, llmResponseStart, llmResponseDone]) {
      expect(span!.traceId).toBe(TRACE_ID)
    }

    // tool-invoke and llm-response are both direct children of the chatbot span
    expect(toolInvokeStart!.parentSpanId).toBe(chatbotStart!.spanId)
    expect(llmResponseStart!.parentSpanId).toBe(chatbotStart!.spanId)

    await system.shutdown()
  })

  test('closes chatbot and llm-call spans with error status when the LLM call fails', async () => {
    globalThis.fetch = (async () => new Response('Internal Server Error', { status: 500 })) as unknown as typeof fetch

    const system = await createPluginSystem()
    const spans = collectSpans(system)
    spawnChatbot(system)

    await tick()
    system.publish(WsMessageTopic, { clientId: CLIENT_ID, text: 'hi', traceId: TRACE_ID, parentSpanId: PARENT_SPAN_ID })
    await tick(300)

    const chatbotError = spanFor(spans, 'chatbot',  'error')
    const llmError     = spanFor(spans, 'llm-call', 'error')

    expect(chatbotError).toBeDefined()
    expect(llmError).toBeDefined()

    expect(chatbotError!.traceId).toBe(TRACE_ID)
    expect(llmError!.traceId).toBe(TRACE_ID)

    // error spans carry a durationMs so the frontend can render the bar
    expect(chatbotError!.durationMs).toBeGreaterThanOrEqual(0)
    expect(llmError!.durationMs).toBeGreaterThanOrEqual(0)

    await system.shutdown()
  })

  test('injects traceparent header into tool invocation, propagating the traceId across the actor boundary', async () => {
    let capturedHeaders: MessageHeaders | undefined

    // A fake tool actor ref that captures message headers and replies immediately
    const fakeToolRef: import('../system/types.ts').ActorRef<ToolInvokeMsg> = {
      name: 'fake-tool',
      send: (msg: ToolInvokeMsg, headers?: MessageHeaders) => {
        capturedHeaders = headers
        msg.replyTo.send({ type: 'toolResult', result: 'fake result' })
      },
    }

    stubFetchSequence([
      modelInfoStub,
      () => makeSSEResponse(toolCallPayloads('call_trace', 'query')),
      () => makeSSEResponse(contentPayloads('Done.')),
    ])

    const system = await createPluginSystem()
    const spans = collectSpans(system)
    // Retain the tool before spawning chatbot — replayed on subscribe during chatbot's start lifecycle
    system.publishRetained(ToolRegistrationTopic, WEB_SEARCH_TOOL_NAME, { name: WEB_SEARCH_TOOL_NAME, schema: WEB_SEARCH_SCHEMA, ref: fakeToolRef })
    spawnChatbot(system)

    await tick()
    system.publish(WsMessageTopic, { clientId: CLIENT_ID, text: 'search test', traceId: TRACE_ID, parentSpanId: PARENT_SPAN_ID })
    await tick(400)

    // The traceparent header must be present and well-formed (W3C trace context format)
    expect(capturedHeaders?.['traceparent']).toBeDefined()
    const parts = (capturedHeaders!['traceparent'] as string).split('-')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('00')       // version
    expect(parts[1]).toBe(TRACE_ID)   // traceId propagated unchanged
    expect(parts[3]).toBe('01')       // flags

    // The span ID in the header must match the tool-invoke span emitted to TraceTopic
    const toolInvokeSpan = spanFor(spans, 'tool-invoke', 'started')
    expect(toolInvokeSpan).toBeDefined()
    expect(parts[2]).toBe(toolInvokeSpan!.spanId)

    await system.shutdown()
  })
})
