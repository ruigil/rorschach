import { afterEach, describe, test, expect } from 'bun:test'
import { rm } from 'node:fs/promises'
import { createPluginSystem, ask } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { createKgraphActor } from '../plugins/memory/kgraph.ts'
import type { KgraphMsg } from '../plugins/memory/kgraph.ts'
import { createZettelNotesActor, ZETTEL_CREATE_TOOL, ZETTEL_LINK_TOOL, ZETTEL_UNLINKED_TOOL } from '../plugins/memory/zettel-notes.ts'
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

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('zettel-notes unlinked notes', () => {

  test('returns orphans, no-outgoing, and single-outgoing notes', async () => {
    const system = await createPluginSystem()
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    const kgraphRef = system.spawn('kgraph', createKgraphActor(tmpKgraph(), { model: 'test-embed', dimensions: 4 }), { state: { userDbs: new Map(), llmRef: null } }) as ActorRef<KgraphMsg>

    const zettelDir = tmpZettel()
    tempDirs.push(zettelDir)
    const zettelRef = system.spawn('zettel', createZettelNotesActor(kgraphRef, zettelDir), { state: { kgraphRef, dbPath: zettelDir } }) as ActorRef<ZettelNoteMsg>

    await tick()

    // 1. Orphan (No in, No out)
    await invokeZettel(zettelRef, ZETTEL_CREATE_TOOL, {
      name: 'Orphan Note',
      synopsis: 'synopsis',
      content: 'content',
      tags: ['test'],
    })

    // 2. No Outgoing (Has in, No out)
    await invokeZettel(zettelRef, ZETTEL_CREATE_TOOL, {
      name: 'Target Note',
      synopsis: 'synopsis',
      content: 'content',
      tags: ['test'],
    })

    // 3. Single Outgoing (Has in, 1 out)
    await invokeZettel(zettelRef, ZETTEL_CREATE_TOOL, {
      name: 'Intermediate Note',
      synopsis: 'synopsis',
      content: 'content',
      tags: ['test'],
    })

    // 4. Source Note (Has > 1 out, No in)
    await invokeZettel(zettelRef, ZETTEL_CREATE_TOOL, {
      name: 'Source Note',
      synopsis: 'synopsis',
      content: 'content',
      tags: ['test'],
    })

    await tick()

    // Create links
    // Source -> Target
    await invokeZettel(zettelRef, ZETTEL_LINK_TOOL, {
      sourceName: 'Source Note',
      targetName: 'Target Note',
      linkType: 'supports',
    })

    // Source -> Intermediate
    await invokeZettel(zettelRef, ZETTEL_LINK_TOOL, {
      sourceName: 'Source Note',
      targetName: 'Intermediate Note',
      linkType: 'supports',
    })

    // Intermediate -> Target
    await invokeZettel(zettelRef, ZETTEL_LINK_TOOL, {
      sourceName: 'Intermediate Note',
      targetName: 'Target Note',
      linkType: 'supports',
    })

    await tick()

    const reply = await invokeZettel(zettelRef, ZETTEL_UNLINKED_TOOL, {})
    expect(reply.type).toBe('toolResult')
    
    const results = JSON.parse((reply as { type: 'toolResult'; result: { text: string } }).result.text) as Array<{
      name: string;
      incomingLinks: number;
      outgoingLinks: number;
    }>

    const names = results.map(r => r.name)
    expect(names).toContain('Orphan Note')
    expect(names).toContain('Target Note')
    expect(names).toContain('Intermediate Note')
    expect(names).toContain('Source Note')

    const orphan = results.find(r => r.name === 'Orphan Note')!
    expect(orphan.incomingLinks).toBe(0)
    expect(orphan.outgoingLinks).toBe(0)

    const target = results.find(r => r.name === 'Target Note')!
    expect(target.incomingLinks).toBe(2)
    expect(target.outgoingLinks).toBe(0)

    const intermediate = results.find(r => r.name === 'Intermediate Note')!
    expect(intermediate.incomingLinks).toBe(1)
    expect(intermediate.outgoingLinks).toBe(1)

    const source = results.find(r => r.name === 'Source Note')!
    expect(source.incomingLinks).toBe(0)
    expect(source.outgoingLinks).toBe(2)

    await system.shutdown()
  })

  test('does not return well-integrated notes with multiple outgoing links and incoming links', async () => {
     const system = await createPluginSystem()
     const mockLlmRef = spawnMockLlm(system)
     system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })
 
     const kgraphRef = system.spawn('kgraph', createKgraphActor(tmpKgraph(), { model: 'test-embed', dimensions: 4 }), { state: { userDbs: new Map(), llmRef: null } }) as ActorRef<KgraphMsg>
 
     const zettelDir = tmpZettel()
     tempDirs.push(zettelDir)
     const zettelRef = system.spawn('zettel', createZettelNotesActor(kgraphRef, zettelDir), { state: { kgraphRef, dbPath: zettelDir } }) as ActorRef<ZettelNoteMsg>
 
     await tick()
 
     await invokeZettel(zettelRef, ZETTEL_CREATE_TOOL, { name: 'Note A', synopsis: 's', content: 'c', tags: ['t'] })
     await invokeZettel(zettelRef, ZETTEL_CREATE_TOOL, { name: 'Note B', synopsis: 's', content: 'c', tags: ['t'] })
     await invokeZettel(zettelRef, ZETTEL_CREATE_TOOL, { name: 'Note C', synopsis: 's', content: 'c', tags: ['t'] })
     await invokeZettel(zettelRef, ZETTEL_CREATE_TOOL, { name: 'Note D', synopsis: 's', content: 'c', tags: ['t'] })
 
     await tick()
 
     // Note B -> Note A
     await invokeZettel(zettelRef, ZETTEL_LINK_TOOL, { sourceName: 'Note B', targetName: 'Note A', linkType: 'supports' })
     // Note C -> Note A
     await invokeZettel(zettelRef, ZETTEL_LINK_TOOL, { sourceName: 'Note C', targetName: 'Note A', linkType: 'supports' })
     // Note A -> Note B
     await invokeZettel(zettelRef, ZETTEL_LINK_TOOL, { sourceName: 'Note A', targetName: 'Note B', linkType: 'supports' })
     // Note A -> Note C
     await invokeZettel(zettelRef, ZETTEL_LINK_TOOL, { sourceName: 'Note A', targetName: 'Note C', linkType: 'supports' })
 
     await tick()
 
     // Note A has in=2, out=2 -> SHOULD NOT BE RETURNED
     const reply = await invokeZettel(zettelRef, ZETTEL_UNLINKED_TOOL, {})
     const results = JSON.parse((reply as { type: 'toolResult'; result: { text: string } }).result.text) as Array<{ name: string }>
 
     expect(results.map(r => r.name)).not.toContain('Note A')
 
     await system.shutdown()
  })
})
