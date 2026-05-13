import type {
  ActorRef,
  ActorResult,
  ActorContext,
  MessageHandler,
  SpanHandle,
  TypedEvent,
} from './types.ts'
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

export type LoopBaseMsg = LlmProviderReply | LoopToolResultMsg

export type LoopMsg<Extra extends { type: string } = never> = LoopBaseMsg | Extra

// ─── Hook surface ──────────────────────────────────────────────────────────

export type StreamChunk =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }

export type AgentLoopHooks<S, M extends { type: string }> = {
  role: string
  spanName: string
  logPrefix?: string

  tools: ToolCollection | ((s: S) => ToolCollection)
  model: string
  maxToolLoops: number

  llmRef: (s: S) => ActorRef<LlmProviderMsg> | null

  onComplete: (s: S, finalText: string, turn: LoopTurn, ctx: ActorContext<M>) => { state: S; events?: TypedEvent[] }
  onLlmError: (s: S, error: unknown, ctx: ActorContext<M>) => { state: S; events?: TypedEvent[] }
  onLoopLimit: (s: S, finalText: string, ctx: ActorContext<M>) => { state: S; events?: TypedEvent[] }

  onStream?: (s: S, chunk: StreamChunk, requestId: string, ctx: ActorContext<M>) => S | { state: S; events?: TypedEvent[] }

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

  backgroundCompletionMessage?: (
    toolName: string,
    toolCallId: string,
    reply: ToolFinalReply,
  ) => M
}

// ─── Exported handle ───────────────────────────────────────────────────────

export type AgentLoopHandle<M extends { type: string }, S> = {
  idle: MessageHandler<M, S>
  startTurn: (state: S, params: LoopStartTurnParams, ctx: ActorContext<M>) => ActorResult<M, S>
  readonly phase: 'idle' | 'awaitingLlm' | 'toolLoop'
}

// ─── Internal engine ───────────────────────────────────────────────────────

type LoopEngineState = {
  phase: 'idle' | 'awaitingLlm' | 'toolLoop'
  turn: LoopTurn
}

