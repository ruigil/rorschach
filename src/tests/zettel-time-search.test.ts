import { afterEach, describe, test, expect } from 'bun:test'
import { rm } from 'node:fs/promises'
import { AgentSystem, ask } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { Kgraph } from '../plugins/memory/kgraph.ts'
import type { KgraphMsg } from '../plugins/memory/kgraph.ts'
import { ZettelNotes, zettelCreateTool, zettelSearchTool } from '../plugins/memory/zettel-notes.ts'
import type { ZettelNoteMsg } from '../plugins/memory/zettel-notes.ts'
import { LlmProviderTopic } from '../types/llm.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import type { ToolInvokeMsg, ToolReply } from '../types/tools.ts'

// ─── Helpers ───

const tick = (ms = 150) => Bun.sleep(ms)

const tmpKgraph = () => `/tmp/zettel-time-kgraph-test-${crypto.randomUUID()}.db`
const tmpZettel = () => `/tmp/zettel-time-data-test-${crypto.randomUUID()}`

const DIMS = 4

const norm = (v: number[]): number[] => {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map(x => x / mag)
}

const embeddingFor = (text: string): number[] => {
  const t = text.toLowerCase()
  if (t.includes('movie')) return norm([1, 0, 0, 0])
  if (t.includes('book')) return norm([0, 1, 0, 0])
  return norm([1, 1, 1, 1])
}

function spawnMockLlm(system: Awaited<ReturnType<typeof AgentSystem>>): ActorRef<LlmProviderMsg> {
  const def: ActorDef<LlmProviderMsg, null> = {
    handler: (state, msg) => {
      if (msg.type === 'embed') {
        msg.replyTo.send({ type: 'embeddingResult', embedding: embeddingFor(msg.text) })
      }
      return { state }
    },
  }
  return system.spawn('mock-llm', def) as ActorRef<LlmProviderMsg>
}

const invokeZettel = (
  zettelRef: ActorRef<ZettelNoteMsg>,
  toolName: string,
  args: Record<string, unknown>,
  userId = 'test-user',
): Promise<ToolReply> =>
  ask<ToolInvokeMsg, ToolReply>(
    zettelRef as ActorRef<ToolInvokeMsg>,
    (replyTo) => ({ type: 'invoke', toolName, arguments: JSON.stringify(args), replyTo, userId }),
    { timeoutMs: 5_000 },
  )

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

// ─── Tests ───

describe('zettel-notes time-based search', () => {

  test('filters results by eventTime using after and before', async () => {
    const system = await AgentSystem()
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    const kgraphRef = system.spawn('kgraph', Kgraph(tmpKgraph(), { model: 'test-embed', dimensions: DIMS }), { state: { userDbs: new Map(), llmRef: null } }) as ActorRef<KgraphMsg>

    const zettelDir = tmpZettel()
    tempDirs.push(zettelDir)
    const zettelRef = system.spawn('zettel', ZettelNotes(kgraphRef, zettelDir), { state: { kgraphRef, workPath: zettelDir } }) as ActorRef<ZettelNoteMsg>

    await tick()

    // Today is "2026-05-01"
    
    // Movie seen "last week" (2026-04-24)
    await invokeZettel(zettelRef, zettelCreateTool.name, {
      name: 'The Matrix',
      synopsis: 'User watched The Matrix',
      content: 'I watched The Matrix last week.',
      tags: ['movie'],
      eventTime: '2026-04-24T20:00:00Z',
    })

    // Movie seen "yesterday" (2026-04-30)
    await invokeZettel(zettelRef, zettelCreateTool.name, {
      name: 'Inception',
      synopsis: 'User watched Inception',
      content: 'I watched Inception yesterday.',
      tags: ['movie'],
      eventTime: '2026-04-30T21:00:00Z',
    })

    // Book read "last month" (2026-04-01)
    await invokeZettel(zettelRef, zettelCreateTool.name, {
      name: 'The Hobbit',
      synopsis: 'User read The Hobbit',
      content: 'I read The Hobbit last month.',
      tags: ['book'],
      eventTime: '2026-04-01T10:00:00Z',
    })

    await tick()

    // Search for movies "last week" (between April 19 and April 25)
    const replyLastWeek = await invokeZettel(zettelRef, zettelSearchTool.name, {
      text: 'watched a movie',
      after: '2026-04-19T00:00:00Z',
      before: '2026-04-25T23:59:59Z',
    })

    expect(replyLastWeek.type).toBe('toolResult')
    const resultsLastWeek = JSON.parse((replyLastWeek as { type: 'toolResult'; result: { text: string } }).result.text) as Array<{ name: string }>
    
    expect(resultsLastWeek.length).toBe(1)
    expect(resultsLastWeek[0]!.name).toBe('The Matrix')

    // Search for movies "yesterday" (April 30)
    const replyYesterday = await invokeZettel(zettelRef, zettelSearchTool.name, {
      text: 'watched a movie',
      after: '2026-04-30T00:00:00Z',
      before: '2026-04-30T23:59:59Z',
    })

    expect(replyYesterday.type).toBe('toolResult')
    const resultsYesterday = JSON.parse((replyYesterday as { type: 'toolResult'; result: { text: string } }).result.text) as Array<{ name: string }>
    
    expect(resultsYesterday.length).toBe(1)
    expect(resultsYesterday[0]!.name).toBe('Inception')

    await system.shutdown()
  })

  test('filters results by createdAt if specified', async () => {
    const system = await AgentSystem()
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    const kgraphRef = system.spawn('kgraph', Kgraph(tmpKgraph(), { model: 'test-embed', dimensions: DIMS }), { state: { userDbs: new Map(), llmRef: null } }) as ActorRef<KgraphMsg>

    const zettelDir = tmpZettel()
    tempDirs.push(zettelDir)
    const zettelRef = system.spawn('zettel', ZettelNotes(kgraphRef, zettelDir), { state: { kgraphRef, workPath: zettelDir } }) as ActorRef<ZettelNoteMsg>

    await tick()

    // Create a note now
    await invokeZettel(zettelRef, zettelCreateTool.name, {
      name: 'Recent Note',
      synopsis: 'A very recent note',
      content: 'Content of recent note.',
      tags: ['misc'],
    })

    await tick()

    const now = new Date()
    const oneMinuteAgo = new Date(now.getTime() - 60000).toISOString()
    const oneMinuteFromNow = new Date(now.getTime() + 60000).toISOString()

    const reply = await invokeZettel(zettelRef, zettelSearchTool.name, {
      text: 'recent note',
      after: oneMinuteAgo,
      before: oneMinuteFromNow,
      timeProperty: 'createdAt',
    })

    expect(reply.type).toBe('toolResult')
    const results = JSON.parse((reply as { type: 'toolResult'; result: { text: string } }).result.text) as Array<{ name: string }>
    
    expect(results.length).toBe(1)
    expect(results[0]!.name).toBe('Recent Note')

    await system.shutdown()
  })

})
