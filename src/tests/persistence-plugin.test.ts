import { describe, test, expect, afterAll } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import { PersistenceProviderTopic, type PersistenceMsg } from '../types/persistence.ts'
import persistencePlugin from '../plugins/persistence/persistence.plugin.ts'
import { ask, type ActorRef } from '../system/index.ts'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const TEST_STORAGE_ROOT = 'workspace/persistence_test'

const tick = (ms = 50) => Bun.sleep(ms)

describe('Persistence Plugin Engine', () => {
  afterAll(async () => {
    try {
      await rm(resolve(TEST_STORAGE_ROOT), { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  test('KV Store: CRUD and list operations', async () => {
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: TEST_STORAGE_ROOT,
        },
      },
      plugins: [persistencePlugin],
    })

    let persistenceRef: ActorRef<PersistenceMsg> | null = null
    system.subscribe(PersistenceProviderTopic, (event: any) => {
      if (event?.ref) {
        persistenceRef = event.ref
      }
    })

    await tick(100)
    expect(persistenceRef).not.toBeNull()

    const putRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'kv.put' as const,
      key: 'test/item-1',
      value: { name: 'Persistence', version: 1 },
      replyTo,
    }))
    expect(putRes.ok).toBe(true)

    const getRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'kv.get' as const,
      key: 'test/item-1',
      replyTo,
    }))
    expect(getRes.ok).toBe(true)
    expect(getRes.data).toEqual({ name: 'Persistence', version: 1 })

    const listRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'kv.list' as const,
      prefix: 'test',
      replyTo,
    }))
    expect(listRes.ok).toBe(true)
    expect(listRes.keys).toContain('test/item-1')

    const delRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'kv.delete' as const,
      key: 'test/item-1',
      replyTo,
    }))
    expect(delRes.ok).toBe(true)

    const getFailRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'kv.get' as const,
      key: 'test/item-1',
      replyTo,
    }))
    expect(getFailRes.ok).toBe(false)

    await system.shutdown()
  })

  test('Document Store: CRUD, Append, Head and List operations', async () => {
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: TEST_STORAGE_ROOT,
        },
      },
      plugins: [persistencePlugin],
    })

    let persistenceRef: ActorRef<PersistenceMsg> | null = null
    system.subscribe(PersistenceProviderTopic, (event: any) => {
      if (event?.ref) persistenceRef = event.ref
    })

    await tick(100)

    const putRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'doc.put' as const,
      collection: 'notebooks',
      docId: 'daily/2026-07-08.md',
      content: '# Hello Persistence\n',
      replyTo,
    }))
    expect(putRes.ok).toBe(true)

    const headRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'doc.head' as const,
      collection: 'notebooks',
      docId: 'daily/2026-07-08.md',
      replyTo,
    }))
    expect(headRes.ok).toBe(true)
    expect(headRes.data.exists).toBe(true)

    const appendRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'doc.append' as const,
      collection: 'notebooks',
      docId: 'daily/2026-07-08.md',
      content: '## Section 2\n',
      replyTo,
    }))
    expect(appendRes.ok).toBe(true)

    const getRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'doc.get' as const,
      collection: 'notebooks',
      docId: 'daily/2026-07-08.md',
      replyTo,
    }))
    expect(getRes.ok).toBe(true)
    expect(getRes.data).toBe('# Hello Persistence\n## Section 2\n')

    const listRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'doc.list' as const,
      collection: 'notebooks',
      prefix: 'daily/',
      replyTo,
    }))
    expect(listRes.ok).toBe(true)
    expect(listRes.keys).toEqual(['daily/2026-07-08.md'])

    const delRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'doc.delete' as const,
      collection: 'notebooks',
      docId: 'daily/2026-07-08.md',
      replyTo,
    }))
    expect(delRes.ok).toBe(true)

    await system.shutdown()
  })

  test('Object Store: Binary CRUD and Streaming', async () => {
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: TEST_STORAGE_ROOT,
        },
      },
      plugins: [persistencePlugin],
    })

    let persistenceRef: ActorRef<PersistenceMsg> | null = null
    system.subscribe(PersistenceProviderTopic, (event: any) => {
      if (event?.ref) persistenceRef = event.ref
    })

    await tick(100)

    const binaryData = new Uint8Array([1, 2, 3, 4, 5, 255])
    const meta = { 'content-type': 'image/png', author: 'Rorschach' }

    const putRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'obj.put' as const,
      bucket: 'photos',
      key: 'vacation/sunset.png',
      data: binaryData,
      meta,
      replyTo,
    }))
    expect(putRes.ok).toBe(true)

    const headRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'obj.head' as const,
      bucket: 'photos',
      key: 'vacation/sunset.png',
      replyTo,
    }))
    expect(headRes.ok).toBe(true)
    expect(headRes.data).toEqual(meta)

    const getRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'obj.get' as const,
      bucket: 'photos',
      key: 'vacation/sunset.png',
      replyTo,
    }))
    expect(getRes.ok).toBe(true)
    expect(getRes.data.data).toEqual(binaryData)
    expect(getRes.data.meta).toEqual(meta)

    const testStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([10, 20, 30, 40]))
        controller.close()
      }
    })
    const putStreamRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'obj.putStream' as const,
      bucket: 'photos',
      key: 'vacation/streamed.png',
      stream: testStream,
      meta: { 'content-type': 'image/png', source: 'stream' },
      replyTo,
    }))
    expect(putStreamRes.ok).toBe(true)

    const getStreamRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'obj.getStream' as const,
      bucket: 'photos',
      key: 'vacation/streamed.png',
      replyTo,
    }))
    expect(getStreamRes.ok).toBe(true)
    expect(getStreamRes.data.meta['content-type']).toBe('image/png')
    expect(getStreamRes.data.meta['source']).toBe('stream')

    const reader = getStreamRes.data.stream.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    const combinedLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
    const combined = new Uint8Array(combinedLength)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.length
    }
    expect(combined).toEqual(new Uint8Array([10, 20, 30, 40]))

    const delRes1 = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'obj.delete' as const,
      bucket: 'photos',
      key: 'vacation/sunset.png',
      replyTo,
    }))
    expect(delRes1.ok).toBe(true)

    const delRes2 = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'obj.delete' as const,
      bucket: 'photos',
      key: 'vacation/streamed.png',
      replyTo,
    }))
    expect(delRes2.ok).toBe(true)

    await system.shutdown()
  })

  test('Graph Store: Upsert, Similarity search and Cypher query', async () => {
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: TEST_STORAGE_ROOT,
        },
      },
      plugins: [persistencePlugin],
    })

    let persistenceRef: ActorRef<PersistenceMsg> | null = null
    system.subscribe(PersistenceProviderTopic, (event: any) => {
      if (event?.ref) persistenceRef = event.ref
    })

    await tick(100)

    const graphId = 'test-graph'
    


    const nodeA = {
      id: 'concept-A',
      type: 'Concept',
      properties: { name: 'Machine Learning', description: 'Study of algorithms' },
      embedding: [0.9, 0.1, 0.0],
    }
    const nodeB = {
      id: 'concept-B',
      type: 'Concept',
      properties: { name: 'Deep Learning', description: 'Neural networks' },
      embedding: [0.8, 0.2, 0.0],
    }
    const edge = {
      source: 'concept-A',
      target: 'concept-B',
      type: 'RELATES_TO',
      properties: { confidence: 0.95 },
    }

    const upsertRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'graph.upsert' as const,
      graphId,
      nodes: [nodeA, nodeB],
      edges: [edge],
      replyTo,
    }))
    if (!upsertRes.ok) console.error("Upsert failed with:", upsertRes.error)
    expect(upsertRes.ok).toBe(true)

    const queryRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'graph.query' as const,
      graphId,
      cypher: 'MATCH (n:Concept) RETURN n.name AS name ORDER BY name DESC',
      params: {},
      replyTo,
    }))
    expect(queryRes.ok).toBe(true)
    const rows = queryRes.data
    expect(rows).toHaveLength(2)
    expect(rows[0].name).toBe('Machine Learning')
    expect(rows[1].name).toBe('Deep Learning')

    const searchRes = await ask<PersistenceMsg, any>(persistenceRef!, (replyTo) => ({
      type: 'graph.search' as const,
      graphId,
      embedding: [1.0, 0.0, 0.0],
      topK: 1,
      replyTo,
    }))
    expect(searchRes.ok).toBe(true)
    const searchMatches = searchRes.data
    expect(searchMatches).toHaveLength(1)
    expect(searchMatches[0].id).toBe('concept-A')

    await system.shutdown()
  })
})
