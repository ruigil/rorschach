import { describe, test, expect } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { AgentSystem, ask } from '../system/index.ts'
import {
  MemorySupervisor,
} from '../plugins/memory/memory-supervisor.ts'
import type { ToolInvokeMsg, ToolReply } from '../types/tools.ts'
import { LlmProviderTopic } from '../types/llm.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import type { ActorRef } from '../system/index.ts'
import type { KgraphMsg, MemoryConcept, MemoryRecord, MemoryRecordsMsg } from '../plugins/memory/types.ts'
import { MemoryRecords } from '../plugins/memory/memory-records.ts'
import { Kgraph } from '../plugins/memory/kgraph.ts'
import type { MessageAttachment } from '../types/events.ts'
import persistencePlugin from '../plugins/persistence/persistence.plugin.ts'

const tick = (ms = 50) => Bun.sleep(ms)
const tmpMemory = () => `/tmp/memory-records-test-${crypto.randomUUID()}`

const spawnMemoryDeps = (system: Awaited<ReturnType<typeof AgentSystem>>) => {
  const recordsRef = system.spawn('records', {
    handler: (state: null, msg: MemoryRecordsMsg) => {
      if (msg.type === 'create') {
        const record: MemoryRecord = {
          recordId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          content: msg.content,
        }
        msg.replyTo.send(record)
      }
      return { state }
    },
  }, { state: null }) as ActorRef<MemoryRecordsMsg>
  const kgraphRef = system.spawn('kgraph', {
    handler: (state: null, _msg: KgraphMsg) => ({ state }),
  }, { state: null }) as ActorRef<KgraphMsg>
  return { recordsRef, kgraphRef }
}

describe('Memory Records', () => {
  test('stores attachment metadata in frontmatter and preserves markdown body bytes', async () => {
    const workPath = tmpMemory()
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: workPath,
        },
      },
      plugins: [persistencePlugin],
    })
    const userId = 'test-user'
    const content = '# Field Note\n\nBody stays exactly as typed.\n'
    const attachments: MessageAttachment[] = [{
      kind: 'image',
      url: '/workspace/media/inbound/photo.png',
      name: 'photo.png',
      alt: 'whiteboard photo',
      mimeType: 'image/png',
    }]

    const recordsRef = system.spawn('records', MemoryRecords()) as ActorRef<MemoryRecordsMsg>
    const created = await ask<MemoryRecordsMsg, MemoryRecord | { error: string }>(
      recordsRef,
      (replyTo) => ({ type: 'create', content, attachments, userId, replyTo }),
    )
    if ('error' in created) throw new Error(created.error)

    const raw = await Bun.file(`${workPath}/doc/memory-records/${userId}/${created.recordId}`).text()
    expect(raw).toContain(`attachments: ${JSON.stringify(attachments)}\n`)
    expect(raw.split('\n---\n\n')[1]).toBe(content)

    const records = await ask<MemoryRecordsMsg, MemoryRecord[]>(
      recordsRef,
      (replyTo) => ({ type: 'readMany', recordIds: [created.recordId], userId, replyTo }),
    )
    expect(records[0]).toEqual(expect.objectContaining({ attachments, content }))

    await system.shutdown()
  })

  test('reads old records without attachment frontmatter', async () => {
    const workPath = tmpMemory()
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: workPath,
        },
      },
      plugins: [persistencePlugin],
    })
    const userId = 'test-user'
    const recordId = 'old-record'
    const content = 'An old body without attachment metadata.\n'

    await mkdir(`${workPath}/doc/memory-records/${userId}`, { recursive: true })
    await Bun.write(
      `${workPath}/doc/memory-records/${userId}/${recordId}`,
      `---\nrecordId: "${recordId}"\ncreatedAt: "2026-01-01T00:00:00.000Z"\n---\n\n${content}`,
    )

    const recordsRef = system.spawn('records', MemoryRecords()) as ActorRef<MemoryRecordsMsg>
    const records = await ask<MemoryRecordsMsg, MemoryRecord[]>(
      recordsRef,
      (replyTo) => ({ type: 'readMany', recordIds: [recordId], userId, replyTo }),
    )

    expect(records[0]).toEqual(expect.objectContaining({ recordId, attachments: undefined, content }))

    await system.shutdown()
  })
})

