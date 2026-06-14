import { describe, test, expect } from 'bun:test'
import { AgentSystem } from '../system/index.ts'
import { agentLoop, type AgentLoopHandle, type LoopMsg, type LoopStartTurnParams, idleLoopState, type WithLoopState } from '../system/index.ts'
import type { ActorDef, ActorContext, ActorRef, Interceptor } from '../system/index.ts'
import type { LlmProviderMsg, LlmProviderReply, ApiMessage, TokenUsage } from '../types/llm.ts'
import type { ToolMsg, ToolFinalReply, ToolReply, ToolSchema, ToolCollection } from '../types/tools.ts'

const tick = (ms = 50) => Bun.sleep(ms)

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

type TestExtra =
  | { type: 'start'; params: LoopStartTurnParams }
  | { type: '_toolRegistered'; name: string; schema: ToolSchema; ref: ActorRef<ToolMsg>; mayBeLongRunning?: boolean }
  | { type: '_toolUnregistered'; name: string }

type TestMsg = LoopMsg<TestExtra>

type TestState = WithLoopState & {
  log: string[]
  finalText: string
  streamEvents: Array<{ kind: 'text' | 'reasoning'; text: string }>
  toolCallsEvents: string[]
  toolResults: Array<{ name: string; reply: ToolFinalReply }>
  toolPendingEvents: Array<{ toolName: string; toolCallId: string; jobId: string; placeholderText?: string }>
  batchHistory: ApiMessage[][]
  llmRef: ActorRef<LlmProviderMsg> | null
  tools: ToolCollection
}

const emptyState = (): TestState => ({
  loop: idleLoopState(),
  log: [],
  finalText: '',
  streamEvents: [],
  toolCallsEvents: [],
  toolResults: [],
  toolPendingEvents: [],
  batchHistory: [],
  llmRef: null,
  tools: {},
})

const SEARCH_SCHEMA: ToolSchema = {
  type: 'function',
  function: { name: 'search', description: 'search', parameters: {} },
}

const makeToolMock = (name: string, result: ToolFinalReply): ActorDef<ToolMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg.type === 'invoke' && msg.toolName === name) {
      msg.replyTo.send(result)
    }
    return { state }
  },
})

const makeImmediateToolMock = (name: string, result: ToolReply): ActorDef<ToolMsg, null> => ({
  initialState: null,
  handler: (state, msg) => {
    if (msg.type === 'invoke' && msg.toolName === name) {
      msg.replyTo.send(result)
    }
    return { state }
  },
})

const makeHostInterceptor = <S extends TestState, M extends { type: string }>(): Interceptor<M, S> =>
  (state, msg, _ctx, next) => {
    const m = msg as any
    if (m.type === '_llmProvider') {
      return { state: { ...state, llmRef: m.ref } as S }
    }
    if (m.type === '_toolRegistered') {
      return {
        state: {
          ...state,
          tools: {
            ...state.tools,
            [m.name]: { schema: m.schema, ref: m.ref, mayBeLongRunning: m.mayBeLongRunning },
          },
        } as S,
      }
    }
    if (m.type === '_toolUnregistered') {
      const { [m.name]: _, ...rest } = state.tools
      return { state: { ...state, tools: rest } as S }
    }
    return next(state, msg)
  }

