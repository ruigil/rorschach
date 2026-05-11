import { describe, test, expect } from 'bun:test'
import { createPluginSystem, ask } from '../system/index.ts'
import type { ActorRef } from '../system/index.ts'
import { createKgraphActor, KGRAPH_CREATE_NODE_TOOL_NAME } from '../plugins/memory/kgraph.ts'
import type { KgraphMsg } from '../plugins/memory/kgraph.ts'
import type { VectorSearchMatch, VectorSearchReply } from '../plugins/memory/types.ts'
import { LlmProviderTopic } from '../types/llm.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import type { ToolReply } from '../types/tools.ts'
import { createLlmProviderActor, createOpenRouterAdapter } from '../plugins/cognitive/llm-provider.ts'

// ─── Config ───

const API_KEY = process.env.OPENROUTER_API_KEY ?? ''
const EMBED_MODEL = 'qwen/qwen3-embedding-8b'
const DIMS = 4096

const tick = (ms = 300) => Bun.sleep(ms)
const tmpDb = () => `/tmp/kgraph-vs-test-${crypto.randomUUID()}.db`

// ─── Helpers ───

function spawnRealLlm(system: Awaited<ReturnType<typeof createPluginSystem>>): ActorRef<LlmProviderMsg> {
  const adapter = createOpenRouterAdapter({ apiKey: API_KEY })
  return system.spawn('llm', createLlmProviderActor({ adapter })) as ActorRef<LlmProviderMsg>
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
    { timeoutMs: 30_000 },
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
    { timeoutMs: 30_000 },
  )
}

// ─── Fixtures ───
//
// Each note mirrors the zettel embeddingText format: `${synopsis} ${tags.join(' ')}`
// Topics are semantically distinct so the embedding model can separate them cleanly.

type Note = { name: string; synopsis: string; tags: string[]; content: string }

const zettelEmbeddingText = (note: Note) => `${note.synopsis} ${note.tags.join(' ')}`

const NOTES: Note[] = [
  {
    name: 'Preferred Editor',
    synopsis: 'The user writes all code in Neovim with custom Lua configuration and prefers terminal-based workflows.',
    tags: ['editor', 'tooling', 'preference'],
    content: 'Uses Neovim as the primary editor. Config lives in ~/.config/nvim. LSP via nvim-lspconfig, fuzzy finding via Telescope. Avoids GUI editors.',
  },
  {
    name: 'Dietary Restrictions',
    synopsis: 'The user is lactose intolerant and follows a pescatarian diet, avoiding meat but eating fish and seafood.',
    tags: ['diet', 'health', 'food', 'preference'],
    content: 'No dairy products. No meat (beef, pork, chicken). Fish and seafood are fine. Prefers Mediterranean-style meals.',
  },
  {
    name: 'Home Location',
    synopsis: 'The user lives in Lisbon, Portugal, in the Mouraria neighbourhood near the city centre.',
    tags: ['location', 'personal', 'lisbon'],
    content: 'Based in Lisbon, Portugal. Neighbourhood: Mouraria. Close to public transport. Works from home most days.',
  },
  {
    name: 'Workout Routine',
    synopsis: 'The user trains at the gym three times a week focusing on strength training with barbell compound lifts.',
    tags: ['fitness', 'health', 'gym', 'routine'],
    content: 'Monday / Wednesday / Friday: squat, deadlift, bench press, overhead press. Progressive overload approach. No cardio machines.',
  },
]

// ─── Tests ───

const withKey = test.skipIf(!API_KEY)

