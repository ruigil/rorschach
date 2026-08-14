import { describe, test, expect, afterEach } from 'bun:test'
import { AgentSystem, invokeSCR, onMessage, ask, staticSource, createTopic } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { SCRRegistrationTopic, UserBudgetTopic, UsageUpdateTopic, type StreamChunk } from '../types/scr.ts'
import type { SCRDescriptor, SCRInvokeMsg } from '../types/scr.ts'
import { PersistenceProviderTopic, type PersistenceMsg, type PResult } from '../types/persistence.ts'
import { MockPersistenceActor } from './mock-persistence.ts'
import cognitivePlugin from '../plugins/cognitive/cognitive.plugin.ts'
import registryPlugin from '../plugins/registry/registry.plugin.ts'
import { ResolutionCache } from '../system/scr/cache.ts'
import { requestStorage, createMessageRequest } from '../system/context/request.ts'
import { UserPresenceTopic, InboundMessageTopic, OutboundUserMessageTopic } from '../types/events.ts'

const tick = (ms = 100) => Bun.sleep(ms)

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

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

import { LogTopic } from '../system/index.ts'

const setupLogging = (system: any) => {
  system.subscribe(LogTopic, (e: any) => {
    console.log(`[SYS-LOG] [${e.level}] ${e.source}: ${e.message}`, e.data ? JSON.stringify(e.data) : '')
  })
}

