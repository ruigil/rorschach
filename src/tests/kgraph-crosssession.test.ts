import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { rm, mkdir } from 'node:fs/promises'
import { GrafeoDB } from '@grafeo-db/js'
import { AgentSystem, ask } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { Kgraph } from '../plugins/memory/kgraph.ts'
import type { KgraphMsg } from '../plugins/memory/kgraph.ts'
import type { ConceptSearchReply, ConceptUpsertReply, MemoryConcept } from '../plugins/memory/types.ts'
import { LlmProviderTopic } from '../types/llm.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import persistencePlugin from '../plugins/persistence/persistence.plugin.ts'

const EMBED_MODEL = 'test-embed'
const DIMS = 4
const TEST_DB = '/tmp/kgraph-crosssession-test'
const USER_ID = 'test-user'

const tick = (ms = 500) => Bun.sleep(ms)

const embeddingFor = (text: string): number[] => {
  const t = text.toLowerCase()
  if (t.includes('lisbon') || t.includes('mouraria') || t.includes('live')) return [1, 0.1, 0.1, 0.1]
  return [1, 1, 1, 1]
}

function spawnSystem() {
  return AgentSystem({
    config: {
      persistence: {
        storageRoot: TEST_DB,
      },
    },
    plugins: [persistencePlugin],
  })
}

function spawnLlm(system: Awaited<ReturnType<typeof AgentSystem>>): ActorRef<LlmProviderMsg> {
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

function spawnKgraph(system: Awaited<ReturnType<typeof AgentSystem>>): ActorRef<KgraphMsg> {
  return system.spawn(
    'kgraph',
    Kgraph(TEST_DB, { model: EMBED_MODEL, dimensions: DIMS }),
    { state: { persistenceRef: null, llmRef: null } },
  ) as ActorRef<KgraphMsg>
}

function upsertConcept(kgraphRef: ActorRef<KgraphMsg>, concept: MemoryConcept): Promise<ConceptUpsertReply> {
  return ask<KgraphMsg, ConceptUpsertReply>(
    kgraphRef,
    (replyTo) => ({ type: 'upsertConcept', concept, recordId: 'home-location-record', userId: USER_ID, replyTo }),
    { timeoutMs: 30_000 },
  )
}

function conceptSearch(kgraphRef: ActorRef<KgraphMsg>, query: string): Promise<ConceptSearchReply> {
  return ask<KgraphMsg, ConceptSearchReply>(
    kgraphRef,
    (replyTo) => ({ type: 'conceptSearch', query, topN: 5, userId: USER_ID, replyTo }),
    { timeoutMs: 30_000 },
  )
}

beforeAll(async () => {
  await rm(TEST_DB, { recursive: true, force: true })
  await mkdir(TEST_DB, { recursive: true })
})

afterAll(async () => {
  await rm(TEST_DB, { recursive: true, force: true })
})

describe('kgraph cross-session persistence', () => {
  test('inject: creates a concept and finds it in the same session', async () => {
    const system = await spawnSystem()
    const llmRef = spawnLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: llmRef })

    const kgraphRef = spawnKgraph(system)
    await tick()

    const createReply = await upsertConcept(kgraphRef, {
      name: 'Home Location',
      kind: 'place',
      description: 'The user lives in Lisbon, Portugal, in the Mouraria neighbourhood.',
      topics: ['location', 'personal', 'lisbon'],
    })
    expect(createReply.type).toBe('conceptUpsertResult')

    const searchReply = await conceptSearch(kgraphRef, 'Where does the user live?')
    expect(searchReply.type).toBe('conceptSearchResult')
    const concepts = searchReply.type === 'conceptSearchResult' ? searchReply.concepts : []
    expect(concepts.length).toBeGreaterThan(0)
    expect(concepts[0]!.name).toBe('Home Location')

    await system.shutdown()
  })

  test('raw db: inspect concept properties and test cypher vector search', async () => {
    const db = GrafeoDB.create(`${TEST_DB}/graph/kgraph/${USER_ID}`)
    await db.execute(`CREATE VECTOR INDEX idx_concept_embedding ON :Concept(_embedding) DIMENSION ${DIMS} METRIC 'cosine'`).catch(e => console.log('createVectorIndex:', e))

    const queryVec = new Array(DIMS).fill(0.1)
    const vectorStr = `[${queryVec.join(',')}]`
    const resultsResult = await db.execute(`
      MATCH (n:Concept)
      WHERE cosine_similarity(n._embedding, vector(${vectorStr})) > 0.0
      RETURN id(n) AS nodeId, n.name AS name, cosine_similarity(n._embedding, vector(${vectorStr})) AS score
      ORDER BY score DESC
      LIMIT 5
    `)
    const results = resultsResult.toArray() as unknown[]

    db.close()
    expect(results.length).toBeGreaterThan(0)
  })

  test('recall: finds the concept from the previous session without re-injecting', async () => {
    const system = await spawnSystem()
    const llmRef = spawnLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: llmRef })

    const kgraphRef = spawnKgraph(system)
    await tick()

    const searchReply = await conceptSearch(kgraphRef, 'Where does the user live?')
    expect(searchReply.type).toBe('conceptSearchResult')
    const concepts = searchReply.type === 'conceptSearchResult' ? searchReply.concepts : []
    expect(concepts.length).toBeGreaterThan(0)
    expect(concepts[0]!.name).toBe('Home Location')

    await system.shutdown()
  })
})