describe('kgraph vector search (real embeddings)', () => {

  withKey('returns nearest neighbour first when querying with a full sentence', async () => {
    const system = await createPluginSystem()
    const llmRef = spawnRealLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: llmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      createKgraphActor(tmpDb(), { model: EMBED_MODEL, dimensions: DIMS }),
      { state: { userDbs: new Map(), llmRef: null } },
    ) as ActorRef<KgraphMsg>

    await tick()

    for (const note of NOTES) {
      const reply = await createNode(kgraphRef, note.name, note.synopsis, zettelEmbeddingText(note))
      expect(reply.type).toBe('toolResult')
    }

    const reply = await vectorSearch(
      kgraphRef,
      'What does the user eat? They avoid dairy and meat but enjoy fish.',
    )

    expect(reply.type).toBe('vectorSearchResult')
    const { matches } = reply as { type: 'vectorSearchResult'; matches: VectorSearchMatch[] }
    console.log('scores:', matches.map(m => `${m.name}: ${m.score.toFixed(4)}`))
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0]!.name).toBe('Dietary Restrictions')

    await system.shutdown()
  }, 60_000)

  withKey('respects topN limit with sentence queries', async () => {
    const system = await createPluginSystem()
    const llmRef = spawnRealLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: llmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      createKgraphActor(tmpDb(), { model: EMBED_MODEL, dimensions: DIMS }),
      { state: { userDbs: new Map(), llmRef: null } },
    ) as ActorRef<KgraphMsg>

    await tick()

    for (const note of NOTES) {
      const reply = await createNode(kgraphRef, note.name, note.synopsis, zettelEmbeddingText(note))
      expect(reply.type).toBe('toolResult')
    }

    const reply = await vectorSearch(
      kgraphRef,
      'The user lifts heavy weights and follows a structured strength programme.',
      2,
    )

    expect(reply.type).toBe('vectorSearchResult')
    const { matches } = reply as { type: 'vectorSearchResult'; matches: VectorSearchMatch[] }
    console.log(matches)
    expect(matches.length).toBeLessThanOrEqual(2)
    expect(matches[0]!.name).toBe('Workout Routine')

    await system.shutdown()
  }, 60_000)

  withKey('results carry name and description stored at index time', async () => {
    const system = await createPluginSystem()
    const llmRef = spawnRealLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: llmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      createKgraphActor(tmpDb(), { model: EMBED_MODEL, dimensions: DIMS }),
      { state: { userDbs: new Map(), llmRef: null } },
    ) as ActorRef<KgraphMsg>

    await tick()

    const note = NOTES[2]! // Home Location
    const reply = await createNode(kgraphRef, note.name, note.synopsis, zettelEmbeddingText(note))
    expect(reply.type).toBe('toolResult')

    const searchReply = await vectorSearch(
      kgraphRef,
      'Where does the user live? Looking for their city and neighbourhood.',
    )

    expect(searchReply.type).toBe('vectorSearchResult')
    const { matches } = searchReply as { type: 'vectorSearchResult'; matches: VectorSearchMatch[] }
    expect(matches[0]!.name).toBe('Home Location')
    expect(matches[0]!.description).toBe(note.synopsis)
    expect(typeof matches[0]!.nodeId).toBe('number')
    expect(typeof matches[0]!.score).toBe('number')

    await system.shutdown()
  }, 60_000)

  withKey('isolates results by userId', async () => {
    const system = await createPluginSystem()
    const llmRef = spawnRealLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: llmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      createKgraphActor(tmpDb(), { model: EMBED_MODEL, dimensions: DIMS }),
      { state: { userDbs: new Map(), llmRef: null } },
    ) as ActorRef<KgraphMsg>

    await tick()

    const editorNote = NOTES[0]! // Preferred Editor
    const dietNote   = NOTES[1]! // Dietary Restrictions
    await createNode(kgraphRef, editorNote.name, editorNote.synopsis, zettelEmbeddingText(editorNote), 'user-a')
    await createNode(kgraphRef, dietNote.name,   dietNote.synopsis,   zettelEmbeddingText(dietNote),   'user-b')

    const query = 'What text editor and terminal tools does the user prefer?'
    const replyA = await vectorSearch(kgraphRef, query, 5, 'user-a')
    const replyB = await vectorSearch(kgraphRef, query, 5, 'user-b')

    expect(replyA.type).toBe('vectorSearchResult')
    expect(replyB.type).toBe('vectorSearchResult')

    const namesA = (replyA as { type: 'vectorSearchResult'; matches: VectorSearchMatch[] }).matches.map(m => m.name)
    const namesB = (replyB as { type: 'vectorSearchResult'; matches: VectorSearchMatch[] }).matches.map(m => m.name)

    expect(namesA).toContain('Preferred Editor')
    expect(namesA).not.toContain('Dietary Restrictions')

    expect(namesB).toContain('Dietary Restrictions')
    expect(namesB).not.toContain('Preferred Editor')

    await system.shutdown()
  }, 60_000)

})