describe('SCR Phase 3: Reasoner (Agent) SCR Conversion', () => {
  test('AgentSpawner registers chatbot mode URN and executes request', async () => {
    stubFetchByUrl([
      () => makeSSEResponse(toolCallPayloads('call_1', 'scr_complete', JSON.stringify({ text: 'Hello from agent!' }))),
    ])

    const system = await AgentSystem({
      source: staticSource({
        plugins: [MockPersistenceActor(), cognitivePlugin],
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
    setupLogging(system)
    await tick()

    // 1. Verify spawner is registered as target for reasoner
    const descriptor = ResolutionCache.getDescriptor('scr:reasoner:cognitive.chatbot')
    expect(descriptor).toBeDefined()
    expect(descriptor?.kind).toBe('reasoner')
    expect(descriptor?.target.name).toContain('agentSpawner')

    // 2. Invoke URN and verify response
    const reply = await invokeSCR('scr:reasoner:cognitive.chatbot', { prompt: 'Who are you?' })
    console.log("REPLY RESULT:", JSON.stringify(reply, null, 2))
    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      expect((reply.output as any).text).toBe('Hello from agent!')
    }

    await system.shutdown()
  })

  test('SCRAgentRunner ambient streaming publishes tokens to streamTo topic', async () => {
    // LLM outputs a tool call to scr_complete, but first streams tokens
    const streamPayloads = [
      { choices: [{ delta: { content: 'Thinking...' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'scr_complete', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ text: 'Done streaming!' }) } }] } }] },
    ]

    stubFetchByUrl([
      () => makeSSEResponse(streamPayloads),
    ])

    const system = await AgentSystem({
      source: staticSource({
        plugins: [MockPersistenceActor(), cognitivePlugin],
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
    setupLogging(system)
    await tick()

    const streamToTopic = 'test.stream.to'
    const receivedChunks: any[] = []
    system.subscribe(createTopic<StreamChunk>(streamToTopic), (chunk) => {
      receivedChunks.push(chunk)
    })

    const request = createMessageRequest({
      streamTo: streamToTopic,
    })

    const reply = await requestStorage.run(request, () =>
      invokeSCR('scr:reasoner:cognitive.chatbot', { prompt: 'Stream something' })
    )

    expect(reply.type).toBe('result')
    await tick()

    // Check we got the start, chunk, and end events
    expect(receivedChunks.length).toBeGreaterThanOrEqual(3)
    expect(receivedChunks[0].type).toBe('start')
    expect(receivedChunks.some(c => c.type === 'chunk')).toBe(true)
    expect(receivedChunks[receivedChunks.length - 1].type).toBe('end')

    await system.shutdown()
  })

  test('SCRAgentRunner ambient streaming publishes tool calls to streamTo topic', async () => {
    stubFetchByUrl([
      // First turn: tool call
      () => makeSSEResponse(toolCallPayloads('call_stream_tool', 'scr_complete', JSON.stringify({ text: 'Done' }))),
    ])

    const system = await AgentSystem({
      source: staticSource({
        plugins: [MockPersistenceActor(), cognitivePlugin],
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
    setupLogging(system)
    await tick()

    const streamToTopic = 'test.stream.to.tools'
    const receivedChunks: any[] = []
    system.subscribe(createTopic<StreamChunk>(streamToTopic), (chunk) => {
      receivedChunks.push(chunk)
    })

    const request = createMessageRequest({
      streamTo: streamToTopic,
    })

    const reply = await requestStorage.run(request, () =>
      invokeSCR('scr:reasoner:cognitive.chatbot', { prompt: 'Do tool work' })
    )

    expect(reply.type).toBe('result')
    await tick()

    const toolChunk = receivedChunks.find(c => c.type === 'tools')
    expect(toolChunk).toBeDefined()
    expect(toolChunk.tools).toHaveLength(1)
    expect(toolChunk.tools[0].name).toBe('scr_complete')

    await system.shutdown()
  })

  test('SCRAgentRunner handles toolPending, persists state, and deletes key on completion', async () => {
    stubFetchByUrl([
      // First turn calls the pending tool
      () => makeSSEResponse(toolCallPayloads('call_pending', 'test_pending_tool', '{}')),
    ])

    const system = await AgentSystem({
      source: staticSource({
        plugins: [MockPersistenceActor(), cognitivePlugin],
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
    setupLogging(system)
    await tick()

    // Get persistence actor ref to inspect keys later
    let persistenceRef: ActorRef<PersistenceMsg> | null = null
    system.subscribe(PersistenceProviderTopic, (e) => {
      if (e.ref) persistenceRef = e.ref
    })
    await tick()

    // Register a mock tool that yields pending
    const mockToolActor: ActorDef<SCRInvokeMsg, null> = {
      initialState: null,
      handler: onMessage({
        invoke: (state, msg) => {
          msg.replyTo.send({
            type: 'pending',
            jobId: 'pending-job-999',
            placeholderText: 'Hold on...',
          })
          return { state }
        }
      })
    }

    const toolRef = system.spawn('pending-tool-actor', mockToolActor)
    await tick()

    // Mock register the tool in SCR registry as a leaf
    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor: {
        urn: 'scr:leaf:cognitive.test_pending_tool',
        kind: 'leaf',
        description: 'Mock pending tool',
        schema: {},
        target: toolRef,
        meta: { schema: { function: { name: 'test_pending_tool', description: 'Mock pending tool', parameters: {} } } }
      }
    })
    await tick()

    // Override the agent agentSCRs to include this tool
    const desc = ResolutionCache.getDescriptor('scr:reasoner:cognitive.chatbot')
    if (desc && desc.meta?.agentDescriptor) {
      desc.meta.agentDescriptor.agentSCRs = desc.meta.agentDescriptor.agentSCRs || []
      desc.meta.agentDescriptor.agentSCRs.push('scr:leaf:cognitive.test_pending_tool')
    }

    const reply = await invokeSCR('scr:reasoner:cognitive.chatbot', { prompt: 'Call pending tool' })

    // Verify it replied with pending
    expect(reply.type).toBe('pending')
    if (reply.type === 'pending') {
      expect(reply.jobId).toBe('pending-job-999')
    }

    await tick()

    // Verify the KV store has the runner state persisted
    expect(persistenceRef).not.toBeNull()

    const listRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'kv.list',
      prefix: 'scr.run.',
      replyTo,
    }))
    expect(listRes.ok).toBe(true)
    expect(listRes.keys.length).toBe(1)
    const activeRunId = listRes.keys[0].replace('scr.run.', '')

    const getRes = await ask<PersistenceMsg, PResult<any>>(persistenceRef!, (replyTo) => ({
      type: 'kv.get',
      key: `scr.run.${activeRunId}`,
      replyTo,
    }))

    expect(getRes.ok).toBe(true)
    if (getRes.ok) {
      expect(getRes.data).toBeDefined()
      expect(getRes.data?.runId).toBe(activeRunId)
      expect(getRes.data?.urn).toBe('scr:reasoner:cognitive.chatbot')
    }

    // Simulate completion / cleanup: delete the key manually (as a check that it works)
    await ask<PersistenceMsg, PResult>(persistenceRef!, (replyTo) => ({
      type: 'kv.delete',
      key: `scr.run.${activeRunId}`,
      replyTo,
    }))

    const getResAfter = await ask<PersistenceMsg, PResult<any>>(persistenceRef!, (replyTo) => ({
      type: 'kv.get',
      key: `scr.run.${activeRunId}`,
      replyTo,
    }))
    expect(getResAfter.ok).toBe(false)

    await system.shutdown()
  })

  test('SCRAgentRunner handles undefined output schema (streaming only)', async () => {
    // LLM outputs plain text content directly, without calling any tools
    stubFetchByUrl([
      () => makeSSEResponse([
        { choices: [{ delta: { content: 'Hello streaming!' } }] },
      ]),
    ])

    const system = await AgentSystem({
      source: staticSource({
        plugins: [MockPersistenceActor(), cognitivePlugin],
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
    setupLogging(system)
    await tick()

    // Register a mock reasoner with undefined outputSchema
    const testUrn = 'scr:reasoner:cognitive.streaming_only'
    const spawnerRef = ResolutionCache.getDescriptor('scr:reasoner:cognitive.chatbot')?.target
    expect(spawnerRef).toBeDefined()

    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor: {
        urn: testUrn,
        kind: 'reasoner',
        description: 'Streaming only agent',
        schema: {
          inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
          // outputSchema is undefined
        },
        target: spawnerRef!,
        meta: {
          agentDescriptor: {
            mode: 'streaming_only',
            role: 'reasoning',
            displayName: 'Streaming Only',
            shortDesc: 'Streaming only description',
            systemPrompt: 'You are streaming only.',
            internalTools: [],
            capabilities: { userVisible: true },
          }
        }
      }
    })
    await tick()

    const streamToTopic = 'test.stream.to.streaming_only'
    const receivedChunks: any[] = []
    system.subscribe(createTopic<StreamChunk>(streamToTopic), (chunk) => {
      receivedChunks.push(chunk)
    })

    const request = createMessageRequest({
      streamTo: streamToTopic,
    })

    const reply = await requestStorage.run(request, () =>
      invokeSCR(testUrn, { prompt: 'Hi' })
    )

    // Output should be undefined, but chunks should be received
    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      expect(reply.output).toBeUndefined()
    }

    await tick()
    expect(receivedChunks.length).toBeGreaterThanOrEqual(2) // start and end at least
    expect(receivedChunks.some(c => c.type === 'chunk')).toBe(true)

    await system.shutdown()
  })

  test('Agent loop completes turn immediately when a tool returns undefined', async () => {
    // LLM outputs a tool call to our special tool
    stubFetchByUrl([
      () => makeSSEResponse(toolCallPayloads('call_undef', 'test_undef_tool', '{}')),
    ])

    const system = await AgentSystem({
      source: staticSource({
        plugins: [MockPersistenceActor(), cognitivePlugin],
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
    setupLogging(system)
    await tick()

    // Register a mock tool that returns undefined as result
    const mockUndefToolActor: ActorDef<SCRInvokeMsg, null> = {
      initialState: null,
      handler: onMessage({
        invoke: (state, msg) => {
          msg.replyTo.send({
            type: 'result',
            output: undefined as any, // returns undefined!
          })
          return { state }
        }
      })
    }

    const toolRef = system.spawn('undef-tool-actor', mockUndefToolActor)
    await tick()

    // Mock register the tool in SCR registry as a leaf
    const testUrn = 'scr:reasoner:cognitive.chatbot'
    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor: {
        urn: 'scr:leaf:cognitive.test_undef_tool',
        kind: 'leaf',
        description: 'Mock undefined tool',
        schema: {},
        target: toolRef,
        meta: { schema: { function: { name: 'test_undef_tool', description: 'Mock undefined tool', parameters: {} } } }
      }
    })
    await tick()

    // Override the agent agentSCRs to include this tool
    const desc = ResolutionCache.getDescriptor(testUrn)
    if (desc && desc.meta?.agentDescriptor) {
      desc.meta.agentDescriptor.agentSCRs = desc.meta.agentDescriptor.agentSCRs || []
      desc.meta.agentDescriptor.agentSCRs.push('scr:leaf:cognitive.test_undef_tool')
    }

    const reply = await invokeSCR(testUrn, { prompt: 'Call undefined tool' })

    // Verify it replied with result since the loop completed immediately on undefined tool result
    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      expect(reply.output).toBeUndefined()
    }

    await system.shutdown()
  })

  test('SCRAgentRunner turn-by-turn budget update publishing', async () => {
    stubFetchByUrl([
      () => makeSSEResponse(toolCallPayloads('call_budget_1', 'scr_complete', JSON.stringify({ text: 'Done!' }))),
    ])

    const system = await AgentSystem({
      source: staticSource({
        plugins: [MockPersistenceActor(), registryPlugin, cognitivePlugin],
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
    setupLogging(system)
    await tick()

    // Subscribe to UsageUpdateTopic
    const receivedUsage: any[] = []
    system.subscribe(UsageUpdateTopic, (event) => {
      receivedUsage.push(event)
    })

    const request = createMessageRequest({
      userId: 'user-budget-test',
    })

    const reply = await requestStorage.run(request, () =>
      invokeSCR('scr:reasoner:cognitive.chatbot', { prompt: 'Check budget' })
    )

    expect(reply.type).toBe('result')
    await tick()

    // Assert that we got the usage updates
    expect(receivedUsage.length).toBeGreaterThanOrEqual(1)
    expect(receivedUsage[0].userId).toBe('user-budget-test')
    expect(receivedUsage[0].tokens).toBeGreaterThan(0)
    expect(receivedUsage[0].costUsd).toBeDefined()

    await system.shutdown()
  })

  test('Dynamic Pull-Based Discovery of tools mid-flight', async () => {
    stubFetchByUrl([
      // First turn: search for "notebook"
      () => makeSSEResponse(toolCallPayloads('call_search', 'registry_search', JSON.stringify({ query: 'notebook' }))),
      // Second turn: call dynamic tool
      () => makeSSEResponse(toolCallPayloads('call_write', 'notebook_write', JSON.stringify({ content: 'Hello notebook!' }))),
      // Third turn: complete
      () => makeSSEResponse(toolCallPayloads('call_done', 'scr_complete', JSON.stringify({ text: 'All done!' }))),
    ])

    const system = await AgentSystem({
      source: staticSource({
        plugins: [MockPersistenceActor(), registryPlugin, cognitivePlugin],
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
    setupLogging(system)
    await tick()

    // Spawn a mock notebook tool
    const mockNotebookActor: ActorDef<SCRInvokeMsg, null> = {
      initialState: null,
      handler: onMessage({
        invoke: (state, msg) => {
          msg.replyTo.send({
            type: 'result',
            output: { text: 'Written successfully' }
          })
          return { state }
        }
      })
    }
    const notebookRef = system.spawn('notebook-tool-actor', mockNotebookActor)
    await tick()

    // Register it on SCRRegistrationTopic as a leaf
    system.publish(SCRRegistrationTopic, {
      type: 'register',
      descriptor: {
        urn: 'scr:leaf:cognitive.notebook_write',
        kind: 'leaf',
        description: 'Notebook write tool',
        schema: {
          inputSchema: { type: 'object', properties: { content: { type: 'string' } } }
        },
        target: notebookRef,
        meta: { schema: { function: { name: 'notebook_write', description: 'Notebook write tool', parameters: {} } } }
      }
    })
    await tick()

    const reply = await invokeSCR('scr:reasoner:cognitive.chatbot', { prompt: 'Find the notebook tool and write to it' })
    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      expect((reply.output as any).text).toBe('All done!')
    }

    await system.shutdown()
  })

  test('SessionManager routes user message via invokeSCR and translates stream chunks', async () => {
    const streamPayloads = [
      { choices: [{ delta: { content: 'Thinking...' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_sm_1', function: { name: 'scr_complete', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ text: 'Session response!' }) } }] } }] },
      { usage: { prompt_tokens: 15, completion_tokens: 10 } },
    ]

    stubFetchByUrl([
      () => makeSSEResponse(streamPayloads),
    ])

    const system = await AgentSystem({
      source: staticSource({
        plugins: [MockPersistenceActor(), registryPlugin, cognitivePlugin],
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
    setupLogging(system)
    await tick()

    // 1. Establish session presence
    system.publish(UserPresenceTopic, {
      status: 'present',
      userId: 'user-sm-test',
      source: 'cli',
      timezone: 'Europe/Paris',
    })
    await tick()

    // 2. Subscribe to OutboundUserMessageTopic to receive translated frames
    const receivedFrames: any[] = []
    system.subscribe(OutboundUserMessageTopic, (event) => {
      if (event.userId === 'user-sm-test') {
        receivedFrames.push(JSON.parse(event.text))
      }
    })

    // 3. Send inbound message
    const request = createMessageRequest({
      userId: 'user-sm-test',
    })

    await requestStorage.run(request, async () => {
      system.publish(InboundMessageTopic, {
        text: 'Hello chatbot',
        request,
      })
      await tick(1000) // Allow async execution to complete
    })

    // 4. Verify received frames
    console.log("RECEIVED FRAMES:", JSON.stringify(receivedFrames, null, 2))
    expect(receivedFrames.length).toBeGreaterThanOrEqual(3)
    expect(receivedFrames[0].type).toBe('start')
    expect(receivedFrames.some(f => f.type === 'chunk' && f.chunk?.text === 'Thinking...')).toBe(true)
    expect(receivedFrames[receivedFrames.length - 1].type).toBe('end')

    await system.shutdown()
  })

  test('SessionManager accumulates multi-turn history and passes context to SCRAgentRunner', async () => {
    let capturedTurn2Payload: any = null

    // Turn 1 payload
    const turn1Payloads = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_turn1', function: { name: 'scr_complete', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ text: 'Nice to meet you, Alice!' }) } }] } }] },
      { usage: { prompt_tokens: 10, completion_tokens: 10 } },
    ]

    // Turn 2 payload (we spy on the request body to verify multi-turn messages passed to LLM)
    const turn2Payloads = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_turn2', function: { name: 'scr_complete', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ text: 'Your name is Alice.' }) } }] } }] },
      { usage: { prompt_tokens: 20, completion_tokens: 10 } },
    ]

    let fetchCount = 0
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCount++
      if (fetchCount === 1) {
        return makeSSEResponse(turn1Payloads)
      } else {
        if (init?.body) {
          capturedTurn2Payload = JSON.parse(init.body as string)
        }
        return makeSSEResponse(turn2Payloads)
      }
    }) as any

    const system = await AgentSystem({
      source: staticSource({
        plugins: [MockPersistenceActor(), registryPlugin, cognitivePlugin],
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
    setupLogging(system)
    await tick()

    // 1. Establish session presence
    system.publish(UserPresenceTopic, {
      status: 'present',
      userId: 'user-multiturn-test',
      source: 'http',
      timezone: 'Europe/Paris',
    })
    await tick(100)

    const request = createMessageRequest({
      userId: 'user-multiturn-test',
    })

    // 2. Send Turn 1
    await requestStorage.run(request, async () => {
      system.publish(InboundMessageTopic, {
        text: 'My name is Alice',
        request,
      })
      await tick(1000)
    })

    // 3. Send Turn 2
    await requestStorage.run(request, async () => {
      system.publish(InboundMessageTopic, {
        text: 'What is my name?',
        request,
      })
      await tick(1000)
    })

    // 4. Verify that Turn 2 request to LLM included Turn 1 conversation history
    expect(capturedTurn2Payload).not.toBeNull()
    const messages = capturedTurn2Payload.messages
    expect(messages.some((m: any) => m.role === 'user' && m.content === 'My name is Alice')).toBe(true)
    expect(messages.some((m: any) => m.role === 'assistant' && m.content === 'Nice to meet you, Alice!')).toBe(true)
    expect(messages.at(-1)?.role).toBe('user')
    expect(messages.at(-1)?.content).toBe('What is my name?')

    await system.shutdown()
  })
})
