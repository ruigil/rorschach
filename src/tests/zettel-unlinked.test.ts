import { afterEach, describe, test, expect } from 'bun:test'
import { rm } from 'node:fs/promises'
import { AgentSystem, ask } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { Kgraph } from '../plugins/memory/kgraph.ts'
import type { KgraphGraph, KgraphMsg } from '../plugins/memory/kgraph.ts'
import { ZettelNotes, zettelCreateTool, zettelLinkTool, zettelLinksTool, zettelUnlinkedTool } from '../plugins/memory/zettel-notes.ts'
import type { ZettelNoteMsg } from '../plugins/memory/zettel-notes.ts'
import { LlmProviderTopic } from '../types/llm.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import type { ToolInvokeMsg, ToolReply } from '../types/tools.ts'

// ─── Helpers ───

const tick = (ms = 150) => Bun.sleep(ms)

const tmpKgraph = () => `/tmp/zettel-kgraph-test-${crypto.randomUUID()}.db`
const tmpZettel = () => `/tmp/zettel-data-test-${crypto.randomUUID()}`

function spawnMockLlm(system: any): ActorRef<LlmProviderMsg> {
  const def: ActorDef<LlmProviderMsg, null> = {
    handler: (state, msg) => {
      if (msg.type === 'embed') {
        msg.replyTo.send({ type: 'embeddingResult', embedding: [0, 0, 0, 0] })
      }
      return { state }
    },
  }
  return system.spawn('mock-llm', def) as ActorRef<LlmProviderMsg>
}

const invokeZettel = (
  zettelRef: ActorRef<ZettelNoteMsg>,
  toolName: string,
  args: Record<string, unknown>,
  userId = 'test-user',
): Promise<ToolReply> =>
  ask<ToolInvokeMsg, ToolReply>(
    zettelRef as ActorRef<ToolInvokeMsg>,
    (replyTo) => ({ type: 'invoke', toolName, arguments: JSON.stringify(args), replyTo, userId }),
    { timeoutMs: 5_000 },
  )

