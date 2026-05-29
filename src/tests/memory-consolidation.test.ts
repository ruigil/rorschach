import { describe, expect, test } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import type { ActorDef } from '../system/index.ts'
import { MemoryConsolidation } from '../plugins/memory/memory-consolidation.ts'
import type { MemoryConsolidationMsg } from '../plugins/memory/types.ts'
import { ContextSnapshotTopic, type ContextTurn } from '../types/agents.ts'
import { LlmProviderTopic, type ApiMessage, type LlmProviderMsg } from '../types/llm.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition')
    await tick(20)
  }
}

const turn = (seq: number, userText: string, assistantText: string): ContextTurn => ({
  seq,
  userId: 'u1',
  userText,
  assistantText,
  timestamp: Date.UTC(2026, 0, seq),
})

const userPrompt = (messages: ApiMessage[]): string => {
  const msg = messages.find(m => m.role === 'user')
  return typeof msg?.content === 'string' ? msg.content : ''
}

describe('MemoryConsolidation', () => {
  test('consolidates the latest full turn snapshot on every tick', async () => {
    const system = await AgentSystem()
    const prompts: string[] = []

    const llmDef: ActorDef<LlmProviderMsg, null> = {
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'stream') {
          prompts.push(userPrompt(msg.messages))
          msg.replyTo.send({ type: 'llmChunk', requestId: msg.requestId, text: 'done' })
          msg.replyTo.send({
            type: 'llmDone',
            requestId: msg.requestId,
            usage: { promptTokens: 1, completionTokens: 1 },
          })
        }
        return { state }
      },
    }

    const consolidationRef = system.spawn(
      'memory-consolidation',
      MemoryConsolidation({ model: 'test-model', intervalMs: 60_000, tools: {} }),
    )
    await tick()

    const firstTurn = turn(1, 'first user fact', 'first assistant answer')
    system.publish(ContextSnapshotTopic, {
      userId: 'u1',
      version: 1,
      recentMessages: [],
      turns: [firstTurn],
      userContext: null,
      modeSummaries: {},
      toolSummaries: [],
    })
    await tick()

    const llmRef = system.spawn('mock-llm', llmDef)
    system.publishRetained(LlmProviderTopic, 'llm', { ref: llmRef })
    await tick()

    consolidationRef.send({ type: '_consolidate' } satisfies MemoryConsolidationMsg)
    await waitFor(() => prompts.length === 1)
    expect(prompts[0]).toContain('first user fact')

    const secondTurn = turn(2, 'second user fact', 'second assistant answer')
    system.publish(ContextSnapshotTopic, {
      userId: 'u1',
      version: 2,
      recentMessages: [],
      turns: [firstTurn, secondTurn],
      userContext: null,
      modeSummaries: {},
      toolSummaries: [],
    })
    await tick()

    consolidationRef.send({ type: '_consolidate' } satisfies MemoryConsolidationMsg)
    await waitFor(() => prompts.length === 2)
    expect(prompts[1]).toContain('first user fact')
    expect(prompts[1]).toContain('second user fact')

    consolidationRef.send({ type: '_consolidate' } satisfies MemoryConsolidationMsg)
    await waitFor(() => prompts.length === 3)
    expect(prompts[2]).toContain('first user fact')
    expect(prompts[2]).toContain('second user fact')

    await system.shutdown()
  })
})
