import { describe, test, expect } from 'bun:test'
import { createPluginSystem, ask } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { createKgraphActor, KGRAPH_CREATE_NODE_TOOL_NAME } from '../plugins/memory/kgraph.ts'
import type { KgraphMsg } from '../plugins/memory/kgraph.ts'
import { LlmProviderTopic } from '../types/llm.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import type { ToolReply } from '../types/tools.ts'
import type { CreateNodeResult } from '../plugins/memory/types.ts'

// ─── Helpers ───

const tick = (ms = 100) => Bun.sleep(ms)

const tmpDb = () => `/tmp/kgraph-test-${crypto.randomUUID()}.db`

const norm = (v: number[]): number[] => {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map(x => x / mag)
}

const EMBEDDINGS: Record<string, number[]> = {
  Lisbon:  norm([1.0, 0.05, 0.0, 0.0]),
  Paris:   norm([0.0, 0.0,  1.0, 0.0]),
  Tokyo:   norm([0.0, 1.0,  0.0, 0.0]),
  Berlin:  norm([0.0, 0.0,  0.0, 1.0]),
}

const EMBEDDING_DIMS = 4
const EMBEDDING_MODEL = 'test-embed'

function spawnMockLlm(system: Awaited<ReturnType<typeof createPluginSystem>>): ActorRef<LlmProviderMsg> {
  const def: ActorDef<LlmProviderMsg, null> = {
    handler: (state, msg) => {
      if (msg.type === 'embed') {
        const vec = EMBEDDINGS[msg.text] ?? norm([1, 1, 1, 1])
        msg.replyTo.send({ type: 'embeddingResult', embedding: vec })
      }
      return { state }
    },
  }
  return system.spawn('mock-llm', def, null) as ActorRef<LlmProviderMsg>
}

function createNode(
  kgraphRef: ActorRef<KgraphMsg>,
  label: string,
  name: string,
  description?: string,
): Promise<ToolReply> {
  const args = JSON.stringify({ label, name, ...(description ? { properties: { description } } : {}) })
  return ask<KgraphMsg, ToolReply>(
    kgraphRef,
    (replyTo) => ({ type: 'invoke', toolName: KGRAPH_CREATE_NODE_TOOL_NAME, arguments: args, replyTo, userId: 'test-user' }),
    { timeoutMs: 5_000 },
  )
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe('kgraph create_node', () => {

  test('creates a node and returns { name, nodeId }', async () => {
    const system = await createPluginSystem()
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      createKgraphActor(tmpDb(), { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMS }),
      null,
    ) as ActorRef<KgraphMsg>

    await tick()

    const reply = await createNode(kgraphRef, 'Note', 'Lisbon', 'Capital of Portugal')
    expect(reply.type).toBe('toolResult')

    const result: CreateNodeResult = JSON.parse((reply as { type: 'toolResult'; result: string }).result)
    expect(result.name).toBe('Lisbon')
    expect(typeof result.nodeId).toBe('number')

    await system.shutdown()
  })

  test('two nodes with the same name produce separate records (no merging)', async () => {
    const system = await createPluginSystem()
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      createKgraphActor(tmpDb(), { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMS }),
      null,
    ) as ActorRef<KgraphMsg>

    await tick()

    const first = await createNode(kgraphRef, 'Note', 'Lisbon', 'Capital of Portugal')
    const firstResult: CreateNodeResult = JSON.parse((first as { type: 'toolResult'; result: string }).result)

    const second = await createNode(kgraphRef, 'Note', 'Lisbon', 'Lisbon, western Portugal')
    const secondResult: CreateNodeResult = JSON.parse((second as { type: 'toolResult'; result: string }).result)

    expect(secondResult.name).toBe('Lisbon')
    expect(secondResult.nodeId).not.toBe(firstResult.nodeId)

    await system.shutdown()
  })

  test('multiple distinct nodes produce separate records', async () => {
    const system = await createPluginSystem()
    const mockLlmRef = spawnMockLlm(system)
    system.publishRetained(LlmProviderTopic, 'ref', { ref: mockLlmRef })

    const kgraphRef = system.spawn(
      'kgraph',
      createKgraphActor(tmpDb(), { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMS }),
      null,
    ) as ActorRef<KgraphMsg>

    await tick()

    const names = ['Lisbon', 'Paris', 'Tokyo', 'Berlin']
    const results: CreateNodeResult[] = []

    for (const name of names) {
      const reply = await createNode(kgraphRef, 'Note', name)
      expect(reply.type).toBe('toolResult')
      const result: CreateNodeResult = JSON.parse((reply as { type: 'toolResult'; result: string }).result)
      results.push(result)
    }

    const ids = results.map(r => r.nodeId)
    expect(new Set(ids).size).toBe(names.length)

    await system.shutdown()
  })

  test('fails gracefully when no LLM provider is available', async () => {
    const system = await createPluginSystem()

    const kgraphRef = system.spawn(
      'kgraph',
      createKgraphActor(tmpDb(), { model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMS }),
      null,
    ) as ActorRef<KgraphMsg>

    await tick()

    const reply = await createNode(kgraphRef, 'Note', 'Lisbon')
    expect(reply.type).toBe('toolError')
    expect((reply as { type: 'toolError'; error: string }).error).toMatch(/embedding/)

    await system.shutdown()
  })
})
