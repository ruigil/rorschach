import { describe, expect, test } from 'bun:test'
import { MockPersistenceActor } from './mock-persistence.ts'
import { AgentSystem } from '../system/index.ts'
import type { ActorDef, ActorRef } from '../system/index.ts'
import { UserPresenceTopic, OutboundUserMessageTopic } from '../types/events.ts'
import { AgentRegistrationTopic } from '../types/agents.ts'
import { SwitchAgentTopic } from '../plugins/cognitive/types.ts'
import { ToolRegistrationTopic, type ToolMsg } from '../types/tools.ts'
import { SessionManager } from '../plugins/cognitive/session-manager.ts'
import notebookPlugin from '../plugins/notebook/notebook.plugin.ts'
import { CoachAgentFactory } from '../plugins/notebook/coach-agent.ts'
import type { LlmProviderMsg, LlmTool } from '../types/llm.ts'

const tick = (ms = 50) => Bun.sleep(ms)

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

const NullLlm = (): ActorDef<LlmProviderMsg, null> => ({
  initialState: null,
  handler: (state) => ({ state }),
})

const DummyToolRef = (): ActorDef<ToolMsg, null> => ({
  initialState: null,
  handler: (state) => ({ state }),
})

const MockContextStore = (): ActorDef<any, null> => ({
  initialState: null,
  handler: (state) => ({ state }),
})

describe('coach mode integration tests', () => {
  test('dynamic mode switching to/from coach', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    const llmRef = system.spawn('null-llm', NullLlm())
    system.spawn('session-manager', SessionManager({
      llmRef,
      defaultMode: 'chatbot',
      contextWindowHours: 4,
    }))

    const userFrames: Record<string, string[]> = { u1: [] }
    system.subscribe(OutboundUserMessageTopic, (event) => {
      const e = event as { userId: string; text: string }
      userFrames[e.userId] ??= []
      userFrames[e.userId]!.push(e.text)
    })

    // Register notebook plugin (which registers the coach agent descriptor)
    const result = await system.use(notebookPlugin)
    expect(result.ok).toBe(true)
    await tick()

    // Trigger user presence
    system.publishRetained(UserPresenceTopic, 'u1-cli', { status: 'present', userId: 'u1', source: 'cli' })
    await tick()

    // Verify fallback to defaultMode 'chatbot'
    expect(parseModeFrames(userFrames.u1!).at(-1)).toMatchObject({
      mode:        'chatbot',
      displayName: 'chatbot',
    })

    // Switch to coach mode
    system.publish(SwitchAgentTopic, {
      userId:   'u1',
      mode:     'coach',
      source:   'user',
    })
    await tick()

    // Verify switched to coach mode successfully
    expect(parseModeFrames(userFrames.u1!).at(-1)).toMatchObject({
      mode:        'coach',
      displayName: 'Life Coach',
    })

    await system.shutdown()
  })

  test('access to allowed tools and prevention of unauthorized tools in coach mode', async () => {
    const system = await AgentSystem({ plugins: [MockPersistenceActor()] })
    let receivedTools: LlmTool[] | undefined = undefined

    // Spawn a mock LLM that captures tools parameter
    const mockLlm: ActorDef<LlmProviderMsg, null> = {
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'stream') {
          receivedTools = msg.tools
        }
        return { state }
      },
    }
    const llmRef = system.spawn('mock-llm', mockLlm)
    const contextStoreRef = system.spawn('mock-context-store', MockContextStore())
    const dummyToolRef = system.spawn('dummy-tool', DummyToolRef())

    const tools = {
      journal_write: {
        name: 'journal_write',
        schema: { type: 'function' as const, function: { name: 'journal_write', description: 'Write journal', parameters: {} } },
        ref: dummyToolRef,
      }
    }

    // Spawn CoachAgent directly
    const factory = CoachAgentFactory({
      model: 'test-coach-model',
      maxToolLoops: 5,
      notebookDir: 'workspace/notebook',
      tools,
    })

    const agentRef = system.spawn('coach-agent', factory.factory({
      userId: 'u1',
      llmRef,
      contextStoreRef,
    }))
    await tick()

    // Simulate global tool registrations
    system.publish(ToolRegistrationTopic, {
      name: 'web_search',
      schema: { type: 'function' as const, function: { name: 'web_search', description: 'Search the web', parameters: {} } },
      ref: dummyToolRef,
    })
    system.publish(ToolRegistrationTopic, {
      name: 'cron_create',
      schema: { type: 'function' as const, function: { name: 'cron_create', description: 'Create cron job', parameters: {} } },
      ref: dummyToolRef,
    })
    // Simulate dynamic registration of a forbidden tool (e.g. bash)
    system.publish(ToolRegistrationTopic, {
      name: 'bash',
      schema: { type: 'function' as const, function: { name: 'bash', description: 'Run bash commands', parameters: {} } },
      ref: dummyToolRef,
    })
    await tick()

    // Trigger a turn to force the agent to consult the LLM
    agentRef.send({
      type: 'userMessage',
      text: 'Hello, please check my daily exercises and search the web for a workout routine.',
    })
    await tick()

    expect(receivedTools).toBeDefined()
    const toolNames = receivedTools!.map(t => t.function.name)

    // Allowed tools must be present
    expect(toolNames).toContain('journal_write')
    expect(toolNames).toContain('web_search')
    expect(toolNames).toContain('cron_create')

    // Disallowed tools must NOT be present
    expect(toolNames).not.toContain('bash')

    await system.shutdown()
  })
})
