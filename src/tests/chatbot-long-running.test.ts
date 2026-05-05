import { describe, test, expect, afterEach } from 'bun:test'
import { createPluginSystem } from '../system/index.ts'
import { OutboundMessageTopic } from '../types/events.ts'
import { createChatbotActor, type ChatbotState } from '../plugins/cognitive/chatbot.ts'
import { createLlmProviderActor, createOpenRouterAdapter } from '../plugins/cognitive/llm-provider.ts'
import toolsPlugin from '../plugins/tools/tools.plugin.ts'
import { createLongTaskActor, createInitialLongTaskState, LONG_TASK_TOOL_NAME, LONG_TASK_SCHEMA } from '../plugins/tools/long-task.ts'
import { ToolRegistrationTopic } from '../types/tools.ts'
import type { ToolMsg } from '../types/tools.ts'

// ─── Helpers ───

const tick = (ms = 100) => Bun.sleep(ms)

const CLIENT_ID = 'long-client'

const LLM_OPTS = { apiKey: 'test-key', model: 'openai/gpt-4o-mini' }

const INITIAL_CHATBOT_STATE: Omit<ChatbotState, 'llmRef'> = {
  history:          [],
  tools:            {},
  sessionUsage:     { promptTokens: 0, completionTokens: 0 },
  requestId:        null,
  turnMessages:     null,
  spanHandles:      null,
  pendingUsage:     { promptTokens: 0, completionTokens: 0 },
  pending:          '',
  pendingReasoning: '',
  pendingBatch:     null,
  userContext:      null,
  toolLoopCount:    0,
  activeClientId:   '',
}

// ─── SSE helpers ───

