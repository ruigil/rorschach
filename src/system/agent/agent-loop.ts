import type {
  ActorRef,
  ActorResult,
  ActorContext,
  MessageHandler,
  SpanHandle,
  EventTopic,
  Interceptor,
} from '../actor/types.ts'
import { invokeTool } from './tool-utils.ts'
import type {
	ToolCollection,
	ToolFinalReply,
	ToolMsg,
	ToolReply,
	ToolFilter,
	ToolResultPayload,
} from '../../types/tools.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  TokenUsage,
  LlmTool,
  ToolCall,
} from '../../types/llm.ts'

// ─── Shared turn-slice shapes ───────────────────────────────────────────────

export type LoopPendingBatch = {
  pending: Set<string>
  results: Map<string, { toolCallId: string; toolName: string; content: string }>
  spans: Map<string, SpanHandle>
  calls: Array<{ id: string; name: string; arguments: string }>
}

export type LoopTurn = {
  requestId: string | null
  turnMessages: ApiMessage[] | null
  pending: string
  pendingBatch: LoopPendingBatch | null
  toolLoopCount: number
  requestSpan: SpanHandle | null
  llmSpan: SpanHandle | null
  userId: string
  /** Aggregated usage across this turn (chunks + done + toolCalls). Reset on materialize. */
  pendingUsage: TokenUsage
}

const initialLoopTurn = (): LoopTurn => ({
  requestId: null,
  turnMessages: null,
  pending: '',
  pendingBatch: null,
  toolLoopCount: 0,
  requestSpan: null,
  llmSpan: null,
  userId: '',
  pendingUsage: { promptTokens: 0, completionTokens: 0 },
})

const formatToolResultContent = (result: ToolResultPayload): string => {
  if (!result.attachments?.length && !result.sources?.length) return result.text
  return [
    result.text,
    'Tool result metadata:',
    JSON.stringify({
      ...(result.attachments?.length ? { attachments: result.attachments } : {}),
      ...(result.sources?.length ? { sources: result.sources } : {}),
    }, null, 2),
  ].join('\n')
}

// ─── Explicit loop state ────────────────────────────────────────────────────

export type LoopState = {
  phase: 'idle' | 'awaitingLlm' | 'toolLoop'
  turn: LoopTurn
}

export const idleLoopState = (): LoopState => ({
  phase: 'idle',
  turn: initialLoopTurn(),
})

export type WithLoopState = { loop: LoopState }

// ─── Base message variants the closure dispatches on ───────────────────────

export type LoopStartTurnParams = {
  messages: ApiMessage[]
  userId: string
  requestSpan?: SpanHandle | null
}

export type LoopToolResultMsg = {
  type: '_toolResult'
  toolName: string
  toolCallId: string
  reply: ToolReply
}

export type LoopBaseMsg = LlmProviderReply | LoopToolResultMsg

export type LoopMsg<Extra extends { type: string } = never> = LoopBaseMsg | Extra

// ─── Error type ─────────────────────────────────────────────────────────────

export type LoopError =
  | { kind: 'llm'; error: unknown }
  | { kind: 'loopLimit'; limit: number; finalText: string }

// ─── Stream chunk ───────────────────────────────────────────────────────────

export type StreamChunk =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }

// ─── Hook surface ───────────────────────────────────────────────────────────

