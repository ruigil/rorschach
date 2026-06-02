import { describe, expect, test } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { MemoryConsolidation } from '../plugins/memory/memory-consolidation.ts'
import type { KgraphMsg, LinkConsolidationCandidate, MemoryConceptLink, MemoryConsolidationMsg } from '../plugins/memory/types.ts'
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

const systemPrompt = (messages: ApiMessage[]): string => {
  const msg = messages.find(m => m.role === 'system')
  return typeof msg?.content === 'string' ? msg.content : ''
}

describe('MemoryConsolidation', () => {
  test('consolidates kgraph candidates with context and writes typed links', async () => {
    const system = await AgentSystem()
    const prompts: string[] = []
    const systemPrompts: string[] = []
    const writtenLinks: MemoryConceptLink[][] = []

    const candidates: LinkConsolidationCandidate[] = [{
      reason: 'orphan',
      target: {
        nodeId: 1,
        name: 'Brazil Lodging Preference',
        kind: 'preference',
        description: 'The user prefers apartment-style lodging for the Brazil trip.',
        topics: ['travel', 'brazil'],
        recordIds: ['rec-target'],
        links: [],
      },
      anchors: [{
        nodeId: 2,
        name: 'October 2026 Brazil Trip',
        kind: 'event',
        description: 'The user is planning a trip to Brazil in October 2026.',
        topics: ['travel', 'brazil'],
        recordIds: ['rec-anchor'],
        links: [{ type: 'ABOUT', nodeId: 3, name: 'Rui Travel Plans', confidence: 0.9 }],
      }],
    }]

    const kgraphDef: ActorDef<KgraphMsg, null> = {
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'linkCandidates') {
          msg.replyTo.send({ type: 'linkCandidatesResult', candidates })
        }
        if (msg.type === 'linkConcepts') {
          writtenLinks.push(msg.links)
          msg.replyTo.send({ type: 'conceptLinksResult', linked: msg.links.length })
        }
        return { state }
      },
    }

    const llmDef: ActorDef<LlmProviderMsg, null> = {
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'stream') {
          expect(msg.tools).toBeUndefined()
          prompts.push(userPrompt(msg.messages))
          systemPrompts.push(systemPrompt(msg.messages))
          msg.replyTo.send({
            type: 'llmChunk',
            requestId: msg.requestId,
            text: JSON.stringify({
              links: [{
                from: 'Brazil Lodging Preference',
                to: 'October 2026 Brazil Trip',
                type: 'PART_OF',
                confidence: 0.86,
              }],
            }),
          })
          msg.replyTo.send({
            type: 'llmDone',
            requestId: msg.requestId,
            usage: { promptTokens: 1, completionTokens: 1 },
          })
        }
        return { state }
      },
    }

    const kgraphRef = system.spawn('mock-kgraph', kgraphDef) as ActorRef<KgraphMsg>
    const consolidationRef = system.spawn(
      'memory-consolidation',
      MemoryConsolidation({ model: 'test-model', intervalMs: 60_000, kgraphRef }),
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
    expect(prompts[0]).toContain('Brazil Lodging Preference')
    expect(prompts[0]).toContain('October 2026 Brazil Trip')
    expect(systemPrompts[0]).toContain('poorly connected existing Concept nodes')
    expect(systemPrompts[0]).toContain('Do not link weak concepts')
    expect(systemPrompts[0]).not.toContain('store_memory')
    await waitFor(() => writtenLinks.length === 1)
    expect(writtenLinks[0]).toEqual([{
      from: 'Brazil Lodging Preference',
      to: 'October 2026 Brazil Trip',
      type: 'PART_OF',
      confidence: 0.86,
    }])

    await system.shutdown()
  })
})
