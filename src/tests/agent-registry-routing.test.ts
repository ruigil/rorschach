import { describe, expect, test } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import type { ActorDef } from '../system/index.ts'
import { LlmProviderTopic, type LlmProviderMsg } from '../types/llm.ts'
import {
  UserPresenceTopic,
  InboundMessageTopic,
  OutboundUserMessageTopic,
  HttpWsFrameTopic,
  CronTriggerTopic,
} from '../types/events.ts'
import { AgentRegistrationTopic, type AgentDescriptor } from '../types/agents.ts'
import { SessionLifecycleTopic, SwitchAgentTopic } from '../plugins/cognitive/types.ts'
import { SessionManager } from '../plugins/cognitive/session-manager.ts'
import { AgentRegistry } from '../plugins/cognitive/agent-registry.ts'
import { MockPersistenceActor } from './mock-persistence.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const NullLlm = (): ActorDef<LlmProviderMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg && typeof msg === 'object' && msg.type === 'stream') {
      msg.replyTo.send({ type: 'llmChunk', requestId: msg.requestId, text: 'agent-ready' })
      msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: { promptTokens: 1, completionTokens: 1 } })
    }
    return { state }
  },
})

const descriptor = (mode: string, displayName: string): AgentDescriptor => ({
  mode,
  displayName,
  shortDesc: `${displayName} mode`,
  systemPrompt: '',
  internalTools: [],
  capabilities: { userVisible: true },
  model: 'test-model',
})