const createLoopEngine = <S, M extends { type: string }>( hooks: AgentLoopHooks<S, M> ) => {
  const log = hooks.logPrefix ?? hooks.spanName
  const { tools: toolsCfg, model, maxToolLoops } = hooks

  let engineState: LoopEngineState = {
    phase: 'idle',
    turn: initialLoopTurn(),
  }

  const resolveTools = (s: S): ToolCollection =>
    typeof toolsCfg === 'function' ? toolsCfg(s) : toolsCfg

  const resolveSchemas = (s: S): Tool[] =>
    Object.values(resolveTools(s)).map((e: ToolEntry) => e.schema as Tool)

  const normalizeChunkResult = (r: S | { state: S; events?: TypedEvent[] }): { state: S; events?: TypedEvent[] } =>
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

  const materialize = (action: { state: S; events?: TypedEvent[] }): ActorResult<M, S> => {
    engineState = { ...engineState, turn: initialLoopTurn(), phase: 'idle' }
    return {
      state: action.state,
      become: idle,
      unstashAll: true,
      ...(action.events ? { events: action.events } : {}),
    }
  }

  // ── Helper: send `stream` to LLM and return the new llmSpan ───────────────
  const sendStream = (state: S, requestId: string, messages: ApiMessage[], ctx: ActorContext<M>): SpanHandle | null => {
    const llmSpan = engineState.turn.requestSpan
      ? ctx.trace.child(engineState.turn.requestSpan.traceId, engineState.turn.requestSpan.spanId, 'llm-call', { model })
      : null
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
      clientId: engineState.turn.clientId,
      replyTo: ctx.self as unknown as ActorRef<LlmProviderReply>,
    })
    return llmSpan
  }

  // ── startTurn: in-process entry, shared by all agents ──
  const startTurn = (state: S, params: LoopStartTurnParams, ctx: ActorContext<M>): ActorResult<M, S> => {
    const llmRef = hooks.llmRef(state)
    if (!llmRef) {
      ctx.log.warn(`${log}: not ready (no LLM provider)`)
      return { state }
    }

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

  // ── Core dispatch (single function, phase + type branching) ───────────────
  const handle = (phase: LoopEngineState['phase'], state: S, msg: M, ctx: ActorContext<M>): ActorResult<M, S> => {
    //const m = msg as unknown as (LlmProviderReply | LoopToolResultMsg | { type: string })
    const m = msg as LoopBaseMsg | { type: string }

    if (phase === 'idle') {
      return { state }
    }

    if (phase === 'awaitingLlm') {
      switch (m.type) {
        case 'llmChunk': {
          const chunk = m as Extract<LlmProviderReply, { type: 'llmChunk' }>
          if (chunk.requestId !== engineState.turn.requestId) return { state }
          let next = state
          engineState = { ...engineState, turn: { ...engineState.turn, pending: engineState.turn.pending + chunk.text } }
          let events: TypedEvent[] | undefined
          if (hooks.onStream) {
            const r = normalizeChunkResult(hooks.onStream(next, { kind: 'text', text: chunk.text }, chunk.requestId, ctx))
            next = r.state
            events = r.events
          }
          return events && events.length > 0 ? { state: next, events } : { state: next }
        }

        case 'llmReasoningChunk': {
          const chunk = m as Extract<LlmProviderReply, { type: 'llmReasoningChunk' }>
          if (chunk.requestId !== engineState.turn.requestId) return { state }
          if (!hooks.onStream) return { state }
          const r = normalizeChunkResult(hooks.onStream(state, { kind: 'reasoning', text: chunk.text }, chunk.requestId, ctx))
          return r.events && r.events.length > 0 ? { state: r.state, events: r.events } : { state: r.state }
        }

        case 'llmToolCalls': {
          const tc = m as Extract<LlmProviderReply, { type: 'llmToolCalls' }>
          if (tc.requestId !== engineState.turn.requestId) return { state }

          engineState.turn.llmSpan?.done({ toolCalls: tc.calls.map(c => c.name) })
          ctx.log.info(`${log}: tool calls`, { tools: tc.calls.map(c => c.name) })

          const accumulatedUsage = addUsage(engineState.turn.pendingUsage, tc.usage)

          let advertEvents: TypedEvent[] | undefined
          if (hooks.onToolCalls) {
            const observed = hooks.onToolCalls(state, tc.calls, ctx)
            advertEvents = observed?.events
          }

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
            if (engineState.turn.requestSpan) {
              spans.set(call.id, ctx.trace.child(
                engineState.turn.requestSpan.traceId,
                engineState.turn.requestSpan.spanId,
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

          const userId = engineState.turn.userId
          const clientId = engineState.turn.clientId

          for (const call of knownCalls) {
            const entry = tools[call.name]!
            const toolSpan = spans.get(call.id)
            ctx.pipeToSelf(
              invokeTool(ctx, entry.ref,
                { toolName: call.name, arguments: call.arguments, clientId, userId },
                {
                  headers: toolSpan ? ctx.trace.injectHeaders(toolSpan) : undefined,
                  onCompletion: hooks.backgroundCompletionMessage
                    ? (reply: ToolFinalReply): M => hooks.backgroundCompletionMessage!(call.name, call.id, reply)
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
        }

        case 'llmDone': {
          const done = m as Extract<LlmProviderReply, { type: 'llmDone' }>
          if (done.requestId !== engineState.turn.requestId) return { state }
          engineState.turn.llmSpan?.done()
          engineState.turn.requestSpan?.done()
          ctx.log.info(`${log}: done`, { chars: engineState.turn.pending.length })
          engineState = { ...engineState, turn: { ...engineState.turn, pendingUsage: addUsage(engineState.turn.pendingUsage, done.usage) } }
          return materialize(hooks.onComplete(state, engineState.turn.pending, engineState.turn, ctx))
        }

        case 'llmError': {
          const err = m as Extract<LlmProviderReply, { type: 'llmError' }>
          if (err.requestId !== engineState.turn.requestId) return { state }
          engineState.turn.llmSpan?.error(err.error)
          engineState.turn.requestSpan?.error(err.error)
          ctx.log.error(`${log}: LLM error`, { error: String(err.error) })
          return materialize(hooks.onLlmError(state, err.error, ctx))
        }

        default:
          return { state }
      }
    }

    if (phase === 'toolLoop') {
      switch (m.type) {
        case '_toolResult': {
          const msg = m as LoopToolResultMsg
          const batch = engineState.turn.pendingBatch!
          const span = batch.spans.get(msg.toolCallId)
          if (msg.reply.type === 'toolResult') {
            span?.done()
            ctx.log.info(`${log}: tool result`, { tool: msg.toolName, ok: true })
          } else {
            span?.error(msg.reply.error)
            ctx.log.warn(`${log}: tool error`, { tool: msg.toolName, error: msg.reply.error })
          }
          const content = msg.reply.type === 'toolResult' ? msg.reply.result.text : `Tool error: ${msg.reply.error}`
          batch.results.set(msg.toolCallId, { toolCallId: msg.toolCallId, toolName: msg.toolName, content })
          batch.pending.delete(msg.toolCallId)

          let withResultState = state
          let resultEvents: TypedEvent[] | undefined
          if (hooks.onToolResult) {
            const r = hooks.onToolResult(state, { toolName: msg.toolName, toolCallId: msg.toolCallId, reply: msg.reply }, ctx)
            withResultState = r.state
            resultEvents = r.events
          }

          if (batch.pending.size > 0) {
            engineState = { ...engineState, turn: { ...engineState.turn, pendingBatch: { ...batch } } }
            return resultEvents && resultEvents.length > 0 ? { state: withResultState, events: resultEvents } : { state: withResultState }
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
            return materialize(merged)
          }

          const nextMessages: ApiMessage[] = [
            ...(engineState.turn.turnMessages ?? []),
            ...batchHistory,
          ]

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
            phase: 'awaitingLlm',
          }
          const llmSpan = sendStream(withBatchState, requestId, nextMessages, ctx)
          engineState = { ...engineState, turn: { ...engineState.turn, llmSpan } }

          return mergedEvents
            ? { state: withBatchState, become: awaitingLlm, events: mergedEvents }
            : { state: withBatchState, become: awaitingLlm }
        }

        default:
          return { state }
      }
    }

    return { state }
  }

  // ── Exported handlers ─────────────────────────────────────────────────────
  const idle: MessageHandler<M, S> = (state, msg, ctx) => handle('idle', state, msg, ctx)
  const awaitingLlm: MessageHandler<M, S> = (state, msg, ctx) => handle('awaitingLlm', state, msg, ctx)
  const toolLoop: MessageHandler<M, S> = (state, msg, ctx) => handle('toolLoop', state, msg, ctx)

  return {
    idle,
    startTurn,
    get phase() { return engineState.phase },
  }
}

export const AgentLoop = <S, M extends { type: string }>(hooks: AgentLoopHooks<S, M> ): AgentLoopHandle<M, S> => createLoopEngine(hooks)
