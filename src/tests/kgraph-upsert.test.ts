import { describe, test, expect, afterEach } from 'bun:test'
import { createPluginSystem, ask } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { createKgraphActor, KGRAPH_UPSERT_TOOL_NAME } from '../plugins/memory/kgraph.ts'
import type { KgraphMsg } from '../plugins/memory/kgraph.ts'
import { LlmProviderTopic } from '../types/llm.ts'
import type { LlmProviderMsg, EmbeddingReply } from '../types/llm.ts'
import type { ToolReply } from '../types/tools.ts'
import type { UpsertResult } from '../types/memory.ts'

// ─── Helpers ───

const tick = (ms = 100) => Bun.sleep(ms)

/** Build a unique temp DB path per test run to avoid cross-test contamination */
const tmpDb = () => `/tmp/kgraph-test-${crypto.randomUUID()}.db`

/** Normalise a vector so it has unit length (for clean cosine similarity values) */
const norm = (v: number[]): number[] => {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map(x => x / mag)
}

// ─── Embedding map ───
// We use 4-dimensional vectors and control similarity precisely.
// Cosine sim of identical unit vectors = 1.0 (well above 0.88 threshold).
// Cosine sim of orthogonal unit vectors = 0.0 (well below threshold).
// "Lisboa" is intentionally close to "Lisbon" (sim ≈ 0.99) to test merge.
// "Paris"  is orthogonal to "Lisbon"          (sim = 0.0) to test no-merge.

const EMBEDDINGS: Record<string, number[]> = {
  Lisbon:   norm([1.0, 0.05, 0.0, 0.0]),
  Lisboa:   norm([1.0, 0.07, 0.0, 0.0]),  // very close to Lisbon → will merge
  Paris:    norm([0.0, 0.0,  1.0, 0.0]),  // orthogonal to Lisbon → will NOT merge
  Concept1: norm([0.0, 1.0,  0.0, 0.0]),
  Concept2: norm([0.0, 0.0,  0.0, 1.0]),
}

const EMBEDDING_DIMS = 4
const EMBEDDING_MODEL = 'test-embed'

/** Spawn a mock LLM actor that returns pre-determined embeddings */
function spawnMockLlm(system: Awaited<ReturnType<typeof createPluginSystem>>): ActorRef<LlmProviderMsg> {
  const def: ActorDef<LlmProviderMsg, null> = {
    handler: (state, msg) => {
      if (msg.type === 'embed') {
        const vec = EMBEDDINGS[msg.text]
        if (vec) {
          msg.replyTo.send({ type: 'embeddingResult', embedding: vec })
        } else {
          // Fall back to a zero-ish vector for unknown text (should not happen in tests)
          msg.replyTo.send({ type: 'embeddingError', error: `no embedding for: ${msg.text}` })
        }
      }
      return { state }
    },
  }
  return system.spawn('mock-llm', def, null) as ActorRef<LlmProviderMsg>
}