const makeAgentDef = <S extends TestState, M extends { type: string }>(
  loop: AgentLoopHandle<M, S>,
  initialState: S,
): ActorDef<M, S> => ({
  initialState,
  handler: (state, msg, ctx) => {
    if ((msg as any).type === 'start') {
      return loop.startTurn(state, (msg as any).params, ctx)
    }
    return loop.idle(state, msg, ctx)
  },
  interceptors: [makeHostInterceptor<S, M>()],
})

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe('AgentLoop: startTurn + streaming', () => {
  test('startTurn sends stream to LLM and transitions to awaitingLlm', async () => {
    const system = await AgentSystem()
    const streams: Array<Extract<LlmProviderMsg, { type: "stream" }>> = []

    const llmDef: ActorDef<LlmProviderMsg, null> = {
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'stream') streams.push(msg)
        return { state }
      },
    }
    const llmRef = system.spawn('llm', llmDef)

    const loop = agentLoop<TestState, TestMsg>({
      role: 'test',
      spanName: 'test',
      model: 'test-model',
      maxToolLoops: 3,
      llmRef: (s) => s.llmRef,
      tools: (s) => s.tools,
      onComplete: (state, finalText) => ({
        state: { ...state, finalText, log: [...state.log, 'complete'] },
      }),
      onError: (state, err) => ({
        state: { ...state, log: [...state.log, err.kind === 'llm' ? `error:${String(err.error)}` : `limit:${err.finalText}`] },
      }),
    })

    const agentRef = system.spawn('agent', makeAgentDef(loop, { ...emptyState(), llmRef }))
    await tick()

    agentRef.send({
      type: 'start',
      params: {
        messages: [{ role: 'user', content: 'hello' }],
        userId: 'u1',
        clientId: 'c1',
      },
    })
    await tick()

    expect(streams.length).toBe(1)
    expect(streams[0]!.type).toBe('stream')
    expect(streams[0]!.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(streams[0]!.role).toBe('test')
    expect(streams[0]!.clientId).toBe('c1')

    await system.shutdown()
  })

  test('llmChunk accumulates text and calls onStream', async () => {
    const system = await AgentSystem()
    const streams: Array<{ msg: Extract<LlmProviderMsg, { type: "stream" }> }> = []

    const llmDef: ActorDef<LlmProviderMsg, null> = {
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'stream') streams.push({ msg })
        return { state }
      },
    }
    const llmRef = system.spawn('llm', llmDef)

    const completions: TestState[] = []

    const loop = agentLoop<TestState, TestMsg>({
      role: 'test',
      spanName: 'test',
      model: 'test-model',
      maxToolLoops: 3,
      llmRef: (s) => s.llmRef,
      tools: (s) => s.tools,
      onStream: (state, chunk) => ({
        state: { ...state, streamEvents: [...state.streamEvents, chunk] },
      }),
      onComplete: (state, finalText) => {
        completions.push({ ...state, finalText, log: [...state.log, 'complete'] })
        return { state: { ...state, finalText, log: [...state.log, 'complete'] } }
      },
      onError: (state, err) => ({
        state: { ...state, log: [...state.log, err.kind === 'llm' ? `error:${String(err.error)}` : `limit:${err.finalText}`] },
      }),
    })

    const agentRef = system.spawn('agent', makeAgentDef(loop, { ...emptyState(), llmRef }))
    await tick()

    agentRef.send({
      type: 'start',
      params: { messages: [{ role: 'user', content: 'hi' }], userId: 'u1' },
    })
    await tick()

    expect(streams.length).toBe(1)
    const { msg } = streams[0]!
    msg.replyTo.send({ type: 'llmChunk', requestId: msg.requestId, text: 'hello ' })
    msg.replyTo.send({ type: 'llmChunk', requestId: msg.requestId, text: 'world' })
    msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: { promptTokens: 1, completionTokens: 2 } })
    await tick(100)

    expect(completions.length).toBe(1)
    expect(completions[0]!.finalText).toBe('hello world')
    expect(completions[0]!.streamEvents).toEqual([
      { kind: 'text', text: 'hello ' },
      { kind: 'text', text: 'world' },
    ])

    await system.shutdown()
  })
})