export type AgentLoopHooks<S extends WithLoopState, M> = {
  role: string
  spanName: string
  logPrefix?: string

  tools: ToolCollection | ((s: S) => ToolCollection)
  model: string
  maxToolLoops: number

  llmRef: (s: S) => ActorRef<LlmProviderMsg> | null

  // When set, engine auto-emits standard UI payloads to this topic
  uiEvents?: EventTopic<{ userId: string; text: string }>

  // Static overrides for auto-emitted error text
  errorMessages?: { llm?: string; loopLimit?: string }

  onComplete: (s: S, finalText: string, usage: TokenUsage, ctx: ActorContext<M>) => { state: S }
  onError: (s: S, err: LoopError, ctx: ActorContext<M>) => { state: S }

  onStream?: (s: S, chunk: StreamChunk, ctx: ActorContext<M>) => { state: S }

	  onToolResult?: (
	    s: S,
	    result: { toolName: string; toolCallId: string; reply: ToolFinalReply },
	    ctx: ActorContext<M>,
	  ) => { state: S }

	  onToolPending?: (
	    s: S,
	    result: { toolName: string; toolCallId: string; jobId: string; placeholderText?: string },
	    ctx: ActorContext<M>,
	  ) => { state: S }

	  toolInvocation?: {
	    jobMetadata?: (call: { id: string; name: string; arguments: string }, turn: LoopTurn) => Record<string, unknown>
	  }

  onBatchHistoryReady?: (
    s: S,
    messages: ApiMessage[],
    ctx: ActorContext<M>,
  ) => { state: S }
}

// ─── Exported handle ────────────────────────────────────────────────────────

export type AgentLoopHandle<M , S extends WithLoopState> = {
  idle: MessageHandler<M, S>
  startTurn: (state: S, params: LoopStartTurnParams, ctx: ActorContext<M>) => ActorResult<M, S>
}

// ─── Internal engine ────────────────────────────────────────────────────────

