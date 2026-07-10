import { describe, test, expect } from 'bun:test'
import { AgentSystem, ask } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { Kgraph } from '../plugins/memory/kgraph.ts'
import type { KgraphMsg } from '../plugins/memory/kgraph.ts'
import type { ConceptLinksReply, ConceptSearchReply, ConceptUpsertReply, LinkCandidatesReply, MemoryConcept } from '../plugins/memory/types.ts'
import { LlmProviderTopic } from '../types/llm.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import persistencePlugin from '../plugins/persistence/persistence.plugin.ts'

const EMBED_MODEL = 'test-embed'
const DIMS = 4

const tick = (ms = 300) => Bun.sleep(ms)
const tmpDb = () => `/tmp/kgraph-vs-test-${crypto.randomUUID()}`

const embeddingFor = (text: string): number[] => {
  const t = text.toLowerCase()
  if (t.includes('neovim') || t.includes('editor') || t.includes('terminal')) return [1, 0.1, 0.1, 0.1]
  if (t.includes('diet') || t.includes('dairy') || t.includes('meat') || t.includes('fish')) return [0.1, 1, 0.1, 0.1]
  if (t.includes('lisbon') || t.includes('mouraria') || t.includes('live')) return [0.1, 0.1, 1, 0.1]
  if (t.includes('gym') || t.includes('strength') || t.includes('weights')) return [0.1, 0.1, 0.1, 1]
  if (t.includes('brazil') || t.includes('trip') || t.includes('lodging') || t.includes('travel')) return [0.7, 0.7, 0.1, 0.1]
  return [1, 1, 1, 1]
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

function upsertConcept(
  kgraphRef: ActorRef<KgraphMsg>,
  concept: MemoryConcept,
  recordId: string,
  userId = 'test-user',
): Promise<ConceptUpsertReply> {
  return ask<KgraphMsg, ConceptUpsertReply>(
    kgraphRef,
    (replyTo) => ({ type: 'upsertConcept', concept, recordId, userId, replyTo }),
    { timeoutMs: 30_000 },
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
    { timeoutMs: 30_000 },
  )
}

function linkConcepts(
  kgraphRef: ActorRef<KgraphMsg>,
  userId = 'test-user',
): Promise<ConceptLinksReply> {
  return ask<KgraphMsg, ConceptLinksReply>(
    kgraphRef,
    (replyTo) => ({
      type: 'linkConcepts',
      userId,
      links: [{
        from: 'October 2026 Brazil Trip',
        to: 'Rui Travel Plans',
        type: 'ABOUT',
        confidence: 0.9,
      }],
      replyTo,
    }),
    { timeoutMs: 30_000 },
  )
}

function linkCandidates(
  kgraphRef: ActorRef<KgraphMsg>,
  userId = 'test-user',
): Promise<LinkCandidatesReply> {
  return ask<KgraphMsg, LinkCandidatesReply>(
    kgraphRef,
    (replyTo) => ({ type: 'linkCandidates', userId, limit: 6, anchorsPerTarget: 4, replyTo }),
    { timeoutMs: 30_000 },
  )
}

const CONCEPTS: MemoryConcept[] = [
  {
    name: 'Preferred Editor',
    kind: 'preference',
    description: 'The user writes all code in Neovim with custom Lua configuration and prefers terminal-based workflows.',
    topics: ['editor', 'tooling', 'preference'],
  },
  {
    name: 'Dietary Restrictions',
    kind: 'preference',
    description: 'The user is lactose intolerant and follows a pescatarian diet, avoiding meat but eating fish and seafood.',
    topics: ['diet', 'health', 'food', 'preference'],
  },
  {
    name: 'Home Location',
    kind: 'place',
    description: 'The user lives in Lisbon, Portugal, in the Mouraria neighbourhood near the city centre.',
    topics: ['location', 'personal', 'lisbon'],
  },
  {
    name: 'Workout Routine',
    kind: 'fact',
    description: 'The user trains at the gym three times a week focusing on strength training with barbell compound lifts.',
    topics: ['fitness', 'health', 'gym', 'routine'],
  },
]

describe('kgraph concept search', () => {
  test('returns nearest neighbour first when querying with a full sentence', async () => {
    const storagePath = tmpDb()
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: storagePath,
        },
      },
      plugins: [persistencePlugin],
    })
    const llmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: llmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      Kgraph(storagePath, { model: EMBED_MODEL, dimensions: DIMS }),
      { state: { persistenceRef: null, llmRef: null } },
    ) as ActorRef<KgraphMsg>

    await tick()

    for (const [index, concept] of CONCEPTS.entries()) {
      const reply = await upsertConcept(kgraphRef, concept, `rec-${index}`)
      expect(reply.type).toBe('conceptUpsertResult')
    }

    const reply = await conceptSearch(kgraphRef, 'What does the user eat? They avoid dairy and meat but enjoy fish.')

    expect(reply.type).toBe('conceptSearchResult')
    const concepts = reply.type === 'conceptSearchResult' ? reply.concepts : []
    expect(concepts.length).toBeGreaterThan(0)
    expect(concepts[0]!.name).toBe('Dietary Restrictions')

    await system.shutdown()
  })

  test('respects topN limit with sentence queries', async () => {
    const storagePath = tmpDb()
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: storagePath,
        },
      },
      plugins: [persistencePlugin],
    })
    const llmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: llmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      Kgraph(storagePath, { model: EMBED_MODEL, dimensions: DIMS }),
      { state: { persistenceRef: null, llmRef: null } },
    ) as ActorRef<KgraphMsg>

    await tick()
    for (const [index, concept] of CONCEPTS.entries()) {
      expect((await upsertConcept(kgraphRef, concept, `rec-${index}`)).type).toBe('conceptUpsertResult')
    }

    const reply = await conceptSearch(kgraphRef, 'The user lifts heavy weights and follows a structured strength programme.', 2)

    expect(reply.type).toBe('conceptSearchResult')
    const concepts = reply.type === 'conceptSearchResult' ? reply.concepts : []
    expect(concepts.length).toBeLessThanOrEqual(2)
    expect(concepts[0]!.name).toBe('Workout Routine')

    await system.shutdown()
  })

  test('results carry name and description stored at index time', async () => {
    const storagePath = tmpDb()
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: storagePath,
        },
      },
      plugins: [persistencePlugin],
    })
    const llmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: llmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      Kgraph(storagePath, { model: EMBED_MODEL, dimensions: DIMS }),
      { state: { persistenceRef: null, llmRef: null } },
    ) as ActorRef<KgraphMsg>

    await tick()

    const concept = CONCEPTS[2]!
    expect((await upsertConcept(kgraphRef, concept, 'rec-location')).type).toBe('conceptUpsertResult')

    const searchReply = await conceptSearch(kgraphRef, 'Where does the user live? Looking for their city and neighbourhood.')

    expect(searchReply.type).toBe('conceptSearchResult')
    const concepts = searchReply.type === 'conceptSearchResult' ? searchReply.concepts : []
    expect(concepts[0]!.name).toBe('Home Location')
    expect(concepts[0]!.description).toBe(concept.description)
    expect(typeof concepts[0]!.nodeId).toBe('number')
    expect(typeof concepts[0]!.score).toBe('number')

    await system.shutdown()
  })

  test('isolates results by userId', async () => {
    const storagePath = tmpDb()
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: storagePath,
        },
      },
      plugins: [persistencePlugin],
    })
    const llmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: llmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      Kgraph(storagePath, { model: EMBED_MODEL, dimensions: DIMS }),
      { state: { persistenceRef: null, llmRef: null } },
    ) as ActorRef<KgraphMsg>

    await tick()

    await upsertConcept(kgraphRef, CONCEPTS[0]!, 'rec-editor', 'user-a')
    await upsertConcept(kgraphRef, CONCEPTS[1]!, 'rec-diet', 'user-b')

    const query = 'What text editor and terminal tools does the user prefer?'
    const replyA = await conceptSearch(kgraphRef, query, 5, 'user-a')
    const replyB = await conceptSearch(kgraphRef, query, 5, 'user-b')

    expect(replyA.type).toBe('conceptSearchResult')
    expect(replyB.type).toBe('conceptSearchResult')

    const namesA = replyA.type === 'conceptSearchResult' ? replyA.concepts.map(c => c.name) : []
    const namesB = replyB.type === 'conceptSearchResult' ? replyB.concepts.map(c => c.name) : []

    expect(namesA).toContain('Preferred Editor')
    expect(namesA).not.toContain('Dietary Restrictions')
    expect(namesB).toContain('Dietary Restrictions')
    expect(namesB).not.toContain('Preferred Editor')

    await system.shutdown()
  })

  test('returns poorly linked concepts with semantically related anchors', async () => {
    const storagePath = tmpDb()
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: storagePath,
        },
      },
      plugins: [persistencePlugin],
    })
    const llmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: llmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      Kgraph(storagePath, { model: EMBED_MODEL, dimensions: DIMS }),
      { state: { persistenceRef: null, llmRef: null } },
    ) as ActorRef<KgraphMsg>

    await tick()

    const travelConcepts: MemoryConcept[] = [
      {
        name: 'Brazil Lodging Preference',
        kind: 'preference',
        description: 'The user prefers apartment-style lodging for the October 2026 Brazil trip.',
        topics: ['brazil', 'travel'],
      },
      {
        name: 'October 2026 Brazil Trip',
        kind: 'event',
        description: 'The user is planning a Brazil trip in October 2026.',
        topics: ['brazil', 'travel'],
      },
      {
        name: 'Rui Travel Plans',
        kind: 'fact',
        description: 'Travel planning details for Rui.',
        topics: ['travel'],
      },
    ]

    for (const [index, concept] of travelConcepts.entries()) {
      expect((await upsertConcept(kgraphRef, concept, `travel-rec-${index}`)).type).toBe('conceptUpsertResult')
    }
    expect((await linkConcepts(kgraphRef)).type).toBe('conceptLinksResult')

    const reply = await linkCandidates(kgraphRef)
    expect(reply.type).toBe('linkCandidatesResult')
    const candidates = reply.type === 'linkCandidatesResult' ? reply.candidates : []
    const lodging = candidates.find(candidate => candidate.target.name === 'Brazil Lodging Preference')

    expect(lodging?.reason).toBe('orphan')
    expect(lodging?.anchors.map(anchor => anchor.name)).toContain('October 2026 Brazil Trip')

    await system.shutdown()
  })
})
