import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { rm, mkdir } from 'node:fs/promises'
import { GrafeoDB } from '@grafeo-db/js'
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

const API_KEY    = process.env.OPENROUTER_API_KEY ?? ''
const EMBED_MODEL = 'qwen/qwen3-embedding-8b'
const DIMS       = 4096
const TEST_DB    = '/tmp/kgraph-crosssession-test'
const USER_ID    = 'test-user'

const tick = (ms = 500) => Bun.sleep(ms)
const withKey = test.skipIf(!API_KEY)

// ─── Helpers ───

function spawnSystem() {
  return createPluginSystem()
}

function spawnLlm(system: Awaited<ReturnType<typeof createPluginSystem>>): ActorRef<LlmProviderMsg> {
  const adapter = createOpenRouterAdapter({ apiKey: API_KEY })
  return system.spawn('llm', createLlmProviderActor({ adapter })) as ActorRef<LlmProviderMsg>
}

function spawnKgraph(system: Awaited<ReturnType<typeof createPluginSystem>>): ActorRef<KgraphMsg> {
  return system.spawn(
    'kgraph',
    createKgraphActor(TEST_DB, { model: EMBED_MODEL, dimensions: DIMS }),
    { state: { userDbs: new Map(), llmRef: null } },
  ) as ActorRef<KgraphMsg>
}

function createNode(kgraphRef: ActorRef<KgraphMsg>, name: string, synopsis: string, tags: string[]): Promise<ToolReply> {
  const embeddingText = `${synopsis} ${tags.join(' ')}`
  const args = JSON.stringify({ label: 'Note', name, properties: { description: synopsis }, embeddingText, userId: USER_ID })
  return ask<KgraphMsg, ToolReply>(
    kgraphRef,
    (replyTo) => ({ type: 'invoke', toolName: KGRAPH_CREATE_NODE_TOOL_NAME, arguments: args, replyTo, userId: USER_ID }),
    { timeoutMs: 30_000 },
  )
}

function vectorSearch(kgraphRef: ActorRef<KgraphMsg>, text: string): Promise<VectorSearchReply> {
  return ask<KgraphMsg, VectorSearchReply>(
    kgraphRef,
    (replyTo) => ({ type: 'vectorSearch', label: 'Note', text, topN: 5, userId: USER_ID, replyTo }),
    { timeoutMs: 30_000 },
  )
}

// ─── Setup ───

beforeAll(async () => {
  await rm(TEST_DB, { recursive: true, force: true })
  await mkdir(TEST_DB, { recursive: true })
})

afterAll(async () => {
  await rm(TEST_DB, { recursive: true, force: true })
})

// ─── Tests ───
// Tests run in declaration order. The inject test populates the DB; the
// recall test opens the same path in a fresh system to simulate a process restart.

describe('kgraph cross-session persistence', () => {

  withKey('inject: creates a node and finds it in the same session', async () => {
    const system = await spawnSystem()
    const llmRef = spawnLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: llmRef })

    const kgraphRef = spawnKgraph(system)
    await tick()

    const createReply = await createNode(
      kgraphRef,
      'Home Location',
      'The user lives in Lisbon, Portugal, in the Mouraria neighbourhood.',
      ['location', 'personal', 'lisbon'],
    )
    expect(createReply.type).toBe('toolResult')

    const searchReply = await vectorSearch(kgraphRef, 'Where does the user live?')
    expect(searchReply.type).toBe('vectorSearchResult')
    const { matches } = searchReply as { type: 'vectorSearchResult'; matches: VectorSearchMatch[] }
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0]!.name).toBe('Home Location')

    await system.shutdown()
  }, 60_000)

  withKey('raw db: inspect node properties and test cypher vector search', async () => {
    const DB_PATH = `${TEST_DB}/${USER_ID}/kgraph`
    const db = GrafeoDB.create(DB_PATH)

    await db.execute(`CREATE VECTOR INDEX idx_note_embedding ON :Note(_embedding) DIMENSION ${DIMS} METRIC 'cosine'`).catch(e => console.log('createVectorIndex:', e))

    const queryVec = new Array(DIMS).fill(0.1)
    const vectorStr = `[${queryVec.join(',')}]`
    const resultsResult = await db.execute(`
      MATCH (n:Note)
      WHERE cosine_similarity(n._embedding, vector(${vectorStr})) > 0.0
      RETURN id(n) AS nodeId, n.name AS name, cosine_similarity(n._embedding, vector(${vectorStr})) AS score
      ORDER BY score DESC
      LIMIT 5
    `)
    const results = resultsResult.rows() as []

    db.close()
    expect(results.length).toBeGreaterThan(0)
  }, 60_000)

  withKey('recall: finds the node from the previous session without re-injecting', async () => {
    // Fresh system + fresh actor at the same DB path — simulates a process restart
    const system = await spawnSystem()
    const llmRef = spawnLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: llmRef })

    const kgraphRef = spawnKgraph(system)
    await tick()

    // No injection — search against persisted data only
    const searchReply = await vectorSearch(kgraphRef, 'Where does the user live?')
    expect(searchReply.type).toBe('vectorSearchResult')
    const { matches } = searchReply as { type: 'vectorSearchResult'; matches: VectorSearchMatch[] }
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0]!.name).toBe('Home Location')

    await system.shutdown()
  }, 60_000)

})
