import { describe, expect, test } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import type { ActorDef } from '../system/types.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import { ClientPresenceTopic, InboundMessageTopic, OutboundMessageTopic } from '../types/events.ts'
import { AgentRegistrationTopic, SwitchAgentTopic, type AgentDescriptor } from '../types/agents.ts'
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

const EchoAgent = (): ActorDef<any, null> => ({
  initialState: null,
  handler: (state, msg, ctx) => {
    if (msg.type === 'userMessage') {
      ctx.publish(OutboundMessageTopic, { clientId: msg.clientId, text: 'agent-ready' })
    }
    return { state }
  },
})

const descriptor = (mode: string, displayName: string): AgentDescriptor => ({
  mode,
  displayName,
  shortDesc: `${displayName} mode`,
  factory: () => NullAgent(),
  capabilities: { userVisible: true },
})

const echoDescriptor = (mode: string, displayName: string): AgentDescriptor => ({
  mode,
  displayName,
  shortDesc: `${displayName} mode`,
  factory: () => EchoAgent(),
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

    system.publishRetained(ClientPresenceTopic, 'c1', { status: 'connected', clientId: 'c1', userId: 'u1', roles: [] })
    await tick()
    expect(parseModeFrames(clientFrames.c1!).at(-1)).toMatchObject({
      mode:        'chatbot',
      displayName: 'Chatbot',
    })

    system.publishRetained(ClientPresenceTopic, 'c2', { status: 'connected', clientId: 'c2', userId: 'u1', roles: [] })
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

  test('rebuilds active retained clients when session manager restarts before agent registration', async () => {
    const system = await AgentSystem()
    const llmRef = system.spawn('null-llm', NullLlm())
    const clientFrames: Record<string, string[]> = { c1: [] }
    system.subscribe(OutboundMessageTopic, (event) => {
      clientFrames[event.clientId] ??= []
      clientFrames[event.clientId]!.push(event.text)
    })

    system.publishRetained(ClientPresenceTopic, 'c1', {
      status:   'connected',
      clientId: 'c1',
      userId:   'u1',
      roles:    [],
    })

    system.spawn('session-manager', SessionManager({
      llmRef,
      defaultMode:        'chatbot',
      historyWindowHours: 4,
    }))
    await tick()

    system.publish(AgentRegistrationTopic, { type: 'register', descriptor: echoDescriptor('chatbot', 'Chatbot') })
    await tick()
    system.publish(InboundMessageTopic, {
      clientId:     'c1',
      text:         'hello',
      traceId:      '00000000000000000000000000000001',
      parentSpanId: '0000000000000001',
    })
    await tick()

    expect(clientFrames.c1).toContain('agent-ready')

    await system.shutdown()
  })
})
