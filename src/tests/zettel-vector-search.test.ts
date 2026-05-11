import { afterEach, describe, test, expect } from 'bun:test'
import { rm } from 'node:fs/promises'
import { SystemPlugin, ask } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { Kgraph } from '../plugins/memory/kgraph.ts'
import type { KgraphMsg } from '../plugins/memory/kgraph.ts'
import { ZettelNotes, ZETTEL_CREATE_TOOL, ZETTEL_SEARCH_TOOL, ZETTEL_LINK_TOOL } from '../plugins/memory/zettel-notes.ts'
import type { ZettelNoteMsg } from '../plugins/memory/zettel-notes.ts'
import { LlmProviderTopic } from '../types/llm.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import type { ToolInvokeMsg, ToolReply } from '../types/tools.ts'

// ─── Helpers ───

const tick = (ms = 150) => Bun.sleep(ms)

const tmpKgraph = () => `/tmp/zettel-kgraph-test-${crypto.randomUUID()}.db`
const tmpZettel = () => `/tmp/zettel-data-test-${crypto.randomUUID()}`

const DIMS = 4

const norm = (v: number[]): number[] => {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map(x => x / mag)
}

// Keyword-based synthetic embeddings: each topic gets a distinct orthogonal direction.
const embeddingFor = (text: string): number[] => {
  const t = text.toLowerCase()
  if (t.includes('typescript') || t.includes('programming')) return norm([1, 0, 0, 0])
  if (t.includes('french') || t.includes('cuisine') || t.includes('cooking') || t.includes('food')) return norm([0, 1, 0, 0])
  if (t.includes('neural') || t.includes('machine learning') || t.includes(' ml ') || t.includes('ai ')) return norm([0, 0, 1, 0])
  return norm([1, 1, 1, 1])
}

function spawnMockLlm(system: Awaited<ReturnType<typeof SystemPlugin>>): ActorRef<LlmProviderMsg> {
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

describe('zettel-notes vector search', () => {

  test('returns the most semantically similar note first', async () => {
    const system = await SystemPlugin()
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    const kgraphRef = system.spawn('kgraph', Kgraph(tmpKgraph(), { model: 'test-embed', dimensions: DIMS }), { state: { userDbs: new Map(), llmRef: null } }) as ActorRef<KgraphMsg>

    const zettelDir = tmpZettel()
    tempDirs.push(zettelDir)
    const zettelRef = system.spawn('zettel', ZettelNotes(kgraphRef, zettelDir), { state: { kgraphRef, dbPath: zettelDir } }) as ActorRef<ZettelNoteMsg>

    await tick()

    await invokeZettel(zettelRef, ZETTEL_CREATE_TOOL, {
      name: 'TypeScript Types',
      synopsis: 'TypeScript static type checking improves developer experience.',
      content: 'TypeScript adds static types to JavaScript.',
      tags: ['typescript', 'programming'],
    })

    await invokeZettel(zettelRef, ZETTEL_CREATE_TOOL, {
      name: 'French Cuisine',
      synopsis: 'French cooking relies on butter, cream, and technique.',
      content: 'Classic French dishes include boeuf bourguignon and ratatouille.',
      tags: ['cooking', 'food'],
    })

    await invokeZettel(zettelRef, ZETTEL_CREATE_TOOL, {
      name: 'Neural Networks',
      synopsis: 'Machine learning neural networks learn patterns from training data.',
      content: 'Deep learning uses layered neural networks.',
      tags: ['ml', 'ai'],
    })

    await tick()

    const reply = await invokeZettel(zettelRef, ZETTEL_SEARCH_TOOL, {
      text: 'TypeScript static typing for programming',
    })

    expect(reply.type).toBe('toolResult')
    const results = JSON.parse((reply as { type: 'toolResult'; result: { text: string } }).result.text) as Array<{ name: string; score: number }>

    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.name).toBe('TypeScript Types')

    await system.shutdown()
  })

  test('falls back to tag filtering when vector search finds no matches above threshold', async () => {
    const system = await SystemPlugin()
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    const kgraphRef = system.spawn('kgraph', Kgraph(tmpKgraph(), { model: 'test-embed', dimensions: DIMS }), { state: { userDbs: new Map(), llmRef: null } }) as ActorRef<KgraphMsg>

    const zettelDir = tmpZettel()
    tempDirs.push(zettelDir)
    const zettelRef = system.spawn('zettel', ZettelNotes(kgraphRef, zettelDir), { state: { kgraphRef, dbPath: zettelDir } }) as ActorRef<ZettelNoteMsg>

    await tick()

    await invokeZettel(zettelRef, ZETTEL_CREATE_TOOL, {
      name: 'TypeScript Types',
      synopsis: 'TypeScript static type checking.',
      content: 'TypeScript adds types to JavaScript.',
      tags: ['typescript'],
    })

    await invokeZettel(zettelRef, ZETTEL_CREATE_TOOL, {
      name: 'French Cuisine',
      synopsis: 'French cooking techniques.',
      content: 'Classic French dishes.',
      tags: ['cooking'],
    })

    await tick()

    // Search for machine learning (orthogonal topic) with cooking tag.
    // Kgraph returns nothing, so zettel falls back to tag filtering.
    const reply = await invokeZettel(zettelRef, ZETTEL_SEARCH_TOOL, {
      text: 'Machine learning algorithms',
      tags: ['cooking'],
    })

    expect(reply.type).toBe('toolResult')
    const results = JSON.parse((reply as { type: 'toolResult'; result: { text: string } }).result.text) as Array<{ name: string }>

    expect(results.length).toBe(1)
    expect(results[0]!.name).toBe('French Cuisine')

    await system.shutdown()
  })

})
