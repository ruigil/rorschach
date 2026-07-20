import { describe, test, expect } from 'bun:test'
import { AgentSystem, ask } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { Kgraph } from '../plugins/memory/kgraph.ts'
import type { KgraphMsg } from '../plugins/memory/kgraph.ts'
import type { ConceptSearchReply, ConceptUpsertReply, MemoryConcept } from '../plugins/memory/types.ts'
import { LlmProviderTopic } from '../types/llm.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import persistencePlugin from '../plugins/persistence/persistence.plugin.ts'

const DIMS = 4
const tick = (ms = 150) => Bun.sleep(ms)
const tmpDb = () => `/tmp/kgraph-rerank-test-${crypto.randomUUID()}`

const embeddingFor = (text: string): number[] => {
  const t = text.toLowerCase()
  if (t.includes('typescript') || t.includes('programming')) return [1, 0.1, 0.1, 0.1]
  if (t.includes('french') || t.includes('cuisine') || t.includes('cooking')) return [0.1, 1, 0.1, 0.1]
  if (t.includes('neural') || t.includes('machine learning')) return [0.1, 0.1, 1, 0.1]
  return [1, 1, 1, 1]
}

function spawnMockLlm(system: Awaited<ReturnType<typeof AgentSystem>>): ActorRef<LlmProviderMsg> {
  const def: ActorDef<LlmProviderMsg, null> = {
    handler: (state, msg) => {
      if (msg.type === 'embed') {
        msg.replyTo.send({ type: 'embeddingResult', embedding: embeddingFor(msg.text) })
      } else if (msg.type === 'rerank') {
        const scores = msg.documents.map((_, i) => ({ index: i, score: (i + 1) * 0.1 }))
        msg.replyTo.send({ type: 'rerankResult', requestId: msg.requestId, scores, usage: null })
      }
      return { state }
    },
  }
  return system.spawn('mock-llm', def) as ActorRef<LlmProviderMsg>
}

function createConcept(
  kgraphRef: ActorRef<KgraphMsg>,
  name: string,
  description: string,
  recordId: string,
  userId = 'test-user',
): Promise<ConceptUpsertReply> {
  const concept: MemoryConcept = { name, description, kind: 'fact', topics: [] }
  return ask<KgraphMsg, ConceptUpsertReply>(
    kgraphRef,
    (replyTo) => ({ type: 'upsertConcept', concept, recordId, userId, replyTo }),
    { timeoutMs: 5_000 },
  )
}

function conceptSearch(
  kgraphRef: ActorRef<KgraphMsg>,
  query: string,
  topN?: number,
  userId = 'test-user',
): Promise<ConceptSearchReply> {
  return ask<KgraphMsg, ConceptSearchReply>(
    kgraphRef,
    (replyTo) => ({ type: 'conceptSearch', query, topN, userId, replyTo }),
    { timeoutMs: 5_000 },
  )
}

describe('kgraph concept search with reranker', () => {
  test('reranker reorders concept search results', async () => {
    const storagePath = tmpDb()
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: storagePath,
        },
      },
      plugins: [persistencePlugin],
    })
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      Kgraph({ model: 'test-embed', dimensions: DIMS }, 0.0, { model: 'mock/rerank', topK: 3 }),
      { state: { persistenceRef: null, llmRef: null } },
    ) as ActorRef<KgraphMsg>

    await tick()

    await createConcept(kgraphRef, 'TypeScript Types', 'TypeScript static type checking.', 'rec-1')
    await createConcept(kgraphRef, 'French Cuisine', 'French cooking and cuisine techniques.', 'rec-2')
    await createConcept(kgraphRef, 'Neural Networks', 'Machine learning neural networks.', 'rec-3')

    const reply = await conceptSearch(kgraphRef, 'programming typescript', 3)

    expect(reply.type).toBe('conceptSearchResult')
    const concepts = reply.type === 'conceptSearchResult' ? reply.concepts : []
    expect(concepts.length).toBe(3)
    expect(concepts[0]!.name).toBe('Neural Networks')
    expect(concepts[1]!.name).toBe('French Cuisine')
    expect(concepts[2]!.name).toBe('TypeScript Types')
    expect(concepts[0]!.score).toBeCloseTo(0.3, 5)
    expect(concepts[1]!.score).toBeCloseTo(0.2, 5)
    expect(concepts[2]!.score).toBeCloseTo(0.1, 5)

    await system.shutdown()
  })

  test('falls back to vector scores when reranker returns error', async () => {
    const storagePath = tmpDb()
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: storagePath,
        },
      },
      plugins: [persistencePlugin],
    })
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
      Kgraph({ model: 'test-embed', dimensions: DIMS }, 0.0, { model: 'mock/rerank', topK: 3 }),
      { state: { persistenceRef: null, llmRef: null } },
    ) as ActorRef<KgraphMsg>

    await tick()
    await createConcept(kgraphRef, 'TypeScript Types', 'TypeScript static type checking.', 'rec-1')
    await createConcept(kgraphRef, 'French Cuisine', 'French cooking and cuisine techniques.', 'rec-2')

    const reply = await conceptSearch(kgraphRef, 'programming typescript', 2)

    expect(reply.type).toBe('conceptSearchResult')
    const concepts = reply.type === 'conceptSearchResult' ? reply.concepts : []
    expect(concepts[0]!.name).toBe('TypeScript Types')

    await system.shutdown()
  })
})
