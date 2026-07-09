import { describe, expect, test, afterAll } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { AgentSystem } from '../system/index.ts'
import { assembleAgentMessages } from '../system/index.ts'
import { ContextStore } from '../plugins/cognitive/context-store.ts'
import { ContextSnapshotTopic, type ContextSnapshotEvent } from '../types/agents.ts'
import { MockPersistenceActor } from './mock-persistence.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const tempDirs: string[] = []

const tempContextPath = async (): Promise<string> => {
  const path = `/tmp/rorschach-context-${crypto.randomUUID()}`
  await mkdir(path, { recursive: true })
  tempDirs.push(path)
  return path
}

afterAll(async () => {
  for (const path of tempDirs) {
    try {
      await rm(path, { recursive: true, force: true })
    } catch {}
  }
})

describe('ContextStore context snapshots', () => {
  test('starts empty for an old persisted context shape', async () => {
    const contextPath = await tempContextPath()
    await Bun.write(`${contextPath}/context-u1.json`, JSON.stringify({
      userContext: null,
      records: [{ message: { role: 'user', content: 'old' }, timestamp: Date.now() }],
    }))

    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const snapshots: ContextSnapshotEvent[] = []
    system.subscribe(ContextSnapshotTopic, event => snapshots.push(event))
    system.spawn('context-store-u1', ContextStore({ userId: 'u1', contextPath }))
    await tick()

    expect(snapshots.at(-1)?.recentMessages).toEqual([])
    expect(snapshots.at(-1)?.toolSummaries).toEqual([])

    await system.shutdown()
  })

  test('publishes conversation messages and compact tool summaries', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const snapshots: ContextSnapshotEvent[] = []
    system.subscribe(ContextSnapshotTopic, event => snapshots.push(event))
    const ref = system.spawn('context-store-u1', ContextStore({ userId: 'u1', contextPath: await tempContextPath() }))
    await tick()

    ref.send({
      type: 'append',
      mode: 'chatbot',
      messages: [
        { role: 'user', content: 'search for cats' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'web_search', arguments: '{"query":"cats"}' } }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'A long search result about cats.' },
        { role: 'assistant', content: 'Cats are mammals.' },
      ],
    })
    await tick()

    const latest = snapshots.at(-1)!
    expect(latest.recentMessages).toEqual([
      { role: 'user', content: 'search for cats' },
      { role: 'assistant', content: 'Cats are mammals.' },
    ])
    expect(latest.toolSummaries).toEqual([
      {
        mode: 'chatbot',
        toolName: 'web_search',
        summary: 'A long search result about cats.',
        timestamp: expect.any(Number),
      },
    ])

    await system.shutdown()
  })

  test('adds a snapshot turn when user + assistant turn completes', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const snapshots: ContextSnapshotEvent[] = []
    system.subscribe(ContextSnapshotTopic, event => snapshots.push(event))
    const ref = system.spawn('context-store-u1', ContextStore({ userId: 'u1', contextPath: await tempContextPath() }))
    await tick()

    // User message only — no completed turn yet
    ref.send({ type: 'append', mode: 'chatbot', messages: [{ role: 'user', content: 'hello' }] })
    await tick()
    expect(snapshots.at(-1)?.turns).toEqual([])

    // Assistant reply — turn completes
    ref.send({ type: 'append', mode: 'chatbot', source: 'assistant', messages: [{ role: 'assistant', content: 'hi there' }] })
    await tick()
    expect(snapshots.at(-1)?.turns).toEqual([{
      seq: 1,
      userId: 'u1',
      userText: 'hello',
      assistantText: 'hi there',
      timestamp: expect.any(Number),
    }])

    await system.shutdown()
  })

  test('does not add a snapshot turn for tool-call assistant messages', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const snapshots: ContextSnapshotEvent[] = []
    system.subscribe(ContextSnapshotTopic, event => snapshots.push(event))
    const ref = system.spawn('context-store-u1', ContextStore({ userId: 'u1', contextPath: await tempContextPath() }))
    await tick()

    ref.send({ type: 'append', mode: 'chatbot', messages: [{ role: 'user', content: 'search' }] })
    await tick()

    // Assistant with tool_calls — not a conversation message, no event
    ref.send({
      type: 'append',
      mode: 'chatbot',
      source: 'assistant',
      messages: [{
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } }],
      }],
    })
    await tick()
    expect(snapshots.at(-1)?.turns).toEqual([])

    // Final text reply — turn completes
    ref.send({ type: 'append', mode: 'chatbot', source: 'assistant', messages: [{ role: 'assistant', content: 'Here are results.' }] })
    await tick()
    expect(snapshots.at(-1)?.turns).toHaveLength(1)
    expect(snapshots.at(-1)?.turns[0]!.assistantText).toBe('Here are results.')

    await system.shutdown()
  })

  test('filters injected turns at the context snapshot source', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const snapshots: ContextSnapshotEvent[] = []
    system.subscribe(ContextSnapshotTopic, event => snapshots.push(event))
    const ref = system.spawn('context-store-u1', ContextStore({ userId: 'u1', contextPath: await tempContextPath() }))
    await tick()

    ref.send({ type: 'append', mode: 'chatbot', injected: true, messages: [{ role: 'user', content: 'cron task' }] })
    await tick()
    ref.send({ type: 'append', mode: 'chatbot', source: 'assistant', messages: [{ role: 'assistant', content: 'done' }] })
    await tick()

    expect(snapshots.at(-1)?.turns).toEqual([])

    await system.shutdown()
  })
})

describe('assembleAgentMessages', () => {
  test('assembles a context view without duplicating the current user message', () => {
    const messages = assembleAgentMessages({
      userId: 'u1',
      version: 2,
      recentMessages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'current' },
      ],
      userContext: 'The user prefers concise answers.',
      toolSummaries: [{ mode: 'chatbot', toolName: 'web_search', summary: 'Found docs.', timestamp: 1 }],
    }, {
      mode: 'chatbot',
      systemPrompt: 'Base prompt',
      includeToolSummaries: true,
    }, { role: 'user', content: 'current' })

    expect(messages.filter(m => m.role === 'user' && m.content === 'current')).toHaveLength(1)
    expect(messages[0]!.content).toContain('Base prompt')
    expect(messages[0]!.content).toContain('Messages prefixed with [Internal Instruction]')
    expect(messages[0]!.content).toContain('Messages prefixed with [Background tool result — ...]')
    expect(messages.some(m => m.role === 'system' && m.content.includes('User context'))).toBe(true)
    expect(messages.some(m => m.role === 'system' && m.content.includes('Recent tool results'))).toBe(true)
  })
})