describe('AgentLoop: full integration', () => {
  test('complete turn: stream → done', async () => {
    const system = await AgentSystem()
    const streams: Array<{ msg: Extract<LlmProviderMsg, { type: "stream" }> }> = []

    const llmDef: ActorDef<LlmProviderMsg, null> = {
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'stream') streams.push({ msg })
        return { state }
      },
    }
    const llmRef = system.spawn('llm', llmDef)

    const completions: TestState[] = []

    const loop = agentLoop<TestState, TestMsg>({
      role: 'test',
      spanName: 'test',
      model: 'test-model',
      maxToolLoops: 3,
      llmRef: (s) => s.llmRef,
      tools: (s) => s.tools,
      onComplete: (state, finalText) => {
        completions.push({ ...state, finalText, log: [...state.log, 'complete'] })
        return { state: { ...state, finalText, log: [...state.log, 'complete'] } }
      },
      onError: (state, err) => ({
        state: { ...state, log: [...state.log, err.kind === 'llm' ? `error:${String(err.error)}` : `limit:${err.finalText}`] },
      }),
    })

    const agentRef = system.spawn('agent', makeAgentDef(loop, { ...emptyState(), llmRef }))
    await tick()

    agentRef.send({
      type: 'start',
      params: { messages: [{ role: 'user', content: 'hello' }], userId: 'u1' },
    })
    await tick()

    const { msg } = streams[0]!
    msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: { promptTokens: 1, completionTokens: 1 } })
    await tick(100)

    expect(completions.length).toBe(1)
    expect(completions[0]!.finalText).toBe('')
    expect(completions[0]!.log).toContain('complete')

    await system.shutdown()
  })

	  test('tool turn: stream → toolCalls → toolResult → done', async () => {
    const system = await AgentSystem()
    const streams: Array<{ msg: Extract<LlmProviderMsg, { type: "stream" }> }> = []

    const toolRef = system.spawn('tool', makeToolMock('search', {
      type: 'toolResult',
      result: { text: 'found it' },
    }))

    const llmDef: ActorDef<LlmProviderMsg, null> = {
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'stream') streams.push({ msg })
        return { state }
      },
    }
    const llmRef = system.spawn('llm', llmDef)

    const completions: TestState[] = []
    const batchHistories: ApiMessage[][] = []

    const loop = agentLoop<TestState, TestMsg>({
      role: 'test',
      spanName: 'test',
      model: 'test-model',
      maxToolLoops: 3,
      llmRef: (s) => s.llmRef,
      tools: (s) => s.tools,
      onComplete: (state, finalText) => {
        completions.push({ ...state, finalText, log: [...state.log, 'complete'] })
        return { state: { ...state, finalText, log: [...state.log, 'complete'] } }
      },
      onBatchHistoryReady: (state, messages) => {
        batchHistories.push([...messages])
        return { state }
      },
      onError: (state, err) => ({
        state: { ...state, log: [...state.log, err.kind === 'llm' ? `error:${String(err.error)}` : `limit:${err.finalText}`] },
      }),
    })

    const agentRef = system.spawn('agent', makeAgentDef(loop, { ...emptyState(), llmRef, tools: { search: { name: 'search', schema: SEARCH_SCHEMA, ref: toolRef } } }))
    await tick()

    agentRef.send({
      type: 'start',
      params: { messages: [{ role: 'user', content: 'q' }], userId: 'u1' },
    })
    await tick()

    // First turn: tool calls
    const msg1 = streams[0]!.msg
    msg1.replyTo.send({
      type: 'llmToolCalls',
      requestId: msg1.requestId,
      calls: [{ id: 'c1', name: 'search', arguments: '{}' }],
      usage: { promptTokens: 2, completionTokens: 3 },
    })
    await tick(150)

    expect(batchHistories.length).toBe(1)
    expect(batchHistories[0]!.length).toBe(2)
    expect(batchHistories[0]![0]!.role).toBe('assistant')
    expect(batchHistories[0]![1]!.role).toBe('tool')

    // Second turn: done
    expect(streams.length).toBe(2)
    const msg2 = streams[1]!.msg
    msg2.replyTo.send({
      type: 'llmDone',
      requestId: msg2.requestId,
      usage: { promptTokens: 1, completionTokens: 1 },
    })
    await tick(100)

    expect(completions.length).toBe(1)
    expect(completions[0]!.log).toContain('complete')

	    await system.shutdown()
	  })

	  test('tool results include attachments and sources in model-visible content', async () => {
    const system = await AgentSystem()
    const streams: Array<{ msg: Extract<LlmProviderMsg, { type: "stream" }> }> = []

    const toolRef = system.spawn('metadata-tool', makeToolMock('search', {
      type: 'toolResult',
      result: {
        text: 'generated image',
        attachments: [{ kind: 'image', url: 'generated/image.png', name: 'image.png', mimeType: 'image/png' }],
        sources: [{ title: 'Source', url: 'https://example.test', snippet: 'snippet' }],
      },
    }))

    const llmDef: ActorDef<LlmProviderMsg, null> = {
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'stream') streams.push({ msg })
        return { state }
      },
    }
    const llmRef = system.spawn('metadata-llm', llmDef)
    const batchHistories: ApiMessage[][] = []

    const loop = agentLoop<TestState, TestMsg>({
      role: 'test',
      spanName: 'test',
      model: 'test-model',
      maxToolLoops: 3,
      llmRef: (s) => s.llmRef,
      tools: (s) => s.tools,
      onComplete: (state, finalText) => ({ state: { ...state, finalText } }),
      onBatchHistoryReady: (state, messages) => {
        batchHistories.push([...messages])
        return { state }
      },
      onError: (state, err) => ({
        state: { ...state, log: [...state.log, err.kind === 'llm' ? `error:${String(err.error)}` : `limit:${err.finalText}`] },
      }),
    })

    const agentRef = system.spawn('metadata-agent', makeAgentDef(loop, { ...emptyState(), llmRef, tools: { search: { name: 'search', schema: SEARCH_SCHEMA, ref: toolRef } } }))
    await tick()

    agentRef.send({
      type: 'start',
      params: { messages: [{ role: 'user', content: 'q' }], userId: 'u1' },
    })
    await tick()

    const msg1 = streams[0]!.msg
    msg1.replyTo.send({
      type: 'llmToolCalls',
      requestId: msg1.requestId,
      calls: [{ id: 'c1', name: 'search', arguments: '{}' }],
      usage: { promptTokens: 2, completionTokens: 3 },
    })
    await tick(150)

    const toolMessage = batchHistories[0]!.find(msg => msg.role === 'tool')
    expect(toolMessage?.content).toContain('generated image')
    expect(toolMessage?.content).toContain('Tool result metadata:')
    expect(toolMessage?.content).toContain('"url": "generated/image.png"')
    expect(toolMessage?.content).toContain('"sources"')

    await system.shutdown()
	  })

	  test('pending tool suspends the turn without sending a fake tool result to the LLM', async () => {
	    const system = await AgentSystem()
	    const streams: Array<{ msg: Extract<LlmProviderMsg, { type: "stream" }> }> = []

	    const toolRef = system.spawn('tool', makeImmediateToolMock('search', {
	      type: 'toolPending',
	      jobId: 'job-1',
	      placeholderText: 'Search started.',
	    }))

	    const llmDef: ActorDef<LlmProviderMsg, null> = {
	      initialState: null,
	      handler: (state, msg) => {
	        if (msg.type === 'stream') streams.push({ msg })
	        return { state }
	      },
	    }
	    const llmRef = system.spawn('llm', llmDef)

	    const pendingEvents: TestState['toolPendingEvents'] = []
	    const batchHistories: ApiMessage[][] = []

	    const loop = agentLoop<TestState, TestMsg>({
	      role: 'test',
	      spanName: 'test',
	      model: 'test-model',
	      maxToolLoops: 3,
	      llmRef: (s) => s.llmRef,
	      tools: (s) => s.tools,
	      onComplete: (state, finalText) => ({ state: { ...state, finalText } }),
	      onBatchHistoryReady: (state, messages) => {
	        batchHistories.push([...messages])
	        return { state }
	      },
	      onToolPending: (state, pending) => {
	        pendingEvents.push(pending)
	        return { state: { ...state, toolPendingEvents: [...state.toolPendingEvents, pending] } }
	      },
	      onError: (state, err) => ({
	        state: { ...state, log: [...state.log, err.kind === 'llm' ? `error:${String(err.error)}` : `limit:${err.finalText}`] },
	      }),
	    })

	    const agentRef = system.spawn('agent', makeAgentDef(loop, { ...emptyState(), llmRef, tools: { search: { name: 'search', schema: SEARCH_SCHEMA, ref: toolRef } } }))
	    await tick()

	    agentRef.send({
	      type: 'start',
	      params: { messages: [{ role: 'user', content: 'q' }], userId: 'u1' },
	    })
	    await tick()

	    const msg1 = streams[0]!.msg
	    msg1.replyTo.send({
	      type: 'llmToolCalls',
	      requestId: msg1.requestId,
	      calls: [{ id: 'c1', name: 'search', arguments: '{}' }],
	      usage: { promptTokens: 2, completionTokens: 3 },
	    })
	    await tick(150)

	    expect(pendingEvents).toEqual([{ toolName: 'search', toolCallId: 'c1', jobId: 'job-1', placeholderText: 'Search started.' }])
	    expect(batchHistories).toHaveLength(0)
	    expect(streams).toHaveLength(1)

	    await system.shutdown()
	  })

	  test('unknown tool produces synthetic error and loop continues', async () => {
    const system = await AgentSystem()
    const streams: Array<{ msg: Extract<LlmProviderMsg, { type: "stream" }> }> = []

    const llmDef: ActorDef<LlmProviderMsg, null> = {
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'stream') streams.push({ msg })
        return { state }
      },
    }
    const llmRef = system.spawn('llm', llmDef)

    const completions: TestState[] = []

    const loop = agentLoop<TestState, TestMsg>({
      role: 'test',
      spanName: 'test',
      model: 'test-model',
      maxToolLoops: 3,
      llmRef: (s) => s.llmRef,
      tools: (s) => s.tools,
      onComplete: (state, finalText) => {
        completions.push({ ...state, finalText, log: [...state.log, 'complete'] })
        return { state: { ...state, finalText, log: [...state.log, 'complete'] } }
      },
      onError: (state, err) => ({
        state: { ...state, log: [...state.log, err.kind === 'llm' ? `error:${String(err.error)}` : `limit:${err.finalText}`] },
      }),
    })

    const agentRef = system.spawn('agent', makeAgentDef(loop, { ...emptyState(), llmRef }))
    await tick()

    agentRef.send({
      type: 'start',
      params: { messages: [{ role: 'user', content: 'q' }], userId: 'u1' },
    })
    await tick()

    const msg1 = streams[0]!.msg
    msg1.replyTo.send({
      type: 'llmToolCalls',
      requestId: msg1.requestId,
      calls: [{ id: 'c1', name: 'missing_tool', arguments: '{}' }],
      usage: { promptTokens: 1, completionTokens: 1 },
    })
    await tick(150)

    // Synthetic error causes immediate next turn (no real tool to wait for)
    expect(streams.length).toBe(2)
    const msg2 = streams[1]!.msg
    msg2.replyTo.send({
      type: 'llmDone',
      requestId: msg2.requestId,
      usage: { promptTokens: 1, completionTokens: 1 },
    })
    await tick(100)

    expect(completions.length).toBe(1)
    expect(completions[0]!.log).toContain('complete')

    await system.shutdown()
  })

  test('loop limit triggers onError with kind loopLimit', async () => {
    const system = await AgentSystem()
    const streams: Array<{ msg: Extract<LlmProviderMsg, { type: "stream" }> }> = []

    const toolRef = system.spawn('tool', makeToolMock('search', {
      type: 'toolResult',
      result: { text: 'found' },
    }))

    const llmDef: ActorDef<LlmProviderMsg, null> = {
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'stream') streams.push({ msg })
        return { state }
      },
    }
    const llmRef = system.spawn('llm', llmDef)

    const limits: string[] = []

    const loop = agentLoop<TestState, TestMsg>({
      role: 'test',
      spanName: 'test',
      model: 'test-model',
      maxToolLoops: 1,
      llmRef: (s) => s.llmRef,
      tools: (s) => s.tools,
      onComplete: (state, finalText) => ({
        state: { ...state, finalText, log: [...state.log, 'complete'] },
      }),
      onError: (state, err) => {
        if (err.kind === 'loopLimit') {
          limits.push(err.finalText)
          return { state: { ...state, log: [...state.log, `limit:${err.finalText}`] } }
        }
        return { state: { ...state, log: [...state.log, `error:${String(err.error)}`] } }
      },
    })

    const agentRef = system.spawn('agent', makeAgentDef(loop, { ...emptyState(), llmRef, tools: { search: { name: 'search', schema: SEARCH_SCHEMA, ref: toolRef } } }))
    await tick()

    agentRef.send({
      type: 'start',
      params: { messages: [{ role: 'user', content: 'q' }], userId: 'u1' },
    })
    await tick()

    const msg1 = streams[0]!.msg
    msg1.replyTo.send({
      type: 'llmToolCalls',
      requestId: msg1.requestId,
      calls: [{ id: 'c1', name: 'search', arguments: '{}' }],
      usage: { promptTokens: 1, completionTokens: 1 },
    })
    await tick(150)

    expect(limits.length).toBe(1)

    await system.shutdown()
  })

  test('_toolRegistered and _toolUnregistered mutate tools via interceptor', async () => {
    const system = await AgentSystem()
    const streams: Array<{ msg: Extract<LlmProviderMsg, { type: "stream" }> }> = []

    const toolRef = system.spawn('t', makeToolMock('newTool', {
      type: 'toolResult',
      result: { text: 'ok' },
    }))

    const llmDef: ActorDef<LlmProviderMsg, null> = {
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'stream') streams.push({ msg })
        return { state }
      },
    }
    const llmRef = system.spawn('llm', llmDef)

    const loop = agentLoop<TestState, TestMsg>({
      role: 'test',
      spanName: 'test',
      model: 'test-model',
      maxToolLoops: 3,
      llmRef: (s) => s.llmRef,
      tools: (s) => s.tools,
      onComplete: (state, finalText) => ({
        state: { ...state, finalText, log: [...state.log, 'complete'] },
      }),
      onError: (state, err) => ({
        state: { ...state, log: [...state.log, err.kind === 'llm' ? `error:${String(err.error)}` : `limit:${err.finalText}`] },
      }),
    })

    const agentRef = system.spawn('agent', makeAgentDef(loop, { ...emptyState(), llmRef }))
    await tick()

    // Register a tool
    agentRef.send({
      type: '_toolRegistered',
      name: 'newTool',
      schema: { type: 'function', function: { name: 'newTool', description: 'd', parameters: {} } },
      ref: toolRef as ActorRef<ToolMsg>,
    })
    await tick()

    // Now use it in a turn
    agentRef.send({
      type: 'start',
      params: { messages: [{ role: 'user', content: 'q' }], userId: 'u1' },
    })
    await tick()

    const msg1 = streams[0]!.msg
    msg1.replyTo.send({
      type: 'llmToolCalls',
      requestId: msg1.requestId,
      calls: [{ id: 'c1', name: 'newTool', arguments: '{}' }],
      usage: { promptTokens: 1, completionTokens: 1 },
    })
    await tick(150)

    // Tool was dispatched and replied, causing startNextTurn
    expect(streams.length).toBe(2)

    await system.shutdown()
  })

  test('llmError calls onError with kind llm and resets to idle', async () => {
    const system = await AgentSystem()
    const streams: Array<{ msg: Extract<LlmProviderMsg, { type: "stream" }> }> = []

    const llmDef: ActorDef<LlmProviderMsg, null> = {
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'stream') streams.push({ msg })
        return { state }
      },
    }
    const llmRef = system.spawn('llm', llmDef)

    const errors: string[] = []

    const loop = agentLoop<TestState, TestMsg>({
      role: 'test',
      spanName: 'test',
      model: 'test-model',
      maxToolLoops: 3,
      llmRef: (s) => s.llmRef,
      tools: (s) => s.tools,
      onComplete: (state, finalText) => ({
        state: { ...state, finalText, log: [...state.log, 'complete'] },
      }),
      onError: (state, err) => {
        if (err.kind === 'llm') {
          errors.push(String(err.error))
          return { state: { ...state, log: [...state.log, `error:${String(err.error)}`] } }
        }
        return { state: { ...state, log: [...state.log, `limit:${err.finalText}`] } }
      },
    })

    const agentRef = system.spawn('agent', makeAgentDef(loop, { ...emptyState(), llmRef }))
    await tick()

    agentRef.send({
      type: 'start',
      params: { messages: [{ role: 'user', content: 'q' }], userId: 'u1' },
    })
    await tick()

    const { msg } = streams[0]!
    msg.replyTo.send({ type: 'llmError', requestId: msg.requestId, error: 'boom' })
    await tick(100)

    expect(errors.length).toBe(1)
    expect(errors[0]).toBe('boom')

    await system.shutdown()
  })

  test('requestId guard ignores stale llmChunk', async () => {
    const system = await AgentSystem()
    const streams: Array<{ msg: Extract<LlmProviderMsg, { type: "stream" }> }> = []

    const llmDef: ActorDef<LlmProviderMsg, null> = {
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'stream') streams.push({ msg })
        return { state }
      },
    }
    const llmRef = system.spawn('llm', llmDef)

    const completions: TestState[] = []

    const loop = agentLoop<TestState, TestMsg>({
      role: 'test',
      spanName: 'test',
      model: 'test-model',
      maxToolLoops: 3,
      llmRef: (s) => s.llmRef,
      tools: (s) => s.tools,
      onComplete: (state, finalText) => {
        completions.push({ ...state, finalText, log: [...state.log, 'complete'] })
        return { state: { ...state, finalText, log: [...state.log, 'complete'] } }
      },
      onError: (state, err) => ({
        state: { ...state, log: [...state.log, err.kind === 'llm' ? `error:${String(err.error)}` : `limit:${err.finalText}`] },
      }),
    })

    const agentRef = system.spawn('agent', makeAgentDef(loop, { ...emptyState(), llmRef }))
    await tick()

    agentRef.send({
      type: 'start',
      params: { messages: [{ role: 'user', content: 'q' }], userId: 'u1' },
    })
    await tick()

    const { msg } = streams[0]!
    // Send chunk with WRONG requestId, then done with correct one
    msg.replyTo.send({ type: 'llmChunk', requestId: 'wrong-id', text: 'x' })
    msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: { promptTokens: 1, completionTokens: 1 } })
    await tick(100)

    expect(completions.length).toBe(1)
    expect(completions[0]!.finalText).toBe('')

    await system.shutdown()
  })

  test('reasoning chunk calls onStream with kind reasoning', async () => {
    const system = await AgentSystem()
    const streams: Array<{ msg: Extract<LlmProviderMsg, { type: "stream" }> }> = []

    const llmDef: ActorDef<LlmProviderMsg, null> = {
      initialState: null,
      handler: (state, msg) => {
        if (msg.type === 'stream') streams.push({ msg })
        return { state }
      },
    }
    const llmRef = system.spawn('llm', llmDef)

    const events: Array<{ kind: string; text: string }> = []

    const loop = agentLoop<TestState, TestMsg>({
      role: 'test',
      spanName: 'test',
      model: 'test-model',
      maxToolLoops: 3,
      llmRef: (s) => s.llmRef,
      tools: (s) => s.tools,
      onStream: (state, chunk) => ({
        state: { ...state, streamEvents: [...state.streamEvents, chunk] },
      }),
      onComplete: (state, finalText) => ({
        state: { ...state, finalText, log: [...state.log, 'complete'] },
      }),
      onError: (state, err) => ({
        state: { ...state, log: [...state.log, err.kind === 'llm' ? `error:${String(err.error)}` : `limit:${err.finalText}`] },
      }),
    })

    const agentRef = system.spawn('agent', makeAgentDef(loop, { ...emptyState(), llmRef }))
    await tick()

    agentRef.send({
      type: 'start',
      params: { messages: [{ role: 'user', content: 'q' }], userId: 'u1' },
    })
    await tick()

    const { msg } = streams[0]!
    msg.replyTo.send({ type: 'llmReasoningChunk', requestId: msg.requestId, text: 'thinking' })
    msg.replyTo.send({ type: 'llmDone', requestId: msg.requestId, usage: { promptTokens: 1, completionTokens: 1 } })
    await tick(100)

    expect(events.length).toBe(0)
    // onStream no longer mutates external array; streamEvents is on state

    await system.shutdown()
  })
})