describe('Memory Store Actor (Supervisor/Worker)', () => {
  test('recall can expand a concept nodeId before reading records', async () => {
    const workPath = tmpMemory()
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: workPath,
        },
      },
      plugins: [persistencePlugin],
    })
    const userId = 'test-user'
    let expanded = false

    const mockLlmDef = {
      handler: (state: any, msg: LlmProviderMsg) => {
        if (msg.type === 'stream') {
          const systemPrompt = msg.messages[0]?.content
          if (typeof systemPrompt === 'string' && systemPrompt.includes('memory recall agent')) {
            const toolMessages = msg.messages.filter((m: any) => m.role === 'tool')
            if (toolMessages.length === 0) {
              msg.replyTo.send({
                type: 'llmToolCalls',
                requestId: msg.requestId,
                calls: [{ id: 'search-1', name: 'memory_search', arguments: JSON.stringify({ query: 'notebook notes storage' }) }],
                usage: { promptTokens: 1, completionTokens: 1 },
              })
              return { state }
            }

            const payload = JSON.parse((toolMessages.at(-1) as { content: string }).content) as any
            if (Array.isArray(payload.concepts) && !expanded) {
              expect(payload.concepts.some((concept: any) => 'cursor' in concept)).toBe(false)
              const nodeId = payload.concepts.find((concept: any) => concept.name === 'Notebook Notes')?.nodeId
              expanded = true
              msg.replyTo.send({
                type: 'llmToolCalls',
                requestId: msg.requestId,
                calls: [{ id: 'expand-1', name: 'memory_expand', arguments: JSON.stringify({ nodeId }) }],
                usage: { promptTokens: 1, completionTokens: 1 },
              })
              return { state }
            }

            if (Array.isArray(payload.concepts)) {
              const recordIds = payload.concepts.flatMap((concept: any) => Array.isArray(concept.recordIds) ? concept.recordIds : [])
              msg.replyTo.send({
                type: 'llmToolCalls',
                requestId: msg.requestId,
                calls: [{ id: 'read-1', name: 'memory_read', arguments: JSON.stringify({ recordIds }) }],
                usage: { promptTokens: 1, completionTokens: 1 },
              })
              return { state }
            }

            msg.replyTo.send({ type: 'llmChunk', requestId: msg.requestId, text: 'Notebook notes are stored through memory-backed note flows.' })
            msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: { promptTokens: 1, completionTokens: 1 } })
          }
          return { state }
        }
        if (msg.type === 'embed') {
          msg.replyTo.send({ type: 'embeddingResult', embedding: [1, 0, 0, 0] })
        }
        return { state }
      },
    }
    const llmRef = system.spawn('mock-llm', mockLlmDef, { state: {} })
    system.publishRetained(LlmProviderTopic, 'llm', { ref: llmRef })

    const recordsRef = system.spawn('records', MemoryRecords()) as ActorRef<MemoryRecordsMsg>
    const kgraphRef = system.spawn(
      'kgraph',
      Kgraph({ model: 'test-embed', dimensions: 4 }),
      { state: { persistenceRef: null, llmRef: null } },
    ) as ActorRef<KgraphMsg>
    const storeRef = system.spawn(
      'memory-supervisor',
      MemorySupervisor({ model: 'test-model', recordsRef, kgraphRef }),
    )
    await tick()

    const recordReply = await ask<MemoryRecordsMsg, MemoryRecord | { error: string }>(
      recordsRef,
      (replyTo) => ({ type: 'create', content: 'Notebook notes are stored through memory-backed note flows.', userId, replyTo }),
    )
    if ('error' in recordReply) throw new Error(recordReply.error)

    const createConcept = (name: string, description: string, recordId: string) => {
      const concept: MemoryConcept = {
        name,
        kind: 'decision',
        description,
        topics: ['notebook', 'memory'],
      }
      return ask<KgraphMsg, { type: 'conceptUpsertResult'; nodeId: number } | { type: 'conceptUpsertError'; error: string }>(
        kgraphRef,
        (replyTo) => ({ type: 'upsertConcept', concept, recordId, userId, replyTo }),
      )
    }

    expect((await createConcept('Notebook Notes', 'Notebook note workflow and note operations.', 'seed-notebook')).type).toBe('conceptUpsertResult')
    expect((await createConcept('Notebook Memory Storage Decision', 'Notebook notes use memory-backed storage.', recordReply.recordId)).type).toBe('conceptUpsertResult')
    const linkReply = await ask<KgraphMsg, { type: 'conceptLinksResult'; linked: number } | { type: 'conceptLinksError'; error: string }>(
      kgraphRef,
      (replyTo) => ({
        type: 'linkConcepts',
        userId,
        links: [{
          from: 'Notebook Notes',
          to: 'Notebook Memory Storage Decision',
          type: 'ABOUT',
          confidence: 0.9,
        }],
        replyTo,
      }),
    )
    expect(linkReply.type).toBe('conceptLinksResult')

    const recallReply = await ask<ToolInvokeMsg, ToolReply>(
      storeRef as unknown as ActorRef<ToolInvokeMsg>,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'recall_memory',
        arguments: JSON.stringify({ query: 'notebook notes storage' }),
        replyTo,
        userId,
      }),
      { timeoutMs: 5_000 },
    )

    expect(recallReply.type).toBe('toolResult')
    const recalled = JSON.parse((recallReply as { type: 'toolResult'; result: { text: string } }).result.text) as { answer: string; sources: Array<{ recordId: string }> }
    expect(recalled.answer).toContain('memory-backed')
    expect(recalled.sources).toEqual([expect.objectContaining({ recordId: recordReply.recordId })])

    await system.shutdown()
  })

  test('stores markdown verbatim and indexes derived concept nodes with recordIds', async () => {
    const workPath = tmpMemory()
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: workPath,
        },
      },
      plugins: [persistencePlugin],
    })
    const userId = 'test-user'
    const markdown = '# Neovim Preference\n\nThe user prefers Neovim for code editing.\n'
    const storedAttachmentUrl = '/home/rigel/rorschach/workspace/media/inbound/neovim.png'
    const storedAttachments: MessageAttachment[] = [{
      kind: 'image',
      url: storedAttachmentUrl,
      name: 'neovim.png',
      alt: 'Neovim preference screenshot',
      mimeType: 'image/png',
    }]
    const recalledAttachments: MessageAttachment[] = [{
      ...storedAttachments[0]!,
      url: 'inbound/neovim.png',
    }]
    const attachmentsWithData: MessageAttachment[] = [{
      ...storedAttachments[0]!,
      data: 'data:image/png;base64,not-for-memory',
    }]
    const extractionUserContents: string[] = []
    const readPayloads: Array<{ records?: Array<{ recordId: string; attachments?: MessageAttachment[] }> }> = []

    const mockLlmDef = {
      handler: (state: any, msg: LlmProviderMsg) => {
        if (msg.type === 'stream') {
          const systemPrompt = msg.messages[0]?.content
          if (typeof systemPrompt === 'string' && systemPrompt.includes('memory recall agent')) {
            const toolMessages = msg.messages.filter((m: any) => m.role === 'tool')
            if (toolMessages.length === 0) {
              msg.replyTo.send({
                type: 'llmToolCalls',
                requestId: msg.requestId,
                calls: [{ id: 'search-1', name: 'memory_search', arguments: JSON.stringify({ query: 'Which editor does the user prefer?' }) }],
                usage: { promptTokens: 1, completionTokens: 1 },
              })
              return { state }
            }

            const assistantMessages = msg.messages.filter((m: any) => m.role === 'assistant')
            const lastAssistant = assistantMessages[assistantMessages.length - 1]
            const toolName = (lastAssistant as any)?.tool_calls?.[0]?.function?.name

            if (toolName === 'memory_search') {
              const payload = JSON.parse((toolMessages.at(-1) as { content: string }).content) as any
              const recordIds = payload.concepts.flatMap((concept: any) => Array.isArray(concept.recordIds) ? concept.recordIds : [])
              msg.replyTo.send({
                type: 'llmToolCalls',
                requestId: msg.requestId,
                calls: [{ id: 'read-1', name: 'memory_read', arguments: JSON.stringify({ recordIds }) }],
                usage: { promptTokens: 1, completionTokens: 1 },
              })
              return { state }
            }

            if (toolName === 'memory_read') {
              const payload = JSON.parse((toolMessages.at(-1) as { content: string }).content) as any
              readPayloads.push(payload)
              msg.replyTo.send({ type: 'llmChunk', requestId: msg.requestId, text: 'The user prefers Neovim editor for coding.' })
              msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: { promptTokens: 1, completionTokens: 1 } })
              return { state }
            }
          }

          if (typeof systemPrompt === 'string' && systemPrompt.includes('memory indexing agent')) {
            const content = msg.messages[1]!.content
            if (typeof content === 'string') {
              extractionUserContents.push(content)
            }
            const text = JSON.stringify({
              concepts: [
                {
                  name: 'Neovim Preference',
                  kind: 'preference',
                  description: 'The user prefers Neovim for code editing.',
                  aliases: ['preferred editor', 'code editor'],
                  topics: ['coding', 'editing'],
                },
                {
                  name: 'Code Editing',
                  kind: 'task',
                  description: 'The user edits code.',
                  topics: ['coding', 'editing'],
                },
              ],
              links: [{
                from: 'Neovim Preference',
                to: 'Code Editing',
                type: 'ABOUT',
                confidence: 0.8,
              }],
            })
            msg.replyTo.send({ type: 'llmChunk', requestId: msg.requestId, text })
            msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: { promptTokens: 1, completionTokens: 1 } })
          }
          return { state }
        }
        if (msg.type === 'embed') {
          msg.replyTo.send({ type: 'embeddingResult', embedding: [1, 0, 0, 0] })
        }
        return { state }
      },
    }
    const llmRef = system.spawn('mock-llm', mockLlmDef, { state: {} })
    system.publishRetained(LlmProviderTopic, 'llm', { ref: llmRef })

    const recordsRef = system.spawn('records', MemoryRecords()) as ActorRef<MemoryRecordsMsg>
    const kgraphRef = system.spawn(
      'kgraph',
      Kgraph({ model: 'test-embed', dimensions: 4 }),
      { state: { persistenceRef: null, llmRef: null } },
    ) as ActorRef<KgraphMsg>
    const storeRef = system.spawn(
      'memory-supervisor',
      MemorySupervisor({ model: 'test-model', recordsRef, kgraphRef }),
    )

    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      storeRef as unknown as ActorRef<ToolInvokeMsg>,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'store_memory',
        arguments: JSON.stringify({ content: markdown, attachments: attachmentsWithData }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 5_000 },
    )

    expect(reply.type).toBe('toolResult')
    const result = JSON.parse((reply as { type: 'toolResult'; result: { text: string } }).result.text) as { recordId: string; indexedConcepts: number }
    expect(result.indexedConcepts).toBe(2)
    expect(extractionUserContents).toEqual([markdown])

    const stored = await Bun.file(`${workPath}/doc/memory-records/test-user/${result.recordId}`).text()
    expect(stored).toStartWith('---\n')
    expect(stored).toContain(`recordId: "${result.recordId}"`)
    expect(stored).toContain(`attachments: ${JSON.stringify(storedAttachments)}\n`)
    expect(stored).not.toContain('not-for-memory')
    expect(stored).toContain('\n---\n\n' + markdown)

    const graph = await ask<KgraphMsg, any>(
      kgraphRef,
      (replyTo) => ({ type: 'dump', userId: 'test-user', replyTo }),
      { timeoutMs: 5_000 },
    )
    const concept = graph.nodes.find((n: any) => n.labels.includes('Concept') && n.properties.name === 'Neovim Preference')
    expect(concept).toBeTruthy()
    expect(concept.properties.kind).toBe('preference')
    expect(concept.properties.description).toBe('The user prefers Neovim for code editing.')
    expect(concept.properties.aliases).toEqual(['preferred editor', 'code editor'])
    expect(concept.properties.recordIds).toContain(result.recordId)
    const edge = graph.edges.find((e: any) => e.type === 'ABOUT')
    expect(edge).toBeTruthy()
    expect(edge.properties.recordIds).toBeUndefined()
    expect(edge.properties.confidence).toBe(0.8)

    const duplicateRecord = await ask<MemoryRecordsMsg, MemoryRecord | { error: string }>(
      recordsRef,
      (replyTo) => ({
        type: 'create',
        content: 'The Neovim preference screenshot is archived with the note.',
        attachments: storedAttachments,
        userId: 'test-user',
        replyTo,
      }),
    )
    if ('error' in duplicateRecord) throw new Error(duplicateRecord.error)
    const duplicateConcept: MemoryConcept = {
      name: 'Neovim Preference Screenshot',
      kind: 'fact',
      description: 'The Neovim preference screenshot is archived with the note.',
      topics: ['editor', 'preference'],
    }
    const duplicateConceptReply = await ask<KgraphMsg, { type: 'conceptUpsertResult'; nodeId: number } | { type: 'conceptUpsertError'; error: string }>(
      kgraphRef,
      (replyTo) => ({ type: 'upsertConcept', concept: duplicateConcept, recordId: duplicateRecord.recordId, userId: 'test-user', replyTo }),
    )
    expect(duplicateConceptReply.type).toBe('conceptUpsertResult')

    const recallReply = await ask<ToolInvokeMsg, ToolReply>(
      storeRef as unknown as ActorRef<ToolInvokeMsg>,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'recall_memory',
        arguments: JSON.stringify({ query: 'Which editor does the user prefer?' }),
        replyTo,
        userId: 'test-user',
      }),
      { timeoutMs: 5_000 },
    )
    expect(recallReply.type).toBe('toolResult')
    const toolResult = recallReply as { type: 'toolResult'; result: { text: string; attachments?: MessageAttachment[] } }
    const recalled = JSON.parse(toolResult.result.text) as { answer: string; sources: Array<{ recordId: string; content: string; attachments?: MessageAttachment[] }> }
    expect(recalled.answer).toContain('Neovim')
    expect(readPayloads.at(-1)?.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordId: result.recordId, attachments: storedAttachments }),
    ]))
    expect(recalled.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordId: result.recordId, content: markdown, attachments: storedAttachments }),
      expect.objectContaining({ recordId: duplicateRecord.recordId, attachments: storedAttachments }),
    ]))
    expect(toolResult.result.attachments).toEqual(recalledAttachments)

    await system.shutdown()
  })

  test('handles multiple concurrent invoke requests by spawning workers', async () => {
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: tmpMemory(),
        },
      },
      plugins: [persistencePlugin],
    })

    // 1. Mock LLM Provider
    const mockLlmDef = {
      handler: (state: any, msg: LlmProviderMsg) => {
        if (msg.type === 'stream') {
          // Delay response to simulate work and allow concurrency
          const text = `Stored memory for: ${msg.messages[1]?.content}`
          setTimeout(() => {
            msg.replyTo.send({
              type: 'llmChunk',
              requestId: msg.requestId,
              text,
            })
            msg.replyTo.send({
              type: 'llmDone',
              requestId: msg.requestId,
              usage: { promptTokens: 10, completionTokens: 10 }
            })
          }, 100)
        }
        return { state }
      }
    }
    const llmRef = system.spawn('mock-llm', mockLlmDef, { state: {} })
    system.publishRetained(LlmProviderTopic, 'llm', { ref: llmRef })

    // 2. Spawn Memory Store Supervisor
    const { recordsRef, kgraphRef } = spawnMemoryDeps(system)
    const storeRef = system.spawn(
      'memory-supervisor',
      MemorySupervisor({ model: 'test-model', recordsRef, kgraphRef }),
    )

    await tick(100) // Wait for subscriptions

    // 3. Send two concurrent requests
    const promise1 = ask<ToolInvokeMsg, ToolReply>(
      storeRef as unknown as ActorRef<ToolInvokeMsg>,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'store_memory',
        arguments: JSON.stringify({ content: 'I like apples' }),
        replyTo,
        userId: 'test-user',
      })
    )

    const promise2 = ask<ToolInvokeMsg, ToolReply>(
      storeRef as unknown as ActorRef<ToolInvokeMsg>,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'store_memory',
        arguments: JSON.stringify({ content: 'I like oranges' }),
        replyTo,
        userId: 'test-user',
      })
    )

    const [reply1, reply2] = await Promise.all([promise1, promise2])

    expect(reply1.type).toBe('toolResult')
    expect(reply2.type).toBe('toolResult')

    if (reply1.type === 'toolResult') {
      expect(reply1.result.text).toContain('stored')
    }
    if (reply2.type === 'toolResult') {
      expect(reply2.result.text).toContain('stored')
    }

    await system.shutdown()
  })

  test('reports error when LLM provider is missing', async () => {
    const system = await AgentSystem({
      config: {
        persistence: {
          storageRoot: tmpMemory(),
        },
      },
      plugins: [persistencePlugin],
    })

    const { recordsRef, kgraphRef } = spawnMemoryDeps(system)
    const storeRef = system.spawn(
      'memory-supervisor',
      MemorySupervisor({ model: 'test-model', recordsRef, kgraphRef }),
    )

    await tick()

    const reply = await ask<ToolInvokeMsg, ToolReply>(
      storeRef as unknown as ActorRef<ToolInvokeMsg>,
      (replyTo) => ({
        type: 'invoke',
        toolName: 'store_memory',
        arguments: JSON.stringify({ content: 'test' }),
        replyTo,
        userId: 'test-user',
      })
    )

    expect(reply.type).toBe('toolError')
    if (reply.type === 'toolError') {
      expect(reply.error).toBe('Memory not ready')
    }

    await system.shutdown()
  })
})
