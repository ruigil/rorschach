import { describe, expect, test } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { AgentSystem } from '../system/index.ts'
import type { ActorDef } from '../system/index.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import type { ToolMsg } from '../types/tools.ts'
import { ContextStore } from '../plugins/cognitive/context-store.ts'
import { PlannerAgentFactory } from '../plugins/workflows/planner-agent.ts'
import { ExecutorAgentFactory } from '../plugins/workflows/executor-agent.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const tempContextPath = async (): Promise<string> => {
  const path = `/tmp/rorschach-agent-context-${crypto.randomUUID()}`
  await mkdir(path, { recursive: true })
  return path
}

const CapturingLlm = (streams: Array<Extract<LlmProviderMsg, { type: 'stream' }>>): ActorDef<LlmProviderMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg.type === 'stream') streams.push(msg)
    return { state }
  },
})

const NullTool = (): ActorDef<ToolMsg, null> => ({
  initialState: null,
  handler: (state) => ({ state }),
})

describe('session agents use shared context snapshots', () => {
  test('planner builds its prompt from ContextStore context', async () => {
    const system = await AgentSystem()
    const streams: Array<Extract<LlmProviderMsg, { type: 'stream' }>> = []
    const llmRef = system.spawn('llm', CapturingLlm(streams))
    const toolRef = system.spawn('workflow-tools', NullTool())
    const contextStoreRef = system.spawn('context-store-u1', ContextStore({ userId: 'u1', contextPath: await tempContextPath() }))
    await tick()

    contextStoreRef.send({
      type: 'append',
      mode: 'chatbot',
      messages: [
        { role: 'user', content: 'We are designing shared context.' },
        { role: 'assistant', content: 'The ContextStore should be central.' },
      ],
    })
    await tick()

    const planner = system.spawn('planner', PlannerAgentFactory({
      model: 'test-model',
      plansDir: '/tmp/plans',
      maxToolLoops: 3,
      workflowToolsRef: toolRef,
    })({ userId: 'u1', clientId: 'c1', llmRef, contextStoreRef }))
    await tick()

    planner.send({ type: 'userMessage', clientId: 'c1', text: 'make a plan' })
    await tick()

    const contents = streams[0]!.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n')
    expect(contents).toContain('We are designing shared context.')
    expect(contents).toContain('The ContextStore should be central.')
    expect(contents).toContain('make a plan')

    await system.shutdown()
  })

  test('executor builds its prompt from ContextStore context', async () => {
    const system = await AgentSystem()
    const streams: Array<Extract<LlmProviderMsg, { type: 'stream' }>> = []
    const llmRef = system.spawn('llm', CapturingLlm(streams))
    const toolRef = system.spawn('workflow-tools', NullTool())
    const contextStoreRef = system.spawn('context-store-u1', ContextStore({ userId: 'u1', contextPath: await tempContextPath() }))
    await tick()

    contextStoreRef.send({
      type: 'append',
      mode: 'planner',
      messages: [
        { role: 'user', content: 'Create a refactor plan.' },
        { role: 'assistant', content: 'The plan is saved and ready to inspect.' },
      ],
    })
    await tick()

    const executor = system.spawn('executor', ExecutorAgentFactory({
      model: 'test-model',
      maxToolLoops: 3,
      tools: {},
    })({ userId: 'u1', clientId: 'c1', llmRef, contextStoreRef }))
    await tick()

    executor.send({ type: 'userMessage', clientId: 'c1', text: 'show me the plan context' })
    await tick()

    const contents = streams[0]!.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n')
    expect(contents).toContain('Create a refactor plan.')
    expect(contents).toContain('The plan is saved and ready to inspect.')
    expect(contents).toContain('show me the plan context')

    await system.shutdown()
  })
})
