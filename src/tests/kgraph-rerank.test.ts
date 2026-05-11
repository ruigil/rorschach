import { describe, test, expect } from 'bun:test'
import { createPluginSystem, ask } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { createKgraphActor, KGRAPH_CREATE_NODE_TOOL_NAME } from '../plugins/memory/kgraph.ts'
import type { KgraphMsg } from '../plugins/memory/kgraph.ts'
import type { VectorSearchMatch, VectorSearchReply } from '../plugins/memory/types.ts'
import { LlmProviderTopic } from '../types/llm.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import type { ToolReply } from '../types/tools.ts'

// ─── Config ───

const DIMS = 4

const tick = (ms = 150) => Bun.sleep(ms)
const tmpDb = () => `/tmp/kgraph-rerank-test-${crypto.randomUUID()}.db`

// Keyword-based synthetic embeddings: distinct but slightly overlapping directions so all have non-zero similarity.
const embeddingFor = (text: string): number[] => {
  const t = text.toLowerCase()
  if (t.includes('typescript') || t.includes('programming')) return [1, 0.1, 0.1, 0.1]
  if (t.includes('french') || t.includes('cuisine') || t.includes('cooking')) return [0.1, 1, 0.1, 0.1]
  if (t.includes('neural') || t.includes('machine learning')) return [0.1, 0.1, 1, 0.1]
  return [1, 1, 1, 1]
}

// ─── Helpers ───

function spawnMockLlm(system: Awaited<ReturnType<typeof createPluginSystem>>): ActorRef<LlmProviderMsg> {
  const def: ActorDef<LlmProviderMsg, null> = {
    handler: (state, msg) => {
      if (msg.type === 'embed') {
        msg.replyTo.send({ type: 'embeddingResult', embedding: embeddingFor(msg.text) })
        } else if (msg.type === 'rerank') {
          // Mock reranker: reverse the order of documents (simple deterministic behavior)
          const scores = msg.documents.map((_, i) => ({ index: i, score: (i + 1) * 0.1 }))
          msg.replyTo.send({ type: 'rerankResult', requestId: msg.requestId, scores, usage: null })
        }
      return { state }
    },
  }
  return system.spawn('mock-llm', def) as ActorRef<LlmProviderMsg>
}

function createNode(
  kgraphRef: ActorRef<KgraphMsg>,
  name: string,
  description: string,
  embeddingText: string,
  userId = 'test-user',
): Promise<ToolReply> {
  const args = JSON.stringify({ label: 'Note', name, properties: { description }, embeddingText })
  return ask<KgraphMsg, ToolReply>(
    kgraphRef,
    (replyTo) => ({ type: 'invoke', toolName: KGRAPH_CREATE_NODE_TOOL_NAME, arguments: args, replyTo, userId }),
    { timeoutMs: 5_000 },
  )
}

function vectorSearch(
  kgraphRef: ActorRef<KgraphMsg>,
  text: string,
  topN?: number,
  userId = 'test-user',
): Promise<VectorSearchReply> {
  return ask<KgraphMsg, VectorSearchReply>(
    kgraphRef,
    (replyTo) => ({ type: 'vectorSearch', label: 'Note', text, topN, userId, replyTo }),
    { timeoutMs: 5_000 },
  )
}

function createLink(
  kgraphRef: ActorRef<KgraphMsg>,
  sourceName: string,
  targetName: string,
  userId = 'test-user',
): Promise<ToolReply> {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const statement = `MATCH (a:Note {name:"${esc(sourceName)}"}), (b:Note {name:"${esc(targetName)}"}) MERGE (a)-[:LINKS_TO]->(b)`
  const args = JSON.stringify({ statement })
  return ask<KgraphMsg, ToolReply>(
    kgraphRef,
    (replyTo) => ({ type: 'invoke', toolName: 'kgraph_create_link', arguments: args, replyTo, userId }),
    { timeoutMs: 5_000 },
  )
}

// ─── Tests ───

describe('kgraph vector search with reranker', () => {

  test('reranker reorders vector search results', async () => {
    const system = await createPluginSystem()
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    // Create kgraph with reranker config — rerankerTopK=3 ensures all docs are reranked
    const kgraphRef = system.spawn(
      'kgraph',
      createKgraphActor(tmpDb(), { model: 'test-embed', dimensions: DIMS }, 0.0, { model: 'mock/rerank', topK: 3 }),
      { state: { userDbs: new Map(), llmRef: null } },
    ) as ActorRef<KgraphMsg>

    await tick()

    // Create 3 notes. Vector scores: TypeScript=[1,0,0,0], French=[0,1,0,0], Neural=[0,0,1,0]
    // Query "programming typescript" should return TypeScript first by vector similarity.
    await createNode(kgraphRef, 'TypeScript Types', 'TypeScript static type checking.', 'typescript programming')
    await createNode(kgraphRef, 'French Cuisine', 'French cooking and cuisine techniques.', 'french cuisine cooking')
    await createNode(kgraphRef, 'Neural Networks', 'Machine learning neural networks.', 'neural machine learning')

    await tick()

    const reply = await vectorSearch(kgraphRef, 'programming typescript', 3)

    expect(reply.type).toBe('vectorSearchResult')
    const { matches } = reply as { type: 'vectorSearchResult'; matches: VectorSearchMatch[] }

    // Mock reranker reverses order, so Neural Networks (last in vector results) should be first
    // because the mock assigns highest score to the last document.
    expect(matches.length).toBe(3)
    expect(matches[0]!.name).toBe('Neural Networks')
    expect(matches[1]!.name).toBe('French Cuisine')
    expect(matches[2]!.name).toBe('TypeScript Types')

    // Verify that scores came from the reranker
    expect(matches[0]!.score).toBeCloseTo(0.3, 5)
    expect(matches[1]!.score).toBeCloseTo(0.2, 5)
    expect(matches[2]!.score).toBeCloseTo(0.1, 5)

    await system.shutdown()
  })

  test('falls back to vector scores when reranker returns error', async () => {
    const system = await createPluginSystem()

    const errorDef: ActorDef<LlmProviderMsg, null> = {
      handler: (state, msg) => {
        if (msg.type === 'embed') {
          msg.replyTo.send({ type: 'embeddingResult', embedding: embeddingFor(msg.text) })
        } else if (msg.type === 'rerank') {
          msg.replyTo.send({ type: 'rerankError', requestId: msg.requestId, error: 'mock rerank failure' })
        }
        return { state }
      },
    }
    const errorLlmRef = system.spawn('mock-llm-error', errorDef) as ActorRef<LlmProviderMsg>
    system.publishRetained(LlmProviderTopic, 'ref', { ref: errorLlmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      createKgraphActor(tmpDb(), { model: 'test-embed', dimensions: DIMS }, 0.0, { model: 'mock/rerank', topK: 3 }),
      { state: { userDbs: new Map(), llmRef: null } },
    ) as ActorRef<KgraphMsg>

    await tick()

    await createNode(kgraphRef, 'TypeScript Types', 'TypeScript static type checking.', 'typescript programming')
    await createNode(kgraphRef, 'French Cuisine', 'French cooking and cuisine techniques.', 'french cuisine cooking')

    await tick()

    const reply = await vectorSearch(kgraphRef, 'programming typescript', 2)

    expect(reply.type).toBe('vectorSearchResult')
    const { matches } = reply as { type: 'vectorSearchResult'; matches: VectorSearchMatch[] }

    // Should fall back to vector ordering
    expect(matches[0]!.name).toBe('TypeScript Types')

    await system.shutdown()
  })

})
