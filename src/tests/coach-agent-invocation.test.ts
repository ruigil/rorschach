import { describe, test, expect, afterEach } from 'bun:test'
import { AgentSystem, invokeSCR, staticSource, createPluginFactory, defineConfig } from '../system/index.ts'
import { MockPersistenceActor } from './mock-persistence.ts'
import cognitivePlugin from '../plugins/cognitive/cognitive.plugin.ts'
import notebookPlugin from '../plugins/notebook/notebook.plugin.ts'
import codingPlugin from '../plugins/coding/coding.plugin.ts'
import { ResolutionCache } from '../system/scr/cache.ts'

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

describe('Coach & Plugin Agent Auto-Provisioned Spawner', () => {
  test('notebook plugin auto-provisions spawner-0 and executes coach agent via invokeSCR', async () => {
    stubFetchByUrl([
      () => makeSSEResponse(toolCallPayloads('call_coach_1', 'scr_complete', JSON.stringify({ text: 'Stay consistent with your habits!' }))),
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
    await tick()

    // 1. Verify that the coach descriptor target is the plugin-local spawner-0
    const descriptor = ResolutionCache.getDescriptor('scr:reasoner:notebook.coach')
    expect(descriptor).toBeDefined()
    expect(descriptor?.kind).toBe('reasoner')
    expect(descriptor?.target.name).toBe('system/notebook/spawner-0')

    // 2. Invoke the coach agent directly
    const reply = await invokeSCR('scr:reasoner:notebook.coach', { prompt: 'How do I start jogging?' })
    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      expect((reply.output as any).text).toBe('Stay consistent with your habits!')
    }

    await system.shutdown()
  })

  test('coding plugin auto-provisions spawner-0 and executes coding agent', async () => {
    stubFetchByUrl([
      () => makeSSEResponse(toolCallPayloads('call_coding_1', 'scr_complete', JSON.stringify({ text: 'Refactoring complete.' }))),
    ])

    const system = await AgentSystem({
      source: staticSource({
        plugins: [MockPersistenceActor(), cognitivePlugin, codingPlugin],
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
    await tick()

    const descriptor = ResolutionCache.getDescriptor('scr:reasoner:coding.coding')
    expect(descriptor).toBeDefined()
    expect(descriptor?.kind).toBe('reasoner')
    expect(descriptor?.target.name).toBe('system/coding/spawner-0')

    const reply = await invokeSCR('scr:reasoner:coding.coding', { prompt: 'Inspect the code' })
    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      expect((reply.output as any).text).toBe('Refactoring complete.')
    }

    await system.shutdown()
  })

  test('chatbot agent delegates to notebook_coach tool and returns coach response', async () => {
    stubFetchByUrl([
      // Turn 1 (Chatbot): invokes the notebook_coach tool
      () => makeSSEResponse(toolCallPayloads('call_chat_1', 'notebook_coach', JSON.stringify({ prompt: 'Help user with habit' }))),
      // Turn 1 (Coach): coach runs and completes
      () => makeSSEResponse(toolCallPayloads('call_coach_1', 'scr_complete', JSON.stringify({ text: 'Habit tracked: 10 mins reading daily.' }))),
      // Turn 2 (Chatbot): completes with coach advice
      () => makeSSEResponse(toolCallPayloads('call_chat_2', 'scr_complete', JSON.stringify({ text: 'Coach says: Habit tracked: 10 mins reading daily.' }))),
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
    await tick()

    const reply = await invokeSCR('scr:reasoner:cognitive.chatbot', { prompt: 'I want to build a reading habit' })
    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      expect((reply.output as any).text).toContain('Coach says: Habit tracked: 10 mins reading daily.')
    }

    await system.shutdown()
  })

  test('coach agent finds notebook tools, executes notebook_todos_create, and completes', async () => {
    stubFetchByUrl([
      // Turn 1 (Coach): calls notebook_todos_create
      () => makeSSEResponse(toolCallPayloads('call_todo_1', 'notebook_todos_create', JSON.stringify({ text: 'Read 10 pages of book', priority: 'high' }))),
      // Turn 2 (Coach): completes with confirmation
      () => makeSSEResponse(toolCallPayloads('call_coach_done', 'scr_complete', JSON.stringify({ text: 'Created your reading todo item!' }))),
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
    await tick()

    const reply = await invokeSCR('scr:reasoner:notebook.coach', { prompt: 'Add a reading todo for me' })
    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      expect((reply.output as any).text).toBe('Created your reading todo item!')
    }

    await system.shutdown()
  })

  test('coach agent executes notebook_tracker_define_habit and notebook_tracker_log', async () => {
    stubFetchByUrl([
      // Turn 1 (Coach): calls notebook_tracker_define_habit
      () => makeSSEResponse(toolCallPayloads('call_th_1', 'notebook_tracker_define_habit', JSON.stringify({ name: 'Reading', unit: 'pages', dailyTarget: 10 }))),
      // Turn 2 (Coach): calls notebook_tracker_log
      () => makeSSEResponse(toolCallPayloads('call_tl_1', 'notebook_tracker_log', JSON.stringify({ habit: 'Reading', value: 15, description: 'Chapter 1' }))),
      // Turn 3 (Coach): completes
      () => makeSSEResponse(toolCallPayloads('call_coach_done', 'scr_complete', JSON.stringify({ text: 'Habit Reading defined and 15 pages logged!' }))),
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
    await tick()

    const reply = await invokeSCR('scr:reasoner:notebook.coach', { prompt: 'Track my reading habit of 10 pages daily and log 15 pages for today' })
    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      expect((reply.output as any).text).toBe('Habit Reading defined and 15 pages logged!')
    }

    await system.shutdown()
  })

  test('chatbot agent terminates immediately without 2nd LLM call when coach streams directly with undefined output', async () => {
    let fetchCalls = 0
    const streamPayloads = [
      { choices: [{ delta: { content: 'Here is your daily coaching encouragement!' } }] },
      { usage: { prompt_tokens: 20, completion_tokens: 15 } }
    ]

    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('openrouter.ai/api/v1/models')) return new Response('Not Found', { status: 404 })
      fetchCalls++
      if (fetchCalls === 1) {
        // Turn 1 (Chatbot): delegates to notebook_coach tool
        return makeSSEResponse(toolCallPayloads('call_chat_1', 'notebook_coach', JSON.stringify({ prompt: 'Help user with habits' })))
      }
      if (fetchCalls === 2) {
        // Coach turn: streams text response directly to user and finishes
        return makeSSEResponse(streamPayloads)
      }
      // If chatbot attempted a 2nd LLM call, this would fail the test
      throw new Error(`Unexpected fetch call #${fetchCalls}: Chatbot should not invoke LLM again when subagent output is undefined`)
    }) as unknown as typeof fetch

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
    await tick()

    // 1. Verify descriptor has undefined outputSchema
    const descriptor = ResolutionCache.getDescriptor('scr:reasoner:notebook.coach')
    expect(descriptor?.schema?.outputSchema).toBeUndefined()

    // 2. Invoke chatbot: Chatbot delegates -> Coach streams -> Chatbot finishes without 2nd answer
    const reply = await invokeSCR('scr:reasoner:cognitive.chatbot', { prompt: 'Help user with habits' })
    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      expect(reply.output).toBeUndefined()
    }
    expect(fetchCalls).toBe(2)

    await system.shutdown()
  })

  test('reasoner agent with custom outputSchema registers schema and returns structured payload via scr_complete', async () => {
    stubFetchByUrl([
      () => makeSSEResponse(toolCallPayloads('call_structured_1', 'scr_complete', JSON.stringify({ score: 95, recommendations: ['Drink more water', 'Sleep 8 hours'] }))),
    ])

    const structuredPlugin = createPluginFactory({
      id: 'testplugin',
      version: '1.0.0',
      description: 'Test plugin with structured reasoner',
      configDescriptor: defineConfig('testplugin', {}),
      agents: {
        evaluator: {
          factory: () => ({
            mode: 'evaluator',
            role: 'reasoning',
            displayName: 'Evaluator Agent',
            shortDesc: 'Evaluates user health habits',
            systemPrompt: 'Evaluate habits and return score',
            capabilities: { userVisible: true },
            model: 'google/gemini-3.5-flash',
            outputSchema: {
              type: 'object',
              properties: {
                score: { type: 'number' },
                recommendations: { type: 'array', items: { type: 'string' } },
              },
              required: ['score', 'recommendations'],
            },
          }),
          options: () => ({}),
        },
      },
    })

    const system = await AgentSystem({
      source: staticSource({
        plugins: [MockPersistenceActor(), cognitivePlugin, structuredPlugin],
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
    await tick()

    // 1. Verify descriptor has configured outputSchema
    const descriptor = ResolutionCache.getDescriptor('scr:reasoner:testplugin.evaluator')
    expect(descriptor?.schema?.outputSchema).toBeDefined()
    expect(descriptor?.schema?.outputSchema?.properties?.score?.type).toBe('number')

    // 2. Invoke evaluator
    const reply = await invokeSCR('scr:reasoner:testplugin.evaluator', { prompt: 'Evaluate my routine' })
    expect(reply.type).toBe('result')
    if (reply.type === 'result') {
      expect((reply.output as any).score).toBe(95)
      expect((reply.output as any).recommendations).toEqual(['Drink more water', 'Sleep 8 hours'])
    }

    await system.shutdown()
  })
})

