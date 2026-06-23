import { describe, expect, test, afterAll } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { AgentSystem } from '../system/index.ts'
import type { ActorDef } from '../system/index.ts'
import type { LlmProviderMsg } from '../types/llm.ts'
import { ContextStore } from '../plugins/cognitive/context-store.ts'
import { WorkflowsAgentFactory } from '../plugins/workflows/workflows-agent.ts'
import type { WorkflowRunnerMsg } from '../plugins/workflows/types.ts'

const tick = (ms = 50) => Bun.sleep(ms)

const tempDirs: string[] = []

const tempContextPath = async (): Promise<string> => {
  const path = `/tmp/rorschach-agent-context-${crypto.randomUUID()}`
  await mkdir(path, { recursive: true })
  tempDirs.push(path)
  return path
}

afterAll(async () => {
  for (const path of tempDirs) {
    try {
      await rm(path, { recursive: true, force: true })
    } catch {}
  }
})

const CapturingLlm = (streams: Array<Extract<LlmProviderMsg, { type: 'stream' }>>): ActorDef<LlmProviderMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg.type === 'stream') streams.push(msg)
    return { state }
  },
})

const NullRunner = (): ActorDef<WorkflowRunnerMsg, null> => ({
  initialState: null,
  handler: (state) => ({ state }),
})

describe('session agents use shared context snapshots', () => {
  test('workflows agent builds its prompt from ContextStore context', async () => {
    const system = await AgentSystem()
    const streams: Array<Extract<LlmProviderMsg, { type: 'stream' }>> = []
    const llmRef = system.spawn('llm', CapturingLlm(streams))
const runnerRef = system.spawn('workflow-runner', NullRunner())
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

    const workflows = system.spawn('workflows', WorkflowsAgentFactory({
      model: 'test-model',
      maxToolLoops: 3,
      workflowsDir: '/tmp/nonexistent-workflows',
      tools: {},
    })({ userId: 'u1', llmRef, contextStoreRef }))
    await tick()

    workflows.send({ type: 'userMessage', text: 'make a workflow' })
    await tick()

    const contents = streams[0]!.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n')
    expect(contents).toContain('We are designing shared context.')
    expect(contents).toContain('The ContextStore should be central.')
    expect(contents).toContain('make a workflow')

    await system.shutdown()
  })

})
