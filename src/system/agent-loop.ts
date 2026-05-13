import type {
  ActorRef,
  ActorResult,
  ActorContext,
  MessageHandler,
  SpanHandle,
  TypedEvent,
} from './types.ts'
import { onMessage } from './match.ts'
import { invokeTool } from './invoke-tool.ts'
import type {
  ToolCollection,
  ToolEntry,
  ToolFinalReply,
  ToolMsg,
  ToolSchema,
} from '../types/tools.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  TokenUsage,
  Tool,
  ToolCall,
} from '../types/llm.ts'

// ─── Shared turn-slice shapes ───────────────────────────────────────────────

export type LoopPendingBatch = {
  remaining: number
  results: { toolCallId: string; toolName: string; content: string }[]
  spans: Record<string, SpanHandle>
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
  clientId: string | undefined
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
  clientId: undefined,
  pendingUsage: { promptTokens: 0, completionTokens: 0 },
})

// ─── Base message variants the closure dispatches on ───────────────────────

export type LoopStartTurnParams = {
  messages: ApiMessage[]
  userId: string
  clientId?: string
}

export type LoopToolResultMsg = {
  type: '_toolResult'
  toolName: string
  toolCallId: string
  reply: ToolFinalReply
}

export type LoopSubscriptionMsg =
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }

export type LoopToolRegistrationMsg =
  | { type: '_toolRegistered'; name: string; schema: ToolSchema; ref: ActorRef<ToolMsg>; mayBeLongRunning?: boolean }
  | { type: '_toolUnregistered'; name: string }

export type LoopBackgroundResultMsg = {
  type: '_backgroundToolResult'
  toolName: string
  toolCallId: string
  reply: ToolFinalReply
}

export type LoopBaseMsg =
  | LlmProviderReply
  | LoopToolResultMsg
  | LoopSubscriptionMsg
  | LoopToolRegistrationMsg
  | LoopBackgroundResultMsg

export type LoopMsg<Extra extends { type: string } = never> = LoopBaseMsg | Extra

// ─── Hook surface ──────────────────────────────────────────────────────────

export type LoopCompletionAction<M extends { type: string }, S> = {
  state: S
  unstashAll?: boolean
  become?: MessageHandler<M, S>
  events?: TypedEvent[]
}

export type LoopChunkResult<S> = S | { state: S; events?: TypedEvent[] }

export type StreamChunk =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }

export type AgentLoopHooks<S, M extends { type: string }> = {
  role: string
  spanName: string
  logPrefix?: string

  tools: ToolCollection | ((s: S) => ToolCollection)
  extraToolSchemas?: (s: S) => Tool[]
  model: string
  maxToolLoops: number

  initialLlmRef?: ActorRef<LlmProviderMsg> | null

  onComplete: (s: S, finalText: string, turn: LoopTurn, ctx: ActorContext<M>) => LoopCompletionAction<M, S>
  onLlmError: (s: S, error: unknown, ctx: ActorContext<M>) => LoopCompletionAction<M, S>
  onLoopLimit: (s: S, finalText: string, ctx: ActorContext<M>) => LoopCompletionAction<M, S>

  onStream?: (s: S, chunk: StreamChunk, requestId: string, ctx: ActorContext<M>) => LoopChunkResult<S>

  onToolResult?: (
    s: S,
    result: { toolName: string; toolCallId: string; reply: ToolFinalReply },
    ctx: ActorContext<M>,
  ) => { state: S; events?: TypedEvent[] }

  onBatchHistoryReady?: (
    s: S,
    messages: ApiMessage[],
    ctx: ActorContext<M>,
  ) => { state: S; events?: TypedEvent[] }

  onToolCalls?: (
    s: S,
    calls: Extract<LlmProviderReply, { type: 'llmToolCalls' }>['calls'],
    ctx: ActorContext<M>,
  ) => { events?: TypedEvent[] } | void

  setTools?: (s: S, tools: ToolCollection) => S

  onBackgroundResult?: (
    s: S,
    result: { toolName: string; toolCallId: string; reply: ToolFinalReply },
    ctx: ActorContext<M>,
  ) => ActorResult<M, S>

  extraCases?: {
    all?: Record<string, (s: S, msg: any, ctx: ActorContext<M>) => ActorResult<M, S>>
    idle?: Record<string, (s: S, msg: any, ctx: ActorContext<M>) => ActorResult<M, S>>
    awaitingLlm?: Record<string, (s: S, msg: any, ctx: ActorContext<M>) => ActorResult<M, S>>
    toolLoop?: Record<string, (s: S, msg: any, ctx: ActorContext<M>) => ActorResult<M, S>>
  }
}

