import { describe, expect, test } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import type { ActorDef } from '../system/index.ts'
import { ContextSnapshotTopic, type ContextTurn } from '../types/agents.ts'
import { LlmProviderTopic, type LlmProviderMsg } from '../types/llm.ts'
import { UserContext } from '../plugins/cognitive/user-context.ts'
import { UserContextTopic, type UserContextEvent } from '../plugins/cognitive/types.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const waitFor = async (condition: () => boolean, timeoutMs = 1_000) => {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await tick(10)
  }
}

const turn = (seq: number, userText: string, assistantText: string): ContextTurn => ({
  seq,
  userId: 'u1',
  userText,
  assistantText,
  timestamp: Date.now(),
})

describe('UserContext', () => {
  test('prompts the LLM to merge new turns into the existing user context', async () => {
    const system = await AgentSystem()
    const streams: Array<Extract<LlmProviderMsg, { type: 'stream' }>> = []
    const updates: UserContextEvent[] = []

    system.subscribe(UserContextTopic, event => updates.push(event))

    const llmDef: ActorDef<LlmProviderMsg, null> = {
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'stream') {
          streams.push(msg)
          msg.replyTo.send({
            type: 'llmChunk',
            requestId: msg.requestId,
            text: 'The user plans to visit Brazil in October 2026. The user has a niece, Carolina, who is 12 years old.',
          })
          msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: null })
        }
        return { state }
      },
    }

    const userContextRef = system.spawn('user-context', UserContext({ model: 'test-model', intervalMs: 60_000 }))
    const llmRef = system.spawn('llm', llmDef)
    system.publishRetained(LlmProviderTopic, 'llm', { ref: llmRef })
    await tick()

    const existingSummary = 'The user plans to visit Brazil in October 2026.'
    const firstTurn = turn(1, 'I plan to visit Brazil in October 2026.', 'Noted.')
    const secondTurn = turn(2, 'Who in my family is 12 years old?', 'Your niece Carolina is 12 years old.')

    system.publish(ContextSnapshotTopic, {
      userId: 'u1',
      version: 1,
      recentMessages: [],
      turns: [firstTurn],
      userContext: existingSummary,
      modeSummaries: {},
      toolSummaries: [],
    })
    await tick()

    system.publish(ContextSnapshotTopic, {
      userId: 'u1',
      version: 2,
      recentMessages: [],
      turns: [firstTurn, secondTurn],
      userContext: existingSummary,
      modeSummaries: {},
      toolSummaries: [],
    })
    await tick()

    userContextRef.send({ type: '_run' })
    await waitFor(() => streams.length === 1 && updates.length === 1)

    const systemPrompt = streams[0]!.messages[0]!.content
    const updatePrompt = streams[0]!.messages[1]!.content

    expect(systemPrompt).toContain(existingSummary)
    expect(systemPrompt).toContain('Keep every still-valid fact')
    expect(systemPrompt).toContain('full merged summary')
    expect(updatePrompt).toContain('Your niece Carolina is 12 years old.')
    expect(updates[0]!.summary).toContain('Brazil')
    expect(updates[0]!.summary).toContain('Carolina')

    await system.shutdown()
  })
})
