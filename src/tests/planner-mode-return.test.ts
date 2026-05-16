import { describe, expect, test } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import type { ActorDef } from '../system/types.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import { HistoryStore } from '../plugins/cognitive/history-store.ts'
import { PlannerAgentFactory } from '../plugins/cognitive/planner-agent.ts'
import { SwitchAgentTopic, type SwitchAgentEvent } from '../plugins/cognitive/types.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const FormalizingLlm = (): ActorDef<LlmProviderMsg, { calls: number }> => ({
  initialState: { calls: 0 },
  handler: (state, msg) => {
    if (msg.type !== 'stream') return { state }

    if (state.calls === 0) {
      msg.replyTo.send({
        type:      'llmToolCalls',
        requestId: msg.requestId,
        calls:     [{
          id:        'formalize-1',
          name:      'formalize_plan',
          arguments: JSON.stringify({
            goal:    'surface mode in web UI',
            summary: 'Plan accepted.',
            tasks:   [],
          }),
        }],
        usage: null,
      })
      return { state: { calls: 1 } }
    }

    msg.replyTo.send({ type: 'llmChunk', requestId: msg.requestId, text: 'Saved.' })
    msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: null })
    return { state: { calls: state.calls + 1 } }
  },
})

describe('planner mode return', () => {
  test('switches back to chatbot after formalize_plan succeeds', async () => {
    const system = await AgentSystem()
    const switches: SwitchAgentEvent[] = []
    system.subscribe(SwitchAgentTopic, event => switches.push(event))

    const llmRef = system.spawn('formalizing-llm', FormalizingLlm())
    const historyStoreRef = system.spawn('history-store-u1', HistoryStore({ userId: 'u1' }))
    const planner = system.spawn('planner-u1', PlannerAgentFactory({
      model:        'test-planner',
      plansDir:     `/tmp/rorschach-plans-${crypto.randomUUID()}`,
      maxToolLoops: 3,
    })({
      userId: 'u1',
      clientId: 'c1',
      llmRef,
      historyStoreRef,
    }))

    planner.send({ type: 'userMessage', clientId: 'c1', text: 'make a plan' })

    for (let i = 0; i < 20 && switches.length === 0; i++) {
      await tick()
    }

    expect(switches.at(-1)).toMatchObject({
      clientId: 'c1',
      mode:     'chatbot',
      source:   'programmatic',
      reason:   'plannerFormalizedPlan',
    })

    await system.shutdown()
  })
})
