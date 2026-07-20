import { describe, test, expect } from 'bun:test'
import { AgentSystem, ask } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { Kgraph } from '../plugins/memory/kgraph.ts'
import type { KgraphMsg } from '../plugins/memory/kgraph.ts'
import { LlmProviderTopic } from '../types/llm.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import type { ConceptSearchReply, ConceptUpsertReply, MemoryConcept } from '../plugins/memory/types.ts'
import persistencePlugin from '../plugins/persistence/persistence.plugin.ts'

const tick = (ms = 100) => Bun.sleep(ms)
const tmpDb = () => `/tmp/kgraph-test-${crypto.randomUUID()}`

const norm = (v: number[]): number[] => {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map(x => x / mag)
}

const EMBEDDINGS: Record<string, number[]> = {
  Lisbon: norm([1.0, 0.05, 0.0, 0.0]),
  Paris:  norm([0.0, 0.0, 1.0, 0.0]),
  Tokyo:  norm([0.0, 1.0, 0.0, 0.0]),
  Berlin: norm([0.0, 0.0, 0.0, 1.0]),
}

const EMBEDDING_DIMS = 4
const EMBEDDING_MODEL = 'test-embed'

function spawnMockLlm(system: Awaited<ReturnType<typeof AgentSystem>>): ActorRef<LlmProviderMsg> {
  const def: ActorDef<LlmProviderMsg, null> = {
    handler: (state, msg) => {
      if (msg.type === 'embed') {
        const vec = EMBEDDINGS[msg.text.split('\n')[0] ?? ''] ?? norm([1, 1, 1, 1])
        msg.replyTo.send({ type: 'embeddingResult', embedding: vec })
      }
      return { state }
    },
  }
  return system.spawn('mock-llm', def) as ActorRef<LlmProviderMsg>
}

const concept = (
  name: string,
  description = `${name} concept`,
): MemoryConcept => ({
  name,
  kind: 'fact',
  description,
  topics: [name.toLowerCase()],
})

function upsertConcept(
  kgraphRef: ActorRef<KgraphMsg>,
  value: MemoryConcept,
  recordId: string,
): Promise<ConceptUpsertReply> {
  return ask<KgraphMsg, ConceptUpsertReply>(
    kgraphRef,
    (replyTo) => ({ type: 'upsertConcept', concept: value, recordId, userId: 'test-user', replyTo }),
    { timeoutMs: 5_000 },
  )
}

function conceptSearch(
  kgraphRef: ActorRef<KgraphMsg>,
  query: string,
): Promise<ConceptSearchReply> {
  return ask<KgraphMsg, ConceptSearchReply>(
    kgraphRef,
    (replyTo) => ({ type: 'conceptSearch', query, topN: 8, userId: 'test-user', replyTo }),
    { timeoutMs: 5_000 },
  )
}

describe('kgraph concept upsert', () => {
  test('creates a concept and returns its nodeId', async () => {
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
      Kgraph({ model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMS }),
      { state: { persistenceRef: null, llmRef: null } },
    ) as ActorRef<KgraphMsg>

    await tick()

    const reply = await upsertConcept(kgraphRef, concept('Lisbon', 'Capital of Portugal'), 'rec-lisbon')
    expect(reply.type).toBe('conceptUpsertResult')
    expect(reply.type === 'conceptUpsertResult' ? typeof reply.nodeId : 'error').toBe('number')

    await system.shutdown()
  })

  test('same concept name updates the existing node and appends recordIds', async () => {
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
      Kgraph({ model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMS }),
      { state: { persistenceRef: null, llmRef: null } },
    ) as ActorRef<KgraphMsg>

    await tick()

    const first = await upsertConcept(kgraphRef, concept('Lisbon', 'Capital of Portugal'), 'rec-1')
    const second = await upsertConcept(kgraphRef, concept('Lisbon', 'Lisbon, western Portugal'), 'rec-2')

    expect(first.type).toBe('conceptUpsertResult')
    expect(second.type).toBe('conceptUpsertResult')
    expect(second.type === 'conceptUpsertResult' && first.type === 'conceptUpsertResult' ? second.nodeId : null)
      .toBe(first.type === 'conceptUpsertResult' ? first.nodeId : null)

    const search = await conceptSearch(kgraphRef, 'Lisbon')
    expect(search.type).toBe('conceptSearchResult')
    const lisbon = search.type === 'conceptSearchResult'
      ? search.concepts.find(c => c.name === 'Lisbon')
      : undefined
    expect(lisbon?.description).toBe('Lisbon, western Portugal')
    expect(lisbon?.recordIds).toEqual(['rec-1', 'rec-2'])

    await system.shutdown()
  })

  test('multiple distinct concepts produce separate nodes', async () => {
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
      Kgraph({ model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMS }),
      { state: { persistenceRef: null, llmRef: null } },
    ) as ActorRef<KgraphMsg>

    await tick()

    const names = ['Lisbon', 'Paris', 'Tokyo', 'Berlin']
    const ids: number[] = []
    for (const [index, name] of names.entries()) {
      const reply = await upsertConcept(kgraphRef, concept(name), `rec-${index}`)
      expect(reply.type).toBe('conceptUpsertResult')
      if (reply.type === 'conceptUpsertResult') ids.push(reply.nodeId)
    }

    expect(new Set(ids).size).toBe(names.length)

    await system.shutdown()
  })

  test('fails gracefully when no LLM provider is available', async () => {
    const storagePath = tmpDb()
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: storagePath,
        },
      },
      plugins: [persistencePlugin],
    })

    const kgraphRef = system.spawn(
      'kgraph',
      Kgraph({ model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMS }),
      { state: { persistenceRef: null, llmRef: null } },
    ) as ActorRef<KgraphMsg>

    await tick()

    const reply = await upsertConcept(kgraphRef, concept('Lisbon'), 'rec-lisbon')
    expect(reply.type).toBe('conceptUpsertError')
    expect(reply.type === 'conceptUpsertError' ? reply.error : '').toMatch(/embedding/)

    await system.shutdown()
  })
})