const makeSSEResponse = (payloads: unknown[]): Response => {
  const encoder = new TextEncoder()
  const body = payloads.map(p => `data: ${JSON.stringify(p)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(
    new ReadableStream({
      start(c) { c.enqueue(encoder.encode(body)); c.close() },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

const toolCallPayloads = (id: string, args: object) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: LONG_TASK_TOOL_NAME, arguments: '' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] },
]

const contentPayloads = (text: string) => [{ choices: [{ delta: { content: text } }] }]

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const stubLlmStream = (turns: (() => Response)[]) => {
  let i = 0
  const userMessages: unknown[][] = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('openrouter.ai/api/v1/models')) return new Response('Not Found', { status: 404 })
    if (u.includes('openrouter.ai/api/v1/chat/completions')) {
      try {
        const body = JSON.parse(String(init?.body)) as { messages: unknown[] }
        userMessages.push(body.messages)
      } catch { /* ignore */ }
      return turns[i++]?.() ?? new Response('exhausted', { status: 500 })
    }
    return new Response('not stubbed', { status: 500 })
  }) as unknown as typeof fetch
  return userMessages
}

// ─── Spawn helpers ───

type Sys = Awaited<ReturnType<typeof createPluginSystem>>

const spawnChatbot = (system: Sys, userId: string) => {
  const llmRef = system.spawn('llm-provider', createLlmProviderActor({ adapter: createOpenRouterAdapter(LLM_OPTS) }), null)
  return system.spawn(
    'chatbot',
    createChatbotActor({ clientId: CLIENT_ID, model: LLM_OPTS.model, userId }),
    { ...INITIAL_CHATBOT_STATE, llmRef },
  )
}

const collectOutbound = (system: Sys): Array<Record<string, unknown> & { type: string }> => {
  const events: Array<Record<string, unknown> & { type: string }> = []
  system.subscribe(OutboundMessageTopic, ({ text }) => {
    try { events.push(JSON.parse(text)) } catch { /* ignore */ }
  })
  return events
}

// ═══════════════════════════════════════════════════════════════════
// Long-running tool flow
// ═══════════════════════════════════════════════════════════════════

describe('chatbot long-running tool flow', () => {
  test('tool returns toolPending: placeholder turn completes, completion injection triggers a second LLM turn', async () => {
    // 3 LLM turns: (1) tool_call(long_task), (2) "I started the task" after placeholder,
    // (3) "Your task is done" after background-completion injection.
    const userMessages = stubLlmStream([
      () => makeSSEResponse(toolCallPayloads('call_lt_1', { delaySeconds: 0, message: 'final answer' })),
      () => makeSSEResponse(contentPayloads('Started; will follow up.')),
      () => makeSSEResponse(contentPayloads('Your task is done: final answer')),
    ])

    const system = await createPluginSystem({ plugins: [toolsPlugin] })

    // Wait for tools plugin (which registers long_task automatically) to start
    await tick(50)

    const userId = `long-test-${crypto.randomUUID().slice(0, 8)}`
    const events = collectOutbound(system)
    const chatbot = spawnChatbot(system, userId)
    await tick(50)

    chatbot.send({
      type: 'userMessage',
      clientId: CLIENT_ID,
      text: 'please run a long task',
      traceId: 'a'.repeat(32),
      parentSpanId: '0'.repeat(16),
    })

    // Wait for placeholder turn + first poll (2s) + completion injection turn
    await tick(2800)

    // The LLM was called 3 times
    expect(userMessages.length).toBe(3)

    // Turn 2's last message should be the placeholder tool_result
    const turn2 = userMessages[1]! as Array<{ role: string; content: unknown; tool_call_id?: string }>
    const turn2Tool = turn2.find(m => m.role === 'tool')
    expect(turn2Tool).toBeDefined()
    expect(String(turn2Tool!.content)).toContain('Started long task')

    // Turn 3 is the completion-injection turn — last message is a synthetic user
    const turn3 = userMessages[2]! as Array<{ role: string; content: unknown }>
    const turn3LastUser = [...turn3].reverse().find(m => m.role === 'user')!
    expect(String(turn3LastUser.content)).toContain('[Background tool result —')
    expect(String(turn3LastUser.content)).toContain(LONG_TASK_TOOL_NAME)
    expect(String(turn3LastUser.content)).toContain('final answer')

    await system.shutdown()
    void events  // intentionally unused beyond confirming subscription works
  })

  test('_toolUpdate stashes during awaitingLlm and replays on idle (unstashAll)', async () => {
    // Two real LLM turns.
    // Turn 1: plain content (responds to userMessage). Turn 2: plain content (responds to injection).
    const userMessages = stubLlmStream([
      () => makeSSEResponse(contentPayloads('Hello back!')),
      () => makeSSEResponse(contentPayloads('Acknowledged the background result.')),
    ])

    const system = await createPluginSystem()
    await tick(20)
    const userId = `stash-test-${crypto.randomUUID().slice(0, 8)}`
    const chatbot = spawnChatbot(system, userId)
    await tick(50)

    // Send userMessage → chatbot enters awaitingLlm
    chatbot.send({
      type: 'userMessage',
      clientId: CLIENT_ID,
      text: 'hi',
      traceId: 'a'.repeat(32),
      parentSpanId: '0'.repeat(16),
    })

    // While LLM is streaming, send _toolUpdate (will be stashed)
    chatbot.send({
      type: '_toolUpdate',
      toolName: 'fake_tool',
      toolCallId: 'call-x',
      reply: { type: 'toolResult', result: 'background work finished' },
    })

    await tick(400)

    // Both LLM turns should have happened (the _toolUpdate replayed after the first turn finished)
    expect(userMessages.length).toBe(2)
    const turn2 = userMessages[1]! as Array<{ role: string; content: unknown }>
    const lastUser = [...turn2].reverse().find(m => m.role === 'user')!
    expect(String(lastUser.content)).toContain('[Background tool result — fake_tool')
    expect(String(lastUser.content)).toContain('background work finished')

    await system.shutdown()
  })

  test('_toolUpdate with toolError injects an error-styled synthetic message', async () => {
    const userMessages = stubLlmStream([
      () => makeSSEResponse(contentPayloads('I will let you know about the error.')),
    ])

    const system = await createPluginSystem()
    await tick(20)
    const userId = `err-test-${crypto.randomUUID().slice(0, 8)}`
    const chatbot = spawnChatbot(system, userId)
    await tick(50)

    chatbot.send({
      type: '_toolUpdate',
      toolName: 'fake_tool',
      toolCallId: 'call-err',
      reply: { type: 'toolError', error: 'something blew up' },
    })

    await tick(300)

    expect(userMessages.length).toBe(1)
    const turn = userMessages[0]! as Array<{ role: string; content: unknown }>
    const lastUser = [...turn].reverse().find(m => m.role === 'user')!
    expect(String(lastUser.content)).toContain('Tool error: something blew up')
    await system.shutdown()
  })
})

// Stub long-running tool used by the first test pulls in tools.plugin's registration of long_task.
// The unused import below ensures the symbols stay in scope for type-checking.
void createLongTaskActor
void createInitialLongTaskState
void LONG_TASK_SCHEMA
void ToolRegistrationTopic
void (null as unknown as ToolMsg)