const createLoopEngine = <S extends WithLoopState, M >(hooks: AgentLoopHooks<S, M>) => {
  const log = hooks.logPrefix ?? hooks.spanName
  const { tools: toolsCfg, model, maxToolLoops } = hooks

  const resolveTools = (s: S): ToolCollection =>
    typeof toolsCfg === 'function' ? toolsCfg(s) : toolsCfg

  const resolveSchemas = (s: S): LlmTool[] =>
    Object.values(resolveTools(s)).map((e) => e.schema as LlmTool)

  const addUsage = (a: TokenUsage, b: TokenUsage | null | undefined): TokenUsage =>
    b ? { 
      promptTokens: a.promptTokens + b.promptTokens, 
      completionTokens: a.completionTokens + b.completionTokens }
    : a

  const materialize = (state: S): ActorResult<M, S> => ({
    state: { ...state, loop: idleLoopState() } as S,
    become: idle,
    unstashAll: true,
  })

  const emitUi = (userId: string, payload: unknown, ctx: ActorContext<M>) => {
    if (hooks.uiEvents && userId) {
      ctx.publish(hooks.uiEvents, { userId, text: JSON.stringify(payload) })
    }
  }

  // ── Helper: send `stream` to LLM and return the new llmSpan ──────────────
  const sendStream = (
    state: S,
    requestId: string,
    messages: ApiMessage[],
    requestSpan: SpanHandle | null,
    ctx: ActorContext<M>,
  ): SpanHandle | null => {
    const llmSpan = requestSpan ? ctx.trace.child(requestSpan.traceId, requestSpan.spanId, 'llm-call', { model }) : null
    const schemas = resolveSchemas(state)
    const llmRef = hooks.llmRef(state)
    if (!llmRef) throw new Error(`${log}: llmRef is null`)
    llmRef.send({
      type: 'stream',
      requestId,
      model,
      messages,
      tools: schemas.length > 0 ? schemas : undefined,
      role: hooks.role,
      replyTo: ctx.self as unknown as ActorRef<LlmProviderReply>,
    })
    return llmSpan
  }

  // ── startTurn: in-process entry, shared by all agents ────────────────────
  const startTurn = (state: S, params: LoopStartTurnParams, ctx: ActorContext<M>): ActorResult<M, S> => {
    const llmRef = hooks.llmRef(state)
    if (!llmRef) {
      ctx.log.warn(`${log}: not ready (no LLM provider)`)
      return { state }
    }

    emitUi(params.userId, { type: 'start' }, ctx)

    let requestSpan: SpanHandle | null = params.requestSpan ?? null
    if (!requestSpan) {
      const parent = ctx.trace.fromHeaders()
      if (parent) {
        requestSpan = ctx.trace.child(parent.traceId, parent.spanId, hooks.spanName, {})
      }
    }

    const requestId = crypto.randomUUID()
    const turn: LoopTurn = {
      ...initialLoopTurn(),
      requestId,
      turnMessages: params.messages,
      requestSpan,
      userId: params.userId,
    }
    const llmSpan = sendStream(state, requestId, params.messages, requestSpan, ctx)

    return {
      state: { ...state, loop: { phase: 'awaitingLlm', turn: { ...turn, llmSpan } } } as S,
      become: awaitingLlm,
    }
  }

  // ── Idle handler ─────────────────────────────────────────────────────────
  const idle: MessageHandler<M, S> = (_state, _msg, _ctx) => {
    return { state: _state }
  }

  // ── Awaiting LLM handler ─────────────────────────────────────────────────
  const awaitingLlm: MessageHandler<M, S> = (state, msg, ctx) => {
    const m = msg as LoopBaseMsg | { type: string }
    const turn = state.loop.turn

    switch (m.type) {
      case 'llmChunk': {
        const chunk = m as Extract<LlmProviderReply, { type: 'llmChunk' }>
        if (chunk.requestId !== turn.requestId) return { state }
        const nextTurn: LoopTurn = { ...turn, pending: turn.pending + chunk.text }
        let nextState = { ...state, loop: { ...state.loop, turn: nextTurn } } as S
        if (hooks.onStream) {
          const r = hooks.onStream(nextState, { kind: 'text', text: chunk.text }, ctx)
          nextState = r.state
        }
        emitUi(turn.userId, { type: 'chunk', text: chunk.text }, ctx)
        return { state: nextState }
      }

      case 'llmReasoningChunk': {
        const chunk = m as Extract<LlmProviderReply, { type: 'llmReasoningChunk' }>
        if (chunk.requestId !== turn.requestId) return { state }
        if (!hooks.onStream) {
          emitUi(turn.userId, { type: 'reasoningChunk', text: chunk.text }, ctx)
          return { state }
        }
        const r = hooks.onStream(state, { kind: 'reasoning', text: chunk.text }, ctx)
        emitUi(turn.userId, { type: 'reasoningChunk', text: chunk.text }, ctx)
        return { state: r.state }
      }

      case 'llmToolCalls': {
        const tc = m as Extract<LlmProviderReply, { type: 'llmToolCalls' }>
        if (tc.requestId !== turn.requestId) return { state }

        turn.llmSpan?.done({ toolCalls: tc.calls.map(c => c.name) })
        ctx.log.info(`${log}: tool calls`, { tools: tc.calls.map(c => c.name) })

        const accumulatedUsage = addUsage(turn.pendingUsage, tc.usage)
        emitUi(turn.userId, { type: 'tooling', tools: tc.calls.map(c => c.name) }, ctx)

        const tools = resolveTools(state)
        const knownCalls: typeof tc.calls = []
        const skippedUnknownCalls: typeof tc.calls = []
        for (const call of tc.calls) {
          if (tools[call.name]) {
            knownCalls.push(call)
            continue
          }
          ctx.log.warn(`${log}: unknown tool (skipped)`, { tool: call.name })
          skippedUnknownCalls.push(call)
        }

        const spans = new Map<string, SpanHandle>()
        for (const call of knownCalls) {
          if (turn.requestSpan) {
            spans.set(call.id, ctx.trace.child(
              turn.requestSpan.traceId,
              turn.requestSpan.spanId,
              'tool-invoke',
              { toolName: call.name, arguments: call.arguments },
            ))
          }
        }

        const batch: LoopPendingBatch = {
          pending: new Set([...knownCalls.map(c => c.id), ...skippedUnknownCalls.map(c => c.id)]),
          results: new Map(),
          spans,
          calls: tc.calls,
        }

        const userId = turn.userId

        for (const call of knownCalls) {
          const entry = tools[call.name]!
          const toolSpan = spans.get(call.id)
	          ctx.pipeToSelf(
	            invokeTool(ctx, entry.ref,
	              { toolName: call.name, arguments: call.arguments, userId },
	              {
	                headers: toolSpan ? ctx.trace.injectHeaders(toolSpan) : undefined,
	                jobMetadata: hooks.toolInvocation?.jobMetadata?.(call, turn),
	              },
	            ),
            (reply) => ({
              type: '_toolResult',
              toolName: call.name,
              toolCallId: call.id,
              reply,
            } as unknown as M),
            (error) => ({
              type: '_toolResult',
              toolName: call.name,
              toolCallId: call.id,
              reply: { type: 'toolError', error: String(error) },
            } as unknown as M),
          )
        }

        for (const call of skippedUnknownCalls) {
          const synthetic: M = {
            type: '_toolResult',
            toolName: call.name,
            toolCallId: call.id,
            reply: { type: 'toolError', error: `Tool not available: ${call.name}` },
          } as unknown as M
          ctx.self.send(synthetic)
        }

        const nextState = {
          ...state,
          loop: {
            phase: 'toolLoop' as const,
            turn: { ...turn, requestId: null, llmSpan: null, pendingBatch: batch, pendingUsage: accumulatedUsage },
          },
        } as S

        return { state: nextState, become: toolLoop }
      }

      case 'llmDone': {
        const done = m as Extract<LlmProviderReply, { type: 'llmDone' }>
        if (done.requestId !== turn.requestId) return { state }
        turn.llmSpan?.done()
        turn.requestSpan?.done()
        ctx.log.info(`${log}: done`, { chars: turn.pending.length })
        const usage = addUsage(turn.pendingUsage, done.usage)
        const nextState = { ...state, loop: { ...state.loop, turn: { ...turn, pendingUsage: usage } } } as S
        const r = hooks.onComplete(nextState, turn.pending, usage, ctx)
        emitUi(turn.userId, { type: 'done' }, ctx)
        return materialize(r.state)
      }

      case 'llmError': {
        const err = m as Extract<LlmProviderReply, { type: 'llmError' }>
        if (err.requestId !== turn.requestId) return { state }
        turn.llmSpan?.error(err.error)
        turn.requestSpan?.error(err.error)
        ctx.log.error(`${log}: LLM error`, { error: String(err.error) })
        const r = hooks.onError(state, { kind: 'llm', error: err.error }, ctx)
        emitUi(turn.userId, { type: 'error', text: hooks.errorMessages?.llm ?? 'Something went wrong. Please try again.' }, ctx)
        return materialize(r.state)
      }

      default:
        return { state }
    }
  }

  // ── Tool loop handler ────────────────────────────────────────────────────
  const toolLoop: MessageHandler<M, S> = (state, msg, ctx) => {
    const m = msg as LoopBaseMsg | { type: string }
    const turn = state.loop.turn

    switch (m.type) {
      case '_toolResult': {
	        const msg = m as LoopToolResultMsg
	        const batch = turn.pendingBatch!
	        const span = batch.spans.get(msg.toolCallId)
	        if (msg.reply.type === 'toolPending') {
	          const pendingText = msg.reply.placeholderText ?? `Background job started for ${msg.toolName} (jobId=${msg.reply.jobId}).`
	          span?.done({ jobId: msg.reply.jobId, pending: true })
	          turn.requestSpan?.done({ pendingJobId: msg.reply.jobId, toolName: msg.toolName })
	          ctx.log.info(`${log}: tool pending`, { tool: msg.toolName, jobId: msg.reply.jobId })
	          emitUi(turn.userId, { type: 'chunk', text: pendingText }, ctx)
	          emitUi(turn.userId, { type: 'done' }, ctx)
	          const r = hooks.onToolPending
	            ? hooks.onToolPending(state, {
	              toolName: msg.toolName,
	              toolCallId: msg.toolCallId,
	              jobId: msg.reply.jobId,
	              placeholderText: msg.reply.placeholderText,
	            }, ctx)
	            : { state }
	          return materialize(r.state)
	        }
	        if (msg.reply.type === 'toolResult') {
	          span?.done()
	          ctx.log.info(`${log}: tool result`, { tool: msg.toolName, ok: true })
        } else {
          span?.error(msg.reply.error)
          ctx.log.warn(`${log}: tool error`, { tool: msg.toolName, error: msg.reply.error })
        }
        const content = msg.reply.type === 'toolResult' ? formatToolResultContent(msg.reply.result) : `Tool error: ${msg.reply.error}`
        batch.results.set(msg.toolCallId, { toolCallId: msg.toolCallId, toolName: msg.toolName, content })
        batch.pending.delete(msg.toolCallId)

        let withResultState = state
        if (hooks.onToolResult) {
          const r = hooks.onToolResult(state, { toolName: msg.toolName, toolCallId: msg.toolCallId, reply: msg.reply }, ctx)
          withResultState = r.state
        }

        // Auto-emit sources/attachments
        if (msg.reply.type === 'toolResult') {
          if (msg.reply.result.sources?.length) {
            emitUi(turn.userId, { type: 'sources', sources: msg.reply.result.sources }, ctx)
          }
          if (msg.reply.result.attachments?.length) {
            emitUi(turn.userId, { type: 'attachments', attachments: msg.reply.result.attachments }, ctx)
          }
        }

        if (batch.pending.size > 0) {
          const nextState = {
            ...withResultState,
            loop: {
              ...withResultState.loop,
              turn: { ...turn, pendingBatch: { ...batch } },
            },
          } as S
          return { state: nextState }
        }

        const toolResultMsgs: ApiMessage[] = Array.from(batch.results.values()).map(r => ({
          role: 'tool', content: r.content, tool_call_id: r.toolCallId,
        }))
        const assistantToolCalls: ToolCall[] = batch.calls.map(c => ({
          id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments },
        }))
        const batchHistory: ApiMessage[] = [
          { role: 'assistant', content: null, tool_calls: assistantToolCalls },
          ...toolResultMsgs,
        ]

        let withBatchState = withResultState
        if (hooks.onBatchHistoryReady) {
          const r = hooks.onBatchHistoryReady(withResultState, batchHistory, ctx)
          withBatchState = r.state
        }

        const nextLoopCount = turn.toolLoopCount + 1
        if (nextLoopCount >= maxToolLoops) {
          ctx.log.warn(`${log}: tool loop limit reached`, { limit: maxToolLoops })
          turn.requestSpan?.error('Tool loop limit reached')
          const r = hooks.onError(withBatchState, { kind: 'loopLimit', limit: maxToolLoops, finalText: turn.pending }, ctx)
          emitUi(turn.userId, { type: 'error', text: hooks.errorMessages?.loopLimit ?? 'Tool loop limit reached. Please try again.' }, ctx)
          return materialize(r.state)
        }

        const nextMessages: ApiMessage[] = [
          ...(turn.turnMessages ?? []),
          ...batchHistory,
        ]

        const requestId = crypto.randomUUID()
        const nextTurn: LoopTurn = {
          ...turn,
          requestId,
          turnMessages: nextMessages,
          pending: '',
          pendingBatch: null,
          toolLoopCount: nextLoopCount,
          llmSpan: null,
        }
        const llmSpan = sendStream(withBatchState, requestId, nextMessages, turn.requestSpan, ctx)
        const nextState = {
          ...withBatchState,
          loop: {
            phase: 'awaitingLlm' as const,
            turn: { ...nextTurn, llmSpan },
          },
        } as S

        return { state: nextState, become: awaitingLlm }
      }

      default:
        return { state }
    }
  }

  return {
    idle,
    startTurn,
  }
}

export const agentLoop = <S extends WithLoopState, M >(hooks: AgentLoopHooks<S, M>): AgentLoopHandle<M, S> => createLoopEngine(hooks)

// ─── Reusable interceptors ──────────────────────────────────────────────────

export const idleGuardInterceptor = <M extends { type: string }, S extends WithLoopState>(
  triggerType: string,
  handler: (state: S, msg: Extract<M, { type: typeof triggerType }>, ctx: ActorContext<M>) => ActorResult<M, S>,
): Interceptor<M, S> => (state, msg, ctx, next) => {
  const m = msg as M
  if (m.type === triggerType) {
    if (state.loop.phase !== 'idle') return { state, stash: true }
    return handler(state, m as Extract<M, { type: typeof triggerType }>, ctx)
  }
  return next(state, msg)
}
