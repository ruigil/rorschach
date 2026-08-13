import { describe, expect, test } from 'bun:test'
import { AgentSystem, staticSource} from '../system/index.ts'
import type { ActorDef } from '../system/index.ts'
import { LlmProviderTopic, type LlmProviderMsg } from '../types/llm.ts'
import { UserPresenceTopic } from '../types/events.ts'
import { SessionLifecycleTopic } from '../plugins/cognitive/types.ts'
import { SessionManager } from '../plugins/cognitive/session-manager.ts'
import { MockPersistenceActor } from './mock-persistence.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const NullLlm = (): ActorDef<LlmProviderMsg, null> => ({
  initialState: null,
  handler: (state, msg, ctx) => {
    if (msg && typeof msg === 'object' && msg.type === 'stream') {
      ctx.send(msg.replyTo, { type: 'llmChunk', requestId: msg.requestId, text: 'agent-ready' })
      ctx.send(msg.replyTo, { type: 'llmDone', requestId: msg.requestId, usage: { promptTokens: 1, completionTokens: 1 } })
    }
    return { state }
  },
})

describe('Permissions Integration', () => {
  test('threads permissions on session start', async () => {
    const system = await AgentSystem({ source: staticSource({ plugins: [MockPersistenceActor()] }) })
    const llmRef = system.spawn('null-llm', NullLlm())
    system.publishRetained(LlmProviderTopic, 'llm-provider', { ref: llmRef })
    
    system.spawn('session-manager', SessionManager({
      llmRef,
      defaultMode:        'chatbot',
      contextWindowHours: 4,
    }))

    const lifecycleEvents: any[] = []
    system.subscribe(SessionLifecycleTopic, (event) => {
      lifecycleEvents.push(event)
    })

    await tick()

    const permission = { grants: ['tools_web_search', '!coding_*'] }
    system.publishRetained(UserPresenceTopic, 'user-1-http', {
      status: 'present',
      userId: 'user-1',
      source: 'http',
      permission,
    })
    await tick(100)

    const startedEvent = lifecycleEvents.find(e => e.type === 'sessionStarted' && e.userId === 'user-1')
    expect(startedEvent).toBeDefined()
    expect(startedEvent.permissionContext).toEqual(permission)

    await system.shutdown()
  })
})