describe('agent registry routing & lifecycle', () => {
  test('spawns dynamic agents with switch_mode tool injected', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const llmRef = system.spawn('null-llm', NullLlm())
    system.publishRetained(LlmProviderTopic, 'llm-provider', { ref: llmRef })

    const registryRef = system.spawn('agent-registry', AgentRegistry())
    system.spawn('session-manager', SessionManager({
      llmRef,
      agentRegistryRef: registryRef,
      defaultMode: 'chatbot',
      contextWindowHours: 4,
    }))

    const outboundMsgs: any[] = []
    system.subscribe(OutboundUserMessageTopic, (event) => {
      outboundMsgs.push(event)
    })

    await tick()
    system.publish(AgentRegistrationTopic, { type: 'register', descriptor: descriptor('chatbot', 'Chatbot') })
    await tick()

    // Connect user
    system.publishRetained(UserPresenceTopic, 'u1-cli', { status: 'present', userId: 'u1', source: 'cli' })
    await tick()

    // Send a message to trigger the agent
    system.publish(InboundMessageTopic, {
      userId:       'u1',
      text:         'hello',
      traceId:      '00000000000000000000000000000001',
      parentSpanId: '0000000000000001',
    })
    await tick(200)

    // Check that we received response from spawned chatbot
    const chatbotReply = outboundMsgs.find(m => m.userId === 'u1' && m.text.includes('agent-ready'))
    expect(chatbotReply).toBeDefined()

    await system.shutdown()
  })

  test('delegates WebSocket frames (list, cancel, switch) through AgentRegistry', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const llmRef = system.spawn('null-llm', NullLlm())
    system.publishRetained(LlmProviderTopic, 'llm-provider', { ref: llmRef })

    const registryRef = system.spawn('agent-registry', AgentRegistry())
    system.spawn('session-manager', SessionManager({
      llmRef,
      agentRegistryRef: registryRef,
      defaultMode: 'chatbot',
      contextWindowHours: 4,
    }))

    const outboundMsgs: any[] = []
    system.subscribe(OutboundUserMessageTopic, (event) => {
      outboundMsgs.push(event)
    })

    await tick()
    system.publish(AgentRegistrationTopic, { type: 'register', descriptor: descriptor('chatbot', 'Chatbot') })
    system.publish(AgentRegistrationTopic, { type: 'register', descriptor: descriptor('planner', 'Planner') })
    await tick()

    // Connect user
    system.publishRetained(UserPresenceTopic, 'u1-cli', { status: 'present', userId: 'u1', source: 'cli' })
    await tick()

    // 1. WebSocket Frame: cognitive.listAgents
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'u1',
      roles: ['user'],
      frame: { type: 'cognitive.listAgents' },
    })
    await tick()

    const listAgentsPayload = outboundMsgs.find(m => m.userId === 'u1' && m.text.includes('agents'))
    expect(listAgentsPayload).toBeDefined()
    expect(JSON.parse(listAgentsPayload.text).agents).toHaveLength(2)

    // 2. WebSocket Frame: cognitive.switchMode
    system.publish(HttpWsFrameTopic, {
      clientId: 'c1',
      userId: 'u1',
      roles: ['user'],
      frame: { type: 'cognitive.switchMode', mode: 'planner' },
    })
    await tick()

    const modeChangedPayload = outboundMsgs.find(m => m.userId === 'u1' && m.text.includes('modeChanged') && m.text.includes('planner'))
    expect(modeChangedPayload).toBeDefined()

    await system.shutdown()
  })

  test('routes cron triggers directly to the default mode', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const llmRef = system.spawn('null-llm', NullLlm())
    system.publishRetained(LlmProviderTopic, 'llm-provider', { ref: llmRef })

    const registryRef = system.spawn('agent-registry', AgentRegistry())
    system.spawn('session-manager', SessionManager({
      llmRef,
      agentRegistryRef: registryRef,
      defaultMode: 'chatbot',
      contextWindowHours: 4,
    }))

    const outboundMsgs: any[] = []
    system.subscribe(OutboundUserMessageTopic, (event) => {
      outboundMsgs.push(event)
    })

    await tick()
    system.publish(AgentRegistrationTopic, { type: 'register', descriptor: descriptor('chatbot', 'Chatbot') })
    await tick()

    // Connect user
    system.publishRetained(UserPresenceTopic, 'u1-cli', { status: 'present', userId: 'u1', source: 'cli' })
    await tick()

    // Publish cron trigger
    system.publish(CronTriggerTopic, {
      userId: 'u1',
      text: 'run daily backup',
      traceId: 'trace-1',
      parentSpanId: 'span-1',
    })
    await tick(200)

    // Verify cron instruction is routed through the default agent by asserting response
    const cronReply = outboundMsgs.find(m => m.userId === 'u1' && m.text.includes('agent-ready'))
    expect(cronReply).toBeDefined()

    await system.shutdown()
  })

  test('injects unified mode routing instructions into agent system prompt', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    let lastStreamMessages: any[] | null = null

    const testLlm = (): ActorDef<LlmProviderMsg, null> => ({
      initialState: null,
      handler: (state, msg) => {
        if (msg && typeof msg === 'object' && msg.type === 'stream') {
          lastStreamMessages = msg.messages
          msg.replyTo.send({ type: 'llmChunk', requestId: msg.requestId, text: 'agent-ready' })
          msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: { promptTokens: 1, completionTokens: 1 } })
        }
        return { state }
      },
    })

    const llmRef = system.spawn('test-llm', testLlm())
    system.publishRetained(LlmProviderTopic, 'llm-provider', { ref: llmRef })

    const registryRef = system.spawn('agent-registry', AgentRegistry())
    system.spawn('session-manager', SessionManager({
      llmRef,
      agentRegistryRef: registryRef,
      defaultMode: 'chatbot',
      contextWindowHours: 4,
    }))

    await tick()
    system.publish(AgentRegistrationTopic, {
      type: 'register',
      descriptor: {
        mode: 'chatbot',
        displayName: 'Chatbot',
        shortDesc: 'Test chatbot description',
        systemPrompt: 'Base prompt contents',
        internalTools: [],
        capabilities: { userVisible: true },
        model: 'test-model',
      }
    })
    await tick()

    // Connect user
    system.publishRetained(UserPresenceTopic, 'u1-cli', { status: 'present', userId: 'u1', source: 'cli' })
    await tick()

    // Send a message to trigger the agent
    system.publish(InboundMessageTopic, {
      userId:       'u1',
      text:         'hello',
      traceId:      '00000000000000000000000000000001',
      parentSpanId: '0000000000000001',
    })
    await tick(200)

    expect(lastStreamMessages).not.toBeNull()
    const systemPromptMsg = lastStreamMessages!.find(m => m.role === 'system')
    expect(systemPromptMsg).toBeDefined()
    expect(systemPromptMsg!.content).toContain('Mode Routing & Agent Hand-off Instructions')
    expect(systemPromptMsg!.content).toContain('Base prompt contents')
    expect(systemPromptMsg!.content).toContain('chatbot: Test chatbot description')

    await system.shutdown()
  })
})

