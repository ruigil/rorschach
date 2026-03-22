import { describe, test, expect, afterEach } from 'bun:test'
import { createPluginSystem, TraceTopic, type TraceSpan } from '../system/index.ts'
import type { ActorDef, MessageHeaders } from '../system/index.ts'
import { WsMessageTopic } from '../plugins/interfaces/http.ts'
import { createChatbotActor, type ChatbotActorOptions, type ChatbotState } from '../plugins/cognitive/chatbot.ts'
import toolsPlugin from '../plugins/tools/tools.plugin.ts'
import type { GetToolsMsg } from '../plugins/tools/tools.plugin.ts'
import type { ToolInvokeMsg } from '../plugins/tools/tool.ts'
import { WEB_SEARCH_SCHEMA, WEB_SEARCH_TOOL_NAME } from '../plugins/tools/web-search.ts'

// ─── Helpers ───

const tick = (ms = 100) => Bun.sleep(ms)

const CLIENT_ID = 'client-1'
const TRACE_ID = 'testtraceid'
const PARENT_SPAN_ID = 'testparentspan'

const CHATBOT_OPTS: ChatbotActorOptions = {
  apiKey: 'test-key',
  model: 'openai/gpt-4o-mini',
}

const INITIAL_CHATBOT_STATE: ChatbotState = {
  history: {},
  pending: {},
  pendingReasoning: {},
  pendingBatch: {},
  toolsRef: null,
  spanHandles: {},
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

// ─── Span collection helpers ───

const collectSpans = (system: Awaited<ReturnType<typeof createPluginSystem>>): TraceSpan[] => {
  const spans: TraceSpan[] = []
  system.subscribe(TraceTopic, span => spans.push(span))
  return spans
}

const spanFor = (spans: TraceSpan[], operation: string, status: TraceSpan['status']): TraceSpan | undefined =>
  spans.find(s => s.operation === operation && s.status === status)

// ═══════════════════════════════════════════════════════════════════
// Distributed Tracing
// ═══════════════════════════════════════════════════════════════════

describe('distributed tracing', () => {
  test('emits chatbot and llm-call spans with correct traceId and parent chain for a direct response', async () => {
    globalThis.fetch = (async () => makeSSEResponse(contentPayloads('Hello!'))) as unknown as typeof fetch

    const system = await createPluginSystem()
    const spans = collectSpans(system)
    system.spawn('chatbot', createChatbotActor(CHATBOT_OPTS), INITIAL_CHATBOT_STATE)

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
      () => makeSSEResponse(toolCallPayloads('call_abc', 'ai news')),
      () => new Response(JSON.stringify(emptyBraveResponse), { status: 200 }),
      () => makeSSEResponse(contentPayloads('Here is the answer.')),
    ])

    const system = await createPluginSystem({
      config: { tools: { webSearch: { apiKey: 'test-key' } } },
      plugins: [toolsPlugin],
    })
    const spans = collectSpans(system)
    system.spawn('chatbot', createChatbotActor(CHATBOT_OPTS), INITIAL_CHATBOT_STATE)

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
    system.spawn('chatbot', createChatbotActor(CHATBOT_OPTS), INITIAL_CHATBOT_STATE)

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

    // A minimal tools actor that returns the fake tool when asked
    const fakeToolsDef: ActorDef<GetToolsMsg, null> = {
      handler: (state, msg) => {
        if (msg.type === 'getTools') {
          msg.replyTo.send({ [WEB_SEARCH_TOOL_NAME]: { schema: WEB_SEARCH_SCHEMA, ref: fakeToolRef } })
        }
        return { state }
      },
    }

    stubFetchSequence([
      () => makeSSEResponse(toolCallPayloads('call_trace', 'query')),
      () => makeSSEResponse(contentPayloads('Done.')),
    ])

    const system = await createPluginSystem()
    const spans = collectSpans(system)
    system.spawn('tools', fakeToolsDef, null)    // registers at system/tools
    system.spawn('chatbot', createChatbotActor(CHATBOT_OPTS), INITIAL_CHATBOT_STATE)

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
