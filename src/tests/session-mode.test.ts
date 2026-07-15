import { describe, expect, test } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import type { ActorDef } from '../system/index.ts'
import { LlmProviderTopic, type LlmProviderMsg } from '../types/llm.ts'
import { UserPresenceTopic, InboundMessageTopic, OutboundUserMessageTopic } from '../types/events.ts'
import { AgentRegistrationTopic, type AgentDescriptor, type AgentFactoryOpts } from '../types/agents.ts'
import { SwitchAgentTopic, SessionLifecycleTopic } from '../plugins/cognitive/types.ts'
import { JobRegistryTopic, type ToolMsg } from '../types/tools.ts'
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

const NullTool = (): ActorDef<ToolMsg, null> => ({
  initialState: null,
  handler: (state) => ({ state }),
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

const echoDescriptor = (mode: string, displayName: string): AgentDescriptor => ({
  mode,
  displayName,
  shortDesc: `${displayName} mode`,
  systemPrompt: '',
  internalTools: [],
  capabilities: { userVisible: true },
  model: 'test-model',
})

const parseModeFrames = (frames: string[]) =>
  frames
    .map(text => {
      try {
        return JSON.parse(text) as { type: string; mode?: string; displayName?: string }
      } catch {
        return { type: '' }
      }
    })
    .filter(frame => frame.type === 'modeChanged')

describe('session manager mode UI events', () => {
  test('sends current mode on connect and broadcasts switches to user clients', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const llmRef = system.spawn('null-llm', NullLlm())
    system.publishRetained(LlmProviderTopic, 'llm-provider', { ref: llmRef })
    const registryRef = system.spawn('agent-registry', AgentRegistry())
    system.spawn('session-manager', SessionManager({
      llmRef,
      agentRegistryRef: registryRef,
      defaultMode:        'chatbot',
      contextWindowHours: 4,
    }))

    const userFrames: Record<string, string[]> = { u1: [] }
    system.subscribe(OutboundUserMessageTopic, (event) => {
      const e = event as { userId: string; text: string }
      userFrames[e.userId] ??= []
      userFrames[e.userId]!.push(e.text)
    })

    await tick()
    system.publish(AgentRegistrationTopic, { type: 'register', descriptor: descriptor('chatbot', 'Chatbot') })
    system.publish(AgentRegistrationTopic, { type: 'register', descriptor: descriptor('planner', 'Planner') })
    await tick()

    system.publishRetained(UserPresenceTopic, 'u1-cli', { status: 'present', userId: 'u1', source: 'cli' })
    await tick()
    expect(parseModeFrames(userFrames.u1!).at(-1)).toMatchObject({
      mode:        'chatbot',
      displayName: 'Chatbot',
    })

    system.publishRetained(UserPresenceTopic, 'u1-http', { status: 'present', userId: 'u1', source: 'http' })
    await tick()
    expect(parseModeFrames(userFrames.u1!).at(-1)).toMatchObject({
      mode:        'chatbot',
      displayName: 'Chatbot',
    })

    system.publish(SwitchAgentTopic, {
      userId:   'u1',
      mode:     'planner',
      source:   'user',
    })
    await tick()

    expect(parseModeFrames(userFrames.u1!).at(-1)).toMatchObject({
      mode:        'planner',
      displayName: 'Planner',
    })

    await system.shutdown()
  })

  test('rebuilds active interfaces when session manager restarts before agent registration', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const llmRef = system.spawn('null-llm', NullLlm())
    system.publishRetained(LlmProviderTopic, 'llm-provider', { ref: llmRef })
    const userFrames: Record<string, string[]> = { u1: [] }
    system.subscribe(OutboundUserMessageTopic, (event) => {
      const e = event as { userId: string; text: string }
      userFrames[e.userId] ??= []
      userFrames[e.userId]!.push(e.text)
    })

    system.publishRetained(UserPresenceTopic, 'u1-cli', {
      status:   'present',
      userId:   'u1',
      source:   'cli',
    })

    const registryRef = system.spawn('agent-registry', AgentRegistry())
    system.spawn('session-manager', SessionManager({
      llmRef,
      agentRegistryRef: registryRef,
      defaultMode:        'chatbot',
      contextWindowHours: 4,
    }))
    await tick()

    system.publish(AgentRegistrationTopic, { type: 'register', descriptor: echoDescriptor('chatbot', 'Chatbot') })
    await tick()
    system.publish(InboundMessageTopic, {
      userId:       'u1',
      text:         'hello',
      traceId:      '00000000000000000000000000000001',
      parentSpanId: '0000000000000001',
    })
    await tick(200)

    expect(userFrames.u1!.some(f => f.includes('agent-ready'))).toBe(true)

    await system.shutdown()
  })

  test('does not destroy session on disconnect if active jobs are running, and destroys it once jobs complete', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const llmRef = system.spawn('null-llm', NullLlm())
    system.publishRetained(LlmProviderTopic, 'llm-provider', { ref: llmRef })
    const toolRef = system.spawn('null-tool', NullTool())
    const registryRef = system.spawn('agent-registry', AgentRegistry())
    system.spawn('session-manager', SessionManager({
      llmRef,
      agentRegistryRef: registryRef,
      defaultMode:        'chatbot',
      contextWindowHours: 4,
    }))

    const lifecycleEvents: any[] = []
    system.subscribe(SessionLifecycleTopic, (event) => {
      lifecycleEvents.push(event)
    })

    await tick()
    system.publish(AgentRegistrationTopic, { type: 'register', descriptor: descriptor('chatbot', 'Chatbot') })
    await tick()

    // 1. Connect client u1
    system.publishRetained(UserPresenceTopic, 'u1-cli', { status: 'present', userId: 'u1', source: 'cli' })
    await tick()

    // Verify session started
    expect(lifecycleEvents.some(e => e.type === 'sessionStarted' && e.userId === 'u1')).toBe(true)

    // 2. Start a background job for user u1
    system.publishRetained(JobRegistryTopic, 'job-1', {
      jobId: 'job-1',
      status: 'running',
      toolName: 'dummy-tool',
      toolRef,
      startedAt: Date.now(),
      userId: 'u1',
    })
    await tick()

    // 3. Disconnect client u1
    system.publishRetained(UserPresenceTopic, 'u1-cli', { status: 'absent', userId: 'u1', source: 'cli' })
    await tick()

    // Verify client detached (presenceAbsent), but sessionEnded has NOT occurred
    expect(lifecycleEvents.some(e => e.type === 'presenceAbsent' && e.userId === 'u1')).toBe(true)
    expect(lifecycleEvents.some(e => e.type === 'sessionEnded' && e.userId === 'u1')).toBe(false)

    // 4. Complete/clear the job
    system.publishRetained(JobRegistryTopic, 'job-1', {
      jobId: 'job-1',
      status: 'completed',
      result: { text: 'Done' }
    })
    await tick()

    // Verify sessionEnded has now occurred
    expect(lifecycleEvents.some(e => e.type === 'sessionEnded' && e.userId === 'u1')).toBe(true)

    await system.shutdown()
  })
})
