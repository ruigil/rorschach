import { describe, test, expect, afterEach } from 'bun:test'
import { AgentSystem, invokeSCR, staticSource, TraceTopic, type TraceSpan } from '../system/index.ts'
import { MockPersistenceActor } from './mock-persistence.ts'
import cognitivePlugin from '../plugins/cognitive/cognitive.plugin.ts'
import notebookPlugin from '../plugins/notebook/notebook.plugin.ts'
import { createMessageRequest, requestStorage } from '../system/context/request.ts'

const tick = (ms = 100) => Bun.sleep(ms)

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

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

const toolCallPayloads = (id: string, name: string, args: string) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] },
  { usage: { prompt_tokens: 15, completion_tokens: 10 } },
]

const stubFetchByUrl = (completions: (() => Response)[]) => {
  let ci = 0
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    if (u.includes('openrouter.ai/api/v1/models')) return new Response('Not Found', { status: 404 })
    return completions[ci++]?.() ?? new Response('stub exhausted', { status: 500 })
  }) as unknown as typeof fetch
}

describe('Coach Agent & Chatbot Trace Lifecycle', () => {
  test('chatbot -> coach -> notebook_journal_write builds correct trace tree and finishes all spans', async () => {
    const spans: TraceSpan[] = []

    stubFetchByUrl([
      // Turn 1 (Chatbot): calls notebook_coach
      () => makeSSEResponse(toolCallPayloads('call_chat_1', 'notebook_coach', JSON.stringify({ prompt: 'Please write a journal entry: Had a productive morning.' }))),
      // Turn 1 (Coach): calls notebook_journal_write
      () => makeSSEResponse(toolCallPayloads('call_coach_jw', 'notebook_journal_write', JSON.stringify({ entry: 'Had a productive morning.' }))),
      // Turn 2 (Coach): completes with confirmation
      () => makeSSEResponse(toolCallPayloads('call_coach_done', 'scr_complete', JSON.stringify({ text: 'Journal entry successfully saved.' }))),
      // Turn 2 (Chatbot): completes with final answer
      () => makeSSEResponse(toolCallPayloads('call_chat_done', 'scr_complete', JSON.stringify({ text: 'I have recorded your journal entry: Had a productive morning.' }))),
    ])

    const system = await AgentSystem({
      source: staticSource({
        plugins: [MockPersistenceActor(), cognitivePlugin, notebookPlugin],
        config: {
          cognitive: {
            llmProvider: {
              provider: 'openrouter',
              apiKey: 'test-key',
            }
          }
        }
      })
    })

    // Capture all spans published to TraceTopic
    system.subscribe(TraceTopic, (span) => {
      spans.push(span)
    })

    await tick()

    const initialTraceId = 'trace-chat-journal-123'
    const initialSpanId = 'span-root-req-001'
    const testReq = createMessageRequest({
      traceId: initialTraceId,
      spanId: initialSpanId,
      userId: 'test-user',
    })

    const reply = await requestStorage.run(testReq, () =>
      invokeSCR('scr:reasoner:cognitive.chatbot', { prompt: 'Write a journal entry for me: Had a productive morning.' })
    )

    await tick(150)

    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      expect((reply.output as any).text).toContain('Had a productive morning.')
    }

    // Verify spans were emitted
    expect(spans.length).toBeGreaterThan(0)

    // All spans must have traceId = initialTraceId
    for (const span of spans) {
      expect(span.traceId).toBe(initialTraceId)
    }

    // Group spans by spanId
    const spanMap = new Map<string, { started?: TraceSpan; done?: TraceSpan; error?: TraceSpan; operations: string[]; actor: string }>()
    for (const span of spans) {
      const entry = spanMap.get(span.spanId) ?? { operations: [], actor: span.actor }
      if (span.status === 'started') entry.started = span
      if (span.status === 'done') entry.done = span
      if (span.status === 'error') entry.error = span
      entry.operations.push(span.operation)
      spanMap.set(span.spanId, entry)
    }

    // 1. Verify that NO span remains in 'started' state without a 'done' or 'error' state
    for (const [spanId, entry] of spanMap) {
      expect(entry.started).toBeDefined()
      expect(entry.done !== undefined || entry.error !== undefined).toBe(true)
    }

    // 2. Check operations captured in the trace tree
    const allOperations = spans.map(s => s.operation)
    expect(allOperations).toContain('agent-runner')
    expect(allOperations).toContain('llm-call')
    expect(allOperations).toContain('tool-invoke')
    expect(allOperations).toContain('scr:leaf:notebook.journal_write')

    // 3. Verify parent-child span hierarchy linkage:
    // - Chatbot agent-runner
    const chatbotRunnerSpan = Array.from(spanMap.values()).find(e => e.started?.operation === 'agent-runner' && e.started?.data?.mode === 'cognitive.chatbot')
    expect(chatbotRunnerSpan).toBeDefined()

    // - Chatbot tool-invoke for notebook_coach has parentSpanId === chatbotRunnerSpan.spanId
    const coachToolInvokeSpan = Array.from(spanMap.values()).find(e => e.started?.operation === 'tool-invoke' && e.started?.data?.toolName === 'notebook_coach')
    expect(coachToolInvokeSpan).toBeDefined()
    expect(coachToolInvokeSpan?.started?.parentSpanId).toBe(chatbotRunnerSpan?.started?.spanId)

    // - Coach agent-runner
    const coachRunnerSpan = Array.from(spanMap.values()).find(e => e.started?.operation === 'agent-runner' && e.started?.data?.mode === 'notebook.coach')
    expect(coachRunnerSpan).toBeDefined()

    // - Coach tool-invoke for notebook_journal_write has parentSpanId === coachRunnerSpan.spanId
    const journalToolInvokeSpan = Array.from(spanMap.values()).find(e => e.started?.operation === 'tool-invoke' && e.started?.data?.toolName === 'notebook_journal_write')
    expect(journalToolInvokeSpan).toBeDefined()
    expect(journalToolInvokeSpan?.started?.parentSpanId).toBe(coachRunnerSpan?.started?.spanId)

    // - Leaf journal write actor span
    const journalLeafSpan = Array.from(spanMap.values()).find(e => e.started?.operation === 'scr:leaf:notebook.journal_write')
    expect(journalLeafSpan).toBeDefined()

    await system.shutdown()
  })
})