const toolJson = <T>(reply: ToolReply): T =>
  JSON.parse((reply as { type: 'toolResult'; result: { text: string } }).result.text) as T

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('zettel-notes unlinked notes', () => {

  test('creates links from schema fromId/toId arguments in notes and kgraph', async () => {
    const system = await AgentSystem()
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    const kgraphRef = system.spawn('kgraph', Kgraph(tmpKgraph(), { model: 'test-embed', dimensions: 4 }), { state: { userDbs: new Map(), llmRef: null } }) as ActorRef<KgraphMsg>

    const zettelDir = tmpZettel()
    tempDirs.push(zettelDir)
    const zettelRef = system.spawn('zettel', ZettelNotes(kgraphRef, zettelDir), { state: { kgraphRef, workPath: zettelDir } }) as ActorRef<ZettelNoteMsg>

    await tick()

    const sourceReply = await invokeZettel(zettelRef, zettelCreateTool.name, {
      name: 'Source Note',
      synopsis: 'source synopsis',
      content: 'source content',
      tags: ['test'],
    })
    const targetReply = await invokeZettel(zettelRef, zettelCreateTool.name, {
      name: 'Target Note',
      synopsis: 'target synopsis',
      content: 'target content',
      tags: ['test'],
    })

    const source = toolJson<{ id: string }>(sourceReply)
    const target = toolJson<{ id: string }>(targetReply)

    const linkReply = await invokeZettel(zettelRef, zettelLinkTool.name, {
      fromId: source.id,
      toId: target.id,
      linkType: 'supports',
    })
    expect(linkReply.type).toBe('toolResult')
    expect(toolJson<{ created: boolean }>(linkReply).created).toBe(true)

    const duplicateLinkReply = await invokeZettel(zettelRef, zettelLinkTool.name, {
      fromId: source.id,
      toId: target.id,
      linkType: 'supports',
    })
    expect(duplicateLinkReply.type).toBe('toolResult')
    expect(toolJson<{ created: boolean; message: string }>(duplicateLinkReply)).toEqual(expect.objectContaining({
      created: false,
      message: 'Link already exists',
    }))

    const linksReply = await invokeZettel(zettelRef, zettelLinksTool.name, { id: source.id })
    const links = toolJson<Array<{ id: string; name: string; linkType: string }>>(linksReply)
    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: target.id, name: 'Target Note', linkType: 'supports' }),
    ]))

    const graph = await ask<KgraphMsg, KgraphGraph>(
      kgraphRef,
      (replyTo) => ({ type: 'dump', userId: 'test-user', replyTo }),
      { timeoutMs: 5_000 },
    )
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]?.type).toBe('SUPPORTS')

    await system.shutdown()
  })

  test('normalizes trailing punctuation on link note IDs', async () => {
    const system = await AgentSystem()
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    const kgraphRef = system.spawn('kgraph', Kgraph(tmpKgraph(), { model: 'test-embed', dimensions: 4 }), { state: { userDbs: new Map(), llmRef: null } }) as ActorRef<KgraphMsg>

    const zettelDir = tmpZettel()
    tempDirs.push(zettelDir)
    const zettelRef = system.spawn('zettel', ZettelNotes(kgraphRef, zettelDir), { state: { kgraphRef, workPath: zettelDir } }) as ActorRef<ZettelNoteMsg>

    await tick()

    const source = toolJson<{ id: string }>(await invokeZettel(zettelRef, zettelCreateTool.name, {
      name: 'Source Note',
      synopsis: 'source synopsis',
      content: 'source content',
      tags: ['test'],
    }))
    const target = toolJson<{ id: string }>(await invokeZettel(zettelRef, zettelCreateTool.name, {
      name: 'Target Note',
      synopsis: 'target synopsis',
      content: 'target content',
      tags: ['test'],
    }))

    const linkReply = await invokeZettel(zettelRef, zettelLinkTool.name, {
      fromId: `${source.id},`,
      toId: target.id,
      linkType: 'part_of',
    })
    expect(linkReply.type).toBe('toolResult')

    const linksReply = await invokeZettel(zettelRef, zettelLinksTool.name, { id: source.id })
    const links = toolJson<Array<{ id: string; name: string; linkType: string }>>(linksReply)
    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: target.id, name: 'Target Note', linkType: 'part_of' }),
    ]))

    await system.shutdown()
  })

  test('returns orphans, no-outgoing, and single-outgoing notes', async () => {
    const system = await AgentSystem()
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    const kgraphRef = system.spawn('kgraph', Kgraph(tmpKgraph(), { model: 'test-embed', dimensions: 4 }), { state: { userDbs: new Map(), llmRef: null } }) as ActorRef<KgraphMsg>

    const zettelDir = tmpZettel()
    tempDirs.push(zettelDir)
    const zettelRef = system.spawn('zettel', ZettelNotes(kgraphRef, zettelDir), { state: { kgraphRef, workPath: zettelDir } }) as ActorRef<ZettelNoteMsg>

    await tick()

    await invokeZettel(zettelRef, zettelCreateTool.name, {
      name: 'Orphan Note',
      synopsis: 'synopsis',
      content: 'content',
      tags: ['test'],
    })

    const targetNote = toolJson<{ id: string }>(await invokeZettel(zettelRef, zettelCreateTool.name, {
      name: 'Target Note',
      synopsis: 'synopsis',
      content: 'content',
      tags: ['test'],
    }))

    const intermediateNote = toolJson<{ id: string }>(await invokeZettel(zettelRef, zettelCreateTool.name, {
      name: 'Intermediate Note',
      synopsis: 'synopsis',
      content: 'content',
      tags: ['test'],
    }))

    const sourceNote = toolJson<{ id: string }>(await invokeZettel(zettelRef, zettelCreateTool.name, {
      name: 'Source Note',
      synopsis: 'synopsis',
      content: 'content',
      tags: ['test'],
    }))

    await tick()

    await invokeZettel(zettelRef, zettelLinkTool.name, {
      fromId: sourceNote.id,
      toId: targetNote.id,
      linkType: 'supports',
    })

    await invokeZettel(zettelRef, zettelLinkTool.name, {
      fromId: sourceNote.id,
      toId: intermediateNote.id,
      linkType: 'supports',
    })

    await invokeZettel(zettelRef, zettelLinkTool.name, {
      fromId: intermediateNote.id,
      toId: targetNote.id,
      linkType: 'supports',
    })

    await tick()

    const reply = await invokeZettel(zettelRef, zettelUnlinkedTool.name, {})
    expect(reply.type).toBe('toolResult')
    
    const results = toolJson<Array<{
      name: string;
      links: Array<{ id: string; type: string }>;
      incomingLinks: number;
      outgoingLinks: number;
    }>>(reply)

    const names = results.map(r => r.name)
    expect(names).toContain('Orphan Note')
    expect(names).toContain('Target Note')
    expect(names).toContain('Intermediate Note')
    expect(names).toContain('Source Note')

    const orphanResult = results.find(r => r.name === 'Orphan Note')!
    expect(orphanResult.incomingLinks).toBe(0)
    expect(orphanResult.outgoingLinks).toBe(0)

    const target = results.find(r => r.name === 'Target Note')!
    expect(target.incomingLinks).toBe(2)
    expect(target.outgoingLinks).toBe(0)

    const intermediate = results.find(r => r.name === 'Intermediate Note')!
    expect(intermediate.incomingLinks).toBe(1)
    expect(intermediate.outgoingLinks).toBe(1)
    expect(intermediate.links).toEqual([
      { id: targetNote.id, type: 'supports' },
    ])

    const source = results.find(r => r.name === 'Source Note')!
    expect(source.incomingLinks).toBe(0)
    expect(source.outgoingLinks).toBe(2)
    expect(source.links).toEqual(expect.arrayContaining([
      { id: targetNote.id, type: 'supports' },
      { id: intermediateNote.id, type: 'supports' },
    ]))

    await system.shutdown()
  })

  test('does not return well-integrated notes with multiple outgoing links and incoming links', async () => {
     const system = await AgentSystem()
     const mockLlmRef = spawnMockLlm(system)
     system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })
 
     const kgraphRef = system.spawn('kgraph', Kgraph(tmpKgraph(), { model: 'test-embed', dimensions: 4 }), { state: { userDbs: new Map(), llmRef: null } }) as ActorRef<KgraphMsg>
 
     const zettelDir = tmpZettel()
     tempDirs.push(zettelDir)
     const zettelRef = system.spawn('zettel', ZettelNotes(kgraphRef, zettelDir), { state: { kgraphRef, workPath: zettelDir } }) as ActorRef<ZettelNoteMsg>
 
     await tick()
 
     const noteA = toolJson<{ id: string }>(await invokeZettel(zettelRef, zettelCreateTool.name, { name: 'Note A', synopsis: 's', content: 'c', tags: ['t'] }))
     const noteB = toolJson<{ id: string }>(await invokeZettel(zettelRef, zettelCreateTool.name, { name: 'Note B', synopsis: 's', content: 'c', tags: ['t'] }))
     const noteC = toolJson<{ id: string }>(await invokeZettel(zettelRef, zettelCreateTool.name, { name: 'Note C', synopsis: 's', content: 'c', tags: ['t'] }))
     await invokeZettel(zettelRef, zettelCreateTool.name, { name: 'Note D', synopsis: 's', content: 'c', tags: ['t'] })
 
     await tick()
 
     await invokeZettel(zettelRef, zettelLinkTool.name, { fromId: noteB.id, toId: noteA.id, linkType: 'supports' })
     await invokeZettel(zettelRef, zettelLinkTool.name, { fromId: noteC.id, toId: noteA.id, linkType: 'supports' })
     await invokeZettel(zettelRef, zettelLinkTool.name, { fromId: noteA.id, toId: noteB.id, linkType: 'supports' })
     await invokeZettel(zettelRef, zettelLinkTool.name, { fromId: noteA.id, toId: noteC.id, linkType: 'supports' })
 
     await tick()
 
     // Note A has in=2, out=2 -> SHOULD NOT BE RETURNED
     const reply = await invokeZettel(zettelRef, zettelUnlinkedTool.name, {})
     const results = toolJson<Array<{ name: string }>>(reply)
 
     expect(results.map(r => r.name)).not.toContain('Note A')
 
     await system.shutdown()
  })
})