/** Send a kgraph_upsert invoke and await the ToolReply */
function upsert(
  kgraphRef: ActorRef<KgraphMsg>,
  label: string,
  name: string,
  description?: string,
): Promise<ToolReply> {
  const args = JSON.stringify({ label, name, ...(description ? { properties: { description } } : {}) })
  return ask<KgraphMsg, ToolReply>(
    kgraphRef,
    (replyTo) => ({ type: 'invoke', toolName: KGRAPH_UPSERT_TOOL_NAME, arguments: args, replyTo }),
    { timeoutMs: 5_000 },
  )
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe('kgraph upsert: node deduplication via vector embeddings', () => {

  test('inserting a brand-new node returns merged: false', async () => {
    const system = await createPluginSystem()
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      createKgraphActor(tmpDb(), { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMS }),
      null,
    ) as ActorRef<KgraphMsg>

    await tick()

    const reply = await upsert(kgraphRef, 'Note', 'Lisbon', 'Capital of Portugal')
    expect(reply.type).toBe('toolResult')

    const result: UpsertResult = JSON.parse((reply as { type: 'toolResult'; result: string }).result)
    expect(result.merged).toBe(false)
    expect(result.canonicalName).toBe('Lisbon')
    expect(typeof result.nodeId).toBe('number')

    await system.shutdown()
  })

  test('upserting the exact same node a second time merges with the existing one', async () => {
    const system = await createPluginSystem()
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      createKgraphActor(tmpDb(), { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMS }),
      null,
    ) as ActorRef<KgraphMsg>

    await tick()

    const first = await upsert(kgraphRef, 'Note', 'Lisbon', 'Capital of Portugal')
    const firstResult: UpsertResult = JSON.parse((first as { type: 'toolResult'; result: string }).result)
    expect(firstResult.merged).toBe(false)

    const second = await upsert(kgraphRef, 'Note', 'Lisbon', 'Lisbon, western Portugal')
    expect(second.type).toBe('toolResult')
    const secondResult: UpsertResult = JSON.parse((second as { type: 'toolResult'; result: string }).result)

    expect(secondResult.merged).toBe(true)
    expect(secondResult.canonicalName).toBe('Lisbon')
    expect(secondResult.nodeId).toBe(firstResult.nodeId)

    await system.shutdown()
  })

  test('upserting a near-duplicate (similarity > threshold) merges and returns canonical name', async () => {
    const system = await createPluginSystem()
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      createKgraphActor(tmpDb(), { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMS }),
      null,
    ) as ActorRef<KgraphMsg>

    await tick()

    // Insert the canonical node first
    const first = await upsert(kgraphRef, 'Note', 'Lisbon', 'Capital of Portugal')
    const firstResult: UpsertResult = JSON.parse((first as { type: 'toolResult'; result: string }).result)
    expect(firstResult.merged).toBe(false)

    // Insert the near-duplicate — "Lisboa" embedding is very close to "Lisbon"
    const second = await upsert(kgraphRef, 'Note', 'Lisboa', 'Lisbon in Portuguese')
    expect(second.type).toBe('toolResult')
    const secondResult: UpsertResult = JSON.parse((second as { type: 'toolResult'; result: string }).result)

    expect(secondResult.merged).toBe(true)
    // canonicalName is the ORIGINAL node's name, not the incoming one
    expect(secondResult.canonicalName).toBe('Lisbon')
    expect(secondResult.nodeId).toBe(firstResult.nodeId)

    await system.shutdown()
  })

  test('upserting a dissimilar node (similarity < threshold) creates a new node', async () => {
    const system = await createPluginSystem()
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      createKgraphActor(tmpDb(), { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMS }),
      null,
    ) as ActorRef<KgraphMsg>

    await tick()

    const lisbon = await upsert(kgraphRef, 'Note', 'Lisbon', 'Capital of Portugal')
    const lisbonResult: UpsertResult = JSON.parse((lisbon as { type: 'toolResult'; result: string }).result)
    expect(lisbonResult.merged).toBe(false)

    const paris = await upsert(kgraphRef, 'Note', 'Paris', 'Capital of France')
    expect(paris.type).toBe('toolResult')
    const parisResult: UpsertResult = JSON.parse((paris as { type: 'toolResult'; result: string }).result)

    expect(parisResult.merged).toBe(false)
    expect(parisResult.canonicalName).toBe('Paris')
    // Paris must be a different node than Lisbon
    expect(parisResult.nodeId).not.toBe(lisbonResult.nodeId)

    await system.shutdown()
  })

  test('inserting multiple distinct nodes produces separate records without cross-merging', async () => {
    const system = await createPluginSystem()
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      createKgraphActor(tmpDb(), { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMS }),
      null,
    ) as ActorRef<KgraphMsg>

    await tick()

    const nodes = ['Lisbon', 'Paris', 'Concept1', 'Concept2']
    const results: UpsertResult[] = []

    for (const name of nodes) {
      const reply = await upsert(kgraphRef, 'Note', name)
      expect(reply.type).toBe('toolResult')
      const result: UpsertResult = JSON.parse((reply as { type: 'toolResult'; result: string }).result)
      expect(result.merged).toBe(false)
      results.push(result)
    }

    // All node IDs must be unique
    const ids = results.map(r => r.nodeId)
    expect(new Set(ids).size).toBe(nodes.length)

    await system.shutdown()
  })

  test('upsert fails gracefully when no LLM provider is available', async () => {
    const system = await createPluginSystem()

    // No LLM published — kgraph will have llmRef = null
    const kgraphRef = system.spawn(
      'kgraph',
      createKgraphActor(tmpDb(), { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMS }),
      null,
    ) as ActorRef<KgraphMsg>

    await tick()

    const reply = await upsert(kgraphRef, 'Note', 'Lisbon')
    expect(reply.type).toBe('toolError')
    expect((reply as { type: 'toolError'; error: string }).error).toMatch(/embedding/)

    await system.shutdown()
  })
})
