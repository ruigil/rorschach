import { describe, expect, test } from 'bun:test'
import { AgentSystem, DynamicAgentActor, invokeTool } from '../system/index.ts'
import type { ActorDef } from '../system/index.ts'
import { ToolRegistrationTopic, type ToolMsg } from '../types/tools.ts'
import { LlmProviderTopic, type LlmProviderMsg, type LlmTool } from '../types/llm.ts'
import { USER_NOT_AUTHORIZED } from '../system/permissions/types.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const DummyToolRef = (): ActorDef<ToolMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg.type === 'invoke') {
      msg.replyTo.send({ type: 'toolResult', result: { text: 'dummy success' } })
    }
    return { state }
  },
})

const MockContextStore = (): ActorDef<any, null> => ({
  initialState: null,
  handler: (state) => ({ state }),
})

describe('Permission Membranes (1 & 2)', () => {
  test('Membrane 1: Filters tools in the computed LLM schema based on permissionContext', async () => {
    const system = await AgentSystem()
    let receivedTools: LlmTool[] | undefined = undefined

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

    system.publishRetained(LlmProviderTopic, 'llm-provider', { ref: llmRef })

    const descriptor = {
      mode: 'reasoning',
      displayName: 'Reasoning',
      shortDesc: 'Reasoning agent',
      role: 'reasoning',
      systemPrompt: 'Reason.',
      internalTools: [],
      capabilities: { userVisible: true },
      model: 'default',
    }

    // Spawn agent with restricted permissions: only notebook_*
    const agentRef = system.spawn('agent-membrane-1', DynamicAgentActor(descriptor, {
      userId: 'u1',
      contextStoreRef,
      permissionContext: { grants: ['notebook_*'] },
    }))
    await tick()

    // Register a permitted and a forbidden tool globally
    system.publish(ToolRegistrationTopic, {
      name: 'notebook_todos_list',
      schema: { type: 'function' as const, function: { name: 'notebook_todos_list', description: 'List todos', parameters: {} } },
      ref: dummyToolRef,
    })
    system.publish(ToolRegistrationTopic, {
      name: 'coding_shell_exec',
      schema: { type: 'function' as const, function: { name: 'coding_shell_exec', description: 'Run bash', parameters: {} } },
      ref: dummyToolRef,
    })
    await tick()

    // Trigger turn
    agentRef.send({ type: 'userMessage', text: 'show my todos' })
    await tick()

    expect(receivedTools).toBeDefined()
    const names = receivedTools!.map(t => t.function.name)
    expect(names).toContain('notebook_todos_list')
    expect(names).not.toContain('coding_shell_exec')

    await system.shutdown()
  })

  test('Membrane 2: Direct invokeTool blocks unauthorized execution', async () => {
    const system = await AgentSystem()
    const dummyToolRef = system.spawn('dummy-tool-2', DummyToolRef())

    // Create a mock ActorContext
    let denialLog: { msg: string; meta: Record<string, unknown> } | null = null
    const mockCtx: any = {
      log: {
        warn: (msg: string, meta?: any) => {
          if (msg === 'tool authorization denied' && meta?.event === 'permission_denied') {
            denialLog = { msg, meta }
          }
        }
      },
      publishRetained: () => {}
    }

    // Call invokeTool with unauthorized permission context
    const reply = await invokeTool(
      { ...mockCtx, request: { userId: 'u1', permission: { grants: ['notebook_*'] } } } as any,
      dummyToolRef,
      { toolName: 'coding_shell_exec', arguments: '{}' }
    )

    expect(reply.type).toBe('toolError')
    if (reply.type !== 'toolError') throw new Error('expected toolError')
    expect(reply.error).toBe(USER_NOT_AUTHORIZED)
    expect(denialLog).not.toBeNull()
    expect(denialLog!.meta).toEqual({
      event: 'permission_denied',
      userId: 'u1',
      toolName: 'coding_shell_exec',
      surface: 'agent_loop',
      reason: 'missing_grant',
    })

    // Call invokeTool with authorized permission context
    const allowedReply = await invokeTool(
      { ...mockCtx, request: { userId: 'u1', permission: { grants: ['notebook_*'] } } } as any,
      dummyToolRef,
      { toolName: 'notebook_todos_list', arguments: '{}' }
    )
    expect(allowedReply.type).toBe('toolResult')

    await system.shutdown()
  })
})