// ─── Exported handle ───────────────────────────────────────────────────────

export type AgentLoopHandle<M extends { type: string }, S> = {
  idle: MessageHandler<M, S>
  awaitingLlm: MessageHandler<M, S>
  toolLoop: MessageHandler<M, S>
  startTurn: (state: S, params: LoopStartTurnParams, ctx: ActorContext<M>) => ActorResult<M, S>
  readonly isReady: boolean
}

// ─── Internal engine ───────────────────────────────────────────────────────

type LoopEngineState = {
  phase: 'idle' | 'awaitingLlm' | 'toolLoop'
  turn: LoopTurn
  llmRef: ActorRef<LlmProviderMsg> | null
}

const createLoopEngine = <S, M extends { type: string }>(
  hooks: AgentLoopHooks<S, M>,
) => {
  const log = hooks.logPrefix ?? hooks.spanName
  const { tools: toolsCfg, model, maxToolLoops } = hooks

  let engineState: LoopEngineState = {
    phase: 'idle',
    turn: initialLoopTurn(),
    llmRef: hooks.initialLlmRef ?? null,
  }

  const resolveTools = (s: S): ToolCollection =>
    typeof toolsCfg === 'function' ? toolsCfg(s) : toolsCfg

  const resolveSchemas = (s: S): Tool[] => {
    const fromTools = Object.values(resolveTools(s)).map((e: ToolEntry) => e.schema as Tool)
    const extras = hooks.extraToolSchemas ? hooks.extraToolSchemas(s) : []
    return [...fromTools, ...extras]
  }

  const normalizeChunkResult = (r: LoopChunkResult<S>): { state: S; events?: TypedEvent[] } =>
    r && typeof r === 'object' && 'state' in (r as object)
      ? (r as { state: S; events?: TypedEvent[] })
      : { state: r as S }

  const addUsage = (a: TokenUsage, b: TokenUsage | null | undefined): TokenUsage =>
    b
      ? { promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens }
      : a

  const mergeEvents = (...lists: (TypedEvent[] | undefined)[]): TypedEvent[] | undefined => {
    const out: TypedEvent[] = []
    for (const list of lists) {
      if (list) out.push(...list)
    }
    return out.length > 0 ? out : undefined
  }

  // mutually-recursive handler refs
  let idle: MessageHandler<M, S>
  let awaitingLlm: MessageHandler<M, S>
  let toolLoop: MessageHandler<M, S>

  const materialize = (action: LoopCompletionAction<M, S>): ActorResult<M, S> => {
    engineState = { ...engineState, turn: initialLoopTurn(), phase: 'idle' }
    return {
      state: action.state,
      become: action.become ?? idle,
      unstashAll: action.unstashAll ?? true,
      ...(action.events ? { events: action.events } : {}),
    }
  }

  // ── Helper: send `stream` to LLM and return the new llmSpan ───────────────
  const sendStream = (state: S, requestId: string, messages: ApiMessage[], ctx: ActorContext<M>): SpanHandle | null => {
    const llmSpan = engineState.turn.requestSpan
      ? ctx.trace.child(engineState.turn.requestSpan.traceId, engineState.turn.requestSpan.spanId, 'llm-call', { model })
      : null
    const schemas = resolveSchemas(state)
    engineState.llmRef!.send({
      type: 'stream',
      requestId,
      model,
      messages,
      tools: schemas.length > 0 ? schemas : undefined,
      role: hooks.role,
      clientId: engineState.turn.clientId,
      replyTo: ctx.self as unknown as ActorRef<LlmProviderReply>,
    })
    return llmSpan
  }

  // ── Helper: drive the next turn (used by toolLoop after a complete batch) ──
  const startNextTurn = (state: S, nextMessages: ApiMessage[], nextLoopCount: number, ctx: ActorContext<M>): ActorResult<M, S> => {
    const requestId = crypto.randomUUID()
    engineState = {
      ...engineState,
      turn: {
        ...engineState.turn,
        requestId,
        turnMessages: nextMessages,
        pending: '',
        pendingBatch: null,
        toolLoopCount: nextLoopCount,
        llmSpan: null,
      },
    }
    const llmSpan = sendStream(state, requestId, nextMessages, ctx)
    engineState = { ...engineState, turn: { ...engineState.turn, llmSpan }, phase: 'awaitingLlm' }
    return { state, become: awaitingLlm }
  }

  // ── Shared subscription cases ─────────────────────────────────────────────
  const sharedCases: any = {
    _llmProvider: (state: S, msg: Extract<LoopSubscriptionMsg, { type: '_llmProvider' }>) => {
      engineState = { ...engineState, llmRef: msg.ref }
      return { state }
    },
  }

  // ── Tool registration cases ───────────────────────────────────────────────
  if (hooks.setTools) {
    sharedCases._toolRegistered = (state: S, msg: any) => ({
      state: hooks.setTools!(state, {
        ...resolveTools(state),
        [msg.name]: { schema: msg.schema, ref: msg.ref, mayBeLongRunning: msg.mayBeLongRunning },
      }),
    })
    sharedCases._toolUnregistered = (state: S, msg: any) => {
      const { [msg.name]: _, ...rest } = resolveTools(state)
      return { state: hooks.setTools!(state, rest) }
    }
  }

  // ── Background-result cases (idle only) ───────────────────────────────────
  const backgroundResultCases: any = hooks.onBackgroundResult
    ? {
        _backgroundToolResult: (state: S, msg: any, ctx: ActorContext<M>) =>
          hooks.onBackgroundResult!(state, {
            toolName: msg.toolName,
            toolCallId: msg.toolCallId,
            reply: msg.reply,
          }, ctx),
      }
    : {}

  const backgroundStashCases: any = hooks.onBackgroundResult
    ? { _backgroundToolResult: (state: S) => ({ state, stash: true }) }
    : {}

  // ── startTurn: in-process entry, shared by all agents ──
  const startTurn = (state: S, params: LoopStartTurnParams, ctx: ActorContext<M>): ActorResult<M, S> => {
    let requestSpan: SpanHandle | null = null
    const parent = ctx.trace.fromHeaders()
    if (parent) {
      requestSpan = ctx.trace.child(parent.traceId, parent.spanId, hooks.spanName, {})
    }

    const requestId = crypto.randomUUID()
    engineState = {
      ...engineState,
      turn: {
        ...engineState.turn,
        requestId,
        turnMessages: params.messages,
        pending: '',
        pendingBatch: null,
        toolLoopCount: 0,
        requestSpan,
        llmSpan: null,
        userId: params.userId,
        clientId: params.clientId,
        pendingUsage: { promptTokens: 0, completionTokens: 0 },
      },
      phase: 'awaitingLlm',
    }
    const llmSpan = sendStream(state, requestId, params.messages, ctx)
    engineState = { ...engineState, turn: { ...engineState.turn, llmSpan } }
    return { state, become: awaitingLlm }
  }

  // ── idle ─────────────────────────────────────────────────────────────────
  const idleBase: any = {
    ...sharedCases,
    ...backgroundResultCases,
  }

  // ── awaitingLlm ──────────────────────────────────────────────────────────
  const awaitingLlmBase: any = {
    llmChunk: (state: S, msg: Extract<LlmProviderReply, { type: 'llmChunk' }>, ctx: ActorContext<M>) => {
      if (msg.requestId !== engineState.turn.requestId) return { state }
      let next = state
      engineState = { ...engineState, turn: { ...engineState.turn, pending: engineState.turn.pending + msg.text } }
      let events: TypedEvent[] | undefined
      if (hooks.onStream) {
        const r = normalizeChunkResult(hooks.onStream(next, { kind: 'text', text: msg.text }, msg.requestId, ctx))
        next = r.state
        events = r.events
      }
      return events && events.length > 0 ? { state: next, events } : { state: next }
    },

    llmReasoningChunk: (state: S, msg: Extract<LlmProviderReply, { type: 'llmReasoningChunk' }>, ctx: ActorContext<M>) => {
      if (!hooks.onStream) return { state }
      const r = normalizeChunkResult(hooks.onStream(state, { kind: 'reasoning', text: msg.text }, msg.requestId, ctx))
      return r.events && r.events.length > 0 ? { state: r.state, events: r.events } : { state: r.state }
    },

    llmToolCalls: (state: S, msg: Extract<LlmProviderReply, { type: 'llmToolCalls' }>, ctx: ActorContext<M>) => {
      if (msg.requestId !== engineState.turn.requestId) return { state }

      engineState.turn.llmSpan?.done({ toolCalls: msg.calls.map(c => c.name) })
      ctx.log.info(`${log}: tool calls`, { tools: msg.calls.map(c => c.name) })

      const accumulatedUsage = addUsage(engineState.turn.pendingUsage, msg.usage)

      let advertEvents: TypedEvent[] | undefined
      if (hooks.onToolCalls) {
        const observed = hooks.onToolCalls(state, msg.calls, ctx)
        advertEvents = observed?.events
      }

      const tools = resolveTools(state)
      const knownCalls: typeof msg.calls = []
      const skippedUnknownCalls: typeof msg.calls = []
      for (const call of msg.calls) {
        if (tools[call.name]) {
          knownCalls.push(call)
          continue
        }
        ctx.log.warn(`${log}: unknown tool (skipped)`, { tool: call.name })
        skippedUnknownCalls.push(call)
      }

      const spans: Record<string, SpanHandle> = {}
      for (const call of knownCalls) {
        if (engineState.turn.requestSpan) {
          spans[call.id] = ctx.trace.child(
            engineState.turn.requestSpan.traceId,
            engineState.turn.requestSpan.spanId,
            'tool-invoke',
            { toolName: call.name, arguments: call.arguments },
          )
        }
      }

      const batch: LoopPendingBatch = {
        remaining: knownCalls.length + skippedUnknownCalls.length,
        results: [],
        spans,
        calls: msg.calls,
      }

      const userId = engineState.turn.userId
      const clientId = engineState.turn.clientId

      for (const call of knownCalls) {
        const entry = tools[call.name]!
        const toolSpan = spans[call.id]
        ctx.pipeToSelf(
          invokeTool(ctx, entry.ref,
            { toolName: call.name, arguments: call.arguments, clientId, userId },
            {
              headers: toolSpan ? ctx.trace.injectHeaders(toolSpan) : undefined,
              onCompletion: hooks.onBackgroundResult
                ? (reply: ToolFinalReply): M => ({
                    type: '_backgroundToolResult',
                    toolName: call.name,
                    toolCallId: call.id,
                    reply,
                  } as unknown as M)
                : undefined,
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

      engineState = {
        ...engineState,
        turn: { ...engineState.turn, requestId: null, llmSpan: null, pendingBatch: batch, pendingUsage: accumulatedUsage },
        phase: 'toolLoop',
      }
      return advertEvents && advertEvents.length > 0
        ? { state, become: toolLoop, events: advertEvents }
        : { state, become: toolLoop }
    },

    llmDone: (state: S, msg: Extract<LlmProviderReply, { type: 'llmDone' }>, ctx: ActorContext<M>) => {
      if (msg.requestId !== engineState.turn.requestId) return { state }
      engineState.turn.llmSpan?.done()
      engineState.turn.requestSpan?.done()
      ctx.log.info(`${log}: done`, { chars: engineState.turn.pending.length })
      engineState = { ...engineState, turn: { ...engineState.turn, pendingUsage: addUsage(engineState.turn.pendingUsage, msg.usage) } }
      return materialize(hooks.onComplete(state, engineState.turn.pending, engineState.turn, ctx))
    },

    llmError: (state: S, msg: Extract<LlmProviderReply, { type: 'llmError' }>, ctx: ActorContext<M>) => {
      if (msg.requestId !== engineState.turn.requestId) return { state }
      engineState.turn.llmSpan?.error(msg.error)
      engineState.turn.requestSpan?.error(msg.error)
      ctx.log.error(`${log}: LLM error`, { error: String(msg.error) })
      return materialize(hooks.onLlmError(state, msg.error, ctx))
    },

    ...sharedCases,
    ...backgroundStashCases,
  }

  // ── toolLoop ─────────────────────────────────────────────────────────────
  const toolLoopBase: any = {
    _toolResult: (state: S, msg: LoopToolResultMsg, ctx: ActorContext<M>) => {
      const batch = engineState.turn.pendingBatch!
      const span = batch.spans[msg.toolCallId]
      if (msg.reply.type === 'toolResult') {
        span?.done()
        ctx.log.info(`${log}: tool result`, { tool: msg.toolName, ok: true })
      } else {
        span?.error(msg.reply.error)
        ctx.log.warn(`${log}: tool error`, { tool: msg.toolName, error: msg.reply.error })
      }
      const content = msg.reply.type === 'toolResult' ? msg.reply.result.text : `Tool error: ${msg.reply.error}`
      const updated = [...batch.results, { toolCallId: msg.toolCallId, toolName: msg.toolName, content }]
      const remaining = batch.remaining - 1

      let withResultState = state
      let resultEvents: TypedEvent[] | undefined
      if (hooks.onToolResult) {
        const r = hooks.onToolResult(state, { toolName: msg.toolName, toolCallId: msg.toolCallId, reply: msg.reply }, ctx)
        withResultState = r.state
        resultEvents = r.events
      }

      if (remaining > 0) {
        engineState = { ...engineState, turn: { ...engineState.turn, pendingBatch: { ...batch, remaining, results: updated } } }
        return resultEvents && resultEvents.length > 0 ? { state: withResultState, events: resultEvents } : { state: withResultState }
      }

      const toolResultMsgs: ApiMessage[] = updated.map(r => ({
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
      let batchEvents: TypedEvent[] | undefined
      if (hooks.onBatchHistoryReady) {
        const r = hooks.onBatchHistoryReady(withResultState, batchHistory, ctx)
        withBatchState = r.state
        batchEvents = r.events
      }

      const mergedEvents = mergeEvents(resultEvents, batchEvents)

      const nextLoopCount = engineState.turn.toolLoopCount + 1
      if (nextLoopCount >= maxToolLoops) {
        ctx.log.warn(`${log}: tool loop limit reached`, { limit: maxToolLoops })
        engineState.turn.requestSpan?.error('Tool loop limit reached')
        const completion = hooks.onLoopLimit(withBatchState, engineState.turn.pending, ctx)
        const merged = mergedEvents
          ? { ...completion, events: mergeEvents(mergedEvents, completion.events) }
          : completion
        return materialize(merged as LoopCompletionAction<M, S>)
      }

      const nextMessages: ApiMessage[] = [
        ...(engineState.turn.turnMessages ?? []),
        ...batchHistory,
      ]

      const nextResult = startNextTurn(withBatchState, nextMessages, nextLoopCount, ctx)
      return mergedEvents
        ? { ...nextResult, events: mergeEvents(mergedEvents, nextResult.events) }
        : nextResult
    },

    ...sharedCases,
    ...backgroundStashCases,
  }

  // ── Merge extraCases (extras override built-ins) ──────────────────────────
  const idleCases = {
    ...idleBase,
    ...(hooks.extraCases?.all ?? {}),
    ...(hooks.extraCases?.idle ?? {}),
  }

  const awaitingLlmCases = {
    ...awaitingLlmBase,
    ...(hooks.extraCases?.all ?? {}),
    ...(hooks.extraCases?.awaitingLlm ?? {}),
  }

  const toolLoopCases = {
    ...toolLoopBase,
    ...(hooks.extraCases?.all ?? {}),
    ...(hooks.extraCases?.toolLoop ?? {}),
  }

  idle = onMessage<M, S>(idleCases) as MessageHandler<M, S>
  awaitingLlm = onMessage<M, S>(awaitingLlmCases) as MessageHandler<M, S>
  toolLoop = onMessage<M, S>(toolLoopCases) as MessageHandler<M, S>

  return {
    idle,
    awaitingLlm,
    toolLoop,
    startTurn,
    get isReady() { return engineState.llmRef !== null },
  }
}

export const AgentLoop = <S, M extends { type: string }>(
  hooks: AgentLoopHooks<S, M>,
): AgentLoopHandle<M, S> => createLoopEngine(hooks)
