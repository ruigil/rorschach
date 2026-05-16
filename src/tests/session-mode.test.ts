import { describe, expect, test } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import type { ActorDef } from '../system/types.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import { ClientConnectTopic, OutboundMessageTopic } from '../types/events.ts'
import { AgentRegistrationTopic, SwitchAgentTopic, type AgentDescriptor } from '../plugins/cognitive/types.ts'
import { SessionManager } from '../plugins/cognitive/session-manager.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const NullLlm = (): ActorDef<LlmProviderMsg, null> => ({
  initialState: null,
  handler: (state) => ({ state }),
})

const NullAgent = (): ActorDef<any, null> => ({
  initialState: null,
  handler: (state) => ({ state }),
})

const descriptor = (mode: string, displayName: string): AgentDescriptor => ({
  mode,
  displayName,
  shortDesc: `${displayName} mode`,
  factory: () => NullAgent(),
  capabilities: { userVisible: true },
})

const parseModeFrames = (frames: string[]) =>
  frames
    .map(text => JSON.parse(text) as { type: string; mode?: string; displayName?: string })
    .filter(frame => frame.type === 'modeChanged')

describe('session manager mode UI events', () => {
  test('sends current mode on connect and broadcasts switches to user clients', async () => {
    const system = await AgentSystem()
    const llmRef = system.spawn('null-llm', NullLlm())
    system.spawn('session-manager', SessionManager({
      llmRef,
      defaultMode:        'chatbot',
      historyWindowHours: 4,
    }))

    const clientFrames: Record<string, string[]> = { c1: [], c2: [] }
    system.subscribe(OutboundMessageTopic, (event) => {
      clientFrames[event.clientId] ??= []
      clientFrames[event.clientId]!.push(event.text)
    })

    await tick()
    system.publish(AgentRegistrationTopic, { type: 'register', descriptor: descriptor('chatbot', 'Chatbot') })
    system.publish(AgentRegistrationTopic, { type: 'register', descriptor: descriptor('planner', 'Planner') })
    await tick()

    system.publish(ClientConnectTopic, { clientId: 'c1', userId: 'u1', roles: [] })
    await tick()
    expect(parseModeFrames(clientFrames.c1!).at(-1)).toMatchObject({
      mode:        'chatbot',
      displayName: 'Chatbot',
    })

    system.publish(ClientConnectTopic, { clientId: 'c2', userId: 'u1', roles: [] })
    await tick()
    expect(parseModeFrames(clientFrames.c2!).at(-1)).toMatchObject({
      mode:        'chatbot',
      displayName: 'Chatbot',
    })

    system.publish(SwitchAgentTopic, {
      clientId: 'c1',
      mode:     'planner',
      source:   'user',
    })
    await tick()

    expect(parseModeFrames(clientFrames.c1!).at(-1)).toMatchObject({
      mode:        'planner',
      displayName: 'Planner',
    })
    expect(parseModeFrames(clientFrames.c2!).at(-1)).toMatchObject({
      mode:        'planner',
      displayName: 'Planner',
    })

    await system.shutdown()
  })
})
