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
  ToolReply,
} from '../types/tools.ts'
import { renderToolResultForLlm } from '../types/tools.ts'
import type {
  ApiMessage,
  LlmProviderMsg,
  LlmProviderReply,
  TokenUsage,
  Tool,
  ToolCall,
} from '../types/llm.ts'

// ─── Shared turn-slice shapes ───────────────────────────────────────────────

export type ReactPendingBatch = {
  remaining:          number
  results:            { toolCallId: string; toolName: string; content: string }[]
  messagesAtCall:     ApiMessage[]
  assistantToolCalls: ToolCall[]
  spans:              Record<string, SpanHandle>
}

export type ReactTurn = {
  requestId:     string | null
  turnMessages:  ApiMessage[] | null
  pending:       string
  pendingBatch:  ReactPendingBatch | null
  toolLoopCount: number
  requestSpan:   SpanHandle | null
  llmSpan:       SpanHandle | null
  userId:        string
  clientId:      string | undefined
  replyTo:       ActorRef<ToolReply> | null
  /** Aggregated usage across this turn (chunks + done + toolCalls). Reset on materialize. */
  pendingUsage:  TokenUsage
}

export const initialReactTurn = (): ReactTurn => ({
  requestId:     null,
  turnMessages:  null,
  pending:       '',
  pendingBatch:  null,
  toolLoopCount: 0,
  requestSpan:   null,
  llmSpan:       null,
  userId:        '',
  clientId:      undefined,
  replyTo:       null,
  pendingUsage:  { promptTokens: 0, completionTokens: 0 },
})

/** Loop-internal mutable state. Agents hold this in one field of their state bag. */
export type ReactLoopSlice = {
  llmRef: ActorRef<LlmProviderMsg> | null
  turn:   ReactTurn
}

export const initialReactLoopSlice = (): ReactLoopSlice => ({
  llmRef: null,
  turn:   initialReactTurn(),
})

// ─── Base message variants the closure dispatches on ───────────────────────

export type ReactInvokeMsg = {
  type:          'invoke'
  toolName:      string
  arguments:     string
  clientId?:     string
  userId:        string
  replyTo:       ActorRef<ToolReply>
  /** When `spans: 'fromMessage'`, the request span is built from these IDs. Ignored otherwise. */
  traceId?:      string
  parentSpanId?: string
}

export type ReactToolResultMsg = {
  type:       '_toolResult'
  toolName:   string
  toolCallId: string
  reply:      ToolFinalReply
}

export type ReactSubscriptionMsg =
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }

/**
 * Reference shape of variants the closure dispatches on. Agents must include
 * each of these in their own message union (with matching field shapes), and
 * may add additional variants on top — the closure ignores anything it
 * doesn't recognise.
 */
export type ReactBaseMsg =
  | ReactInvokeMsg
  | LlmProviderReply
  | ReactToolResultMsg
  | ReactSubscriptionMsg

// ─── Hook surface ──────────────────────────────────────────────────────────

export type ReactCompletionAction<M extends { type: string }, S> = {
  state:       S
  unstashAll?: boolean
  /** Override the post-completion handler. Defaults to the loop's idle. */
  become?:     MessageHandler<M, S>
  /** Domain events to emit alongside the transition. */
  events?:     TypedEvent[]
}

/** Result of buildTurn: either reject with error, or accept with the turn's initial messages. */
export type ReactBuildTurnResult =
  | { error: string }
  | { messages: ApiMessage[] }

export type ReactSpanPolicy = 'fromHeaders' | 'fromMessage' | 'always' | 'never'

/**
 * Pre-dispatch tool-call hook. Runs after the requestId guard and after the
 * llmSpan is closed, *before* the loop partitions and dispatches calls.
 * - `{ handled: true, result }` short-circuits the turn (caller owns spans, become, unstashAll).
 * - `{ handled: false, events? }` lets the loop dispatch normally; any `events` are emitted alongside the transition (e.g. a `searching` notification).
 */
export type ReactToolCallInterception<M extends { type: string }, S> =
  | { handled: true;  result: ActorResult<M, S> }
  | { handled: false; events?: TypedEvent[] }

/** Result of an `onChunk` / `onReasoningChunk` hook. Either a bare state, or state plus events emitted alongside the chunk. */
export type ReactChunkResult<S> = S | { state: S; events?: TypedEvent[] }

export type ReactLoopHooks<S, M extends { type: string }> = {
  /** Role string sent on every LLM stream message (e.g. 'google', 'memory-recall'). */
  role:         string
  /** Operation name used when creating the per-request root span. */
  spanName:     string
  /** Prefix used in info/warn/error log messages. Defaults to `spanName`. */
  logPrefix?:   string

  // ─── Per-actor config ───
  /** Either a constant tool collection (immutable) or an accessor that reads from state (dynamic — registered/unregistered at runtime). */
  tools:        ToolCollection | ((s: S) => ToolCollection)
  /**
   * Extra schemas to advertise to the LLM that are NOT in `tools` (no dispatch ref).
   * Use with `interceptToolCalls` to handle them in-actor (e.g. planner control tools).
   */
  extraToolSchemas?: (s: S) => Tool[]
  model:        string
  maxToolLoops: number

  // ─── Loop state slice ───
  slice:        (s: S) => ReactLoopSlice
  setSlice:     (s: S, slice: ReactLoopSlice) => S

  // ─── Entry ───
  /** Validate the invoke message and produce the turn's initial messages. */
  buildTurn:     (s: S, msg: ReactInvokeMsg, ctx: ActorContext<M>) => ReactBuildTurnResult

  // ─── Completion handlers ───
  /** Called on `llmDone` after the request span is closed. Returned state is applied and the actor becomes idle (or `action.become`). */
  onComplete:    (s: S, finalText: string, ctx: ActorContext<M>) => ReactCompletionAction<M, S>
  /** Called on `llmError`. Spans are already closed by the closure. */
  onLlmError:    (s: S, error: unknown,  ctx: ActorContext<M>) => ReactCompletionAction<M, S>
  /** Called when the tool-loop ceiling is hit. The current `pending` text is passed in. */
  onLoopLimit:   (s: S, finalText: string, ctx: ActorContext<M>) => ReactCompletionAction<M, S>

  // ─── Optional streaming hooks ───
  /** Per-token text chunk. Return either a new state (no events) or `{ state, events }`. */
  onChunk?:           (s: S, chunkText: string, requestId: string, ctx: ActorContext<M>) => ReactChunkResult<S>
  /** Per-token reasoning chunk. Same return shape as `onChunk`. */
  onReasoningChunk?:  (s: S, chunkText: string, requestId: string, ctx: ActorContext<M>) => ReactChunkResult<S>

  /**
   * Called once for each tool result the loop processes (just after the
   * pendingBatch is updated, before deciding whether to loop back). Lets agents
   * emit per-result events (e.g. `sources`).
   */
  onToolResult?: (
    s: S,
    result: { toolName: string; toolCallId: string; reply: ToolFinalReply },
    ctx: ActorContext<M>,
  ) => { state: S; events?: TypedEvent[] }

  /**
   * Optional pre-dispatch hook for `llmToolCalls`. Lets agents handle
   * synthetic/control tools (e.g. planner's `formalize_plan`) by short-
   * circuiting the loop. See `ReactToolCallInterception`.
   */
  interceptToolCalls?: (
    s:     S,
    calls: Extract<LlmProviderReply, { type: 'llmToolCalls' }>['calls'],
    ctx:   ActorContext<M>,
  ) => ReactToolCallInterception<M, S>

  /**
   * Extra message-type cases to merge into the internal idle/awaitingLlm/toolLoop
   * handlers. Survives `become` transitions because the loop's materialize uses
   * the merged handlers, not the bare ones. Use for shell-specific messages
   * like userMessage, _toolRegistered, _userContext, _planWriteDone, etc.
   */
  extraCases?: {
    idle?:        Record<string, (s: S, msg: any, ctx: ActorContext<M>) => ActorResult<M, S>>
    awaitingLlm?: Record<string, (s: S, msg: any, ctx: ActorContext<M>) => ActorResult<M, S>>
    toolLoop?:    Record<string, (s: S, msg: any, ctx: ActorContext<M>) => ActorResult<M, S>>
  }

  // ─── Knobs ───
  /** Stash concurrent `invoke` messages while a turn is in flight. Default: true. */
  stashConcurrent?:   boolean
  /**
   * Span policy:
   * - 'fromHeaders' (default) — adopt parent span from incoming W3C headers
   * - 'fromMessage' — adopt parent span from `traceId`/`parentSpanId` on the invoke msg
   * - 'always' — always create a fresh root span
   * - 'never' — no spans
   */
  spans?:             ReactSpanPolicy
}

// ─── Closure result ────────────────────────────────────────────────────────

export type ReactLoopHandlers<M extends { type: string }, S> = {
  idle:        MessageHandler<M, S>
  awaitingLlm: MessageHandler<M, S>
  toolLoop:    MessageHandler<M, S>
}

// ─── Implementation ────────────────────────────────────────────────────────

export const createReactLoop = <S, M extends { type: string }>(
  hooks: ReactLoopHooks<S, M>,
): ReactLoopHandlers<M, S> => {
  const log       = hooks.logPrefix ?? hooks.spanName
  const stash     = hooks.stashConcurrent !== false
  const spansMode = hooks.spans ?? 'fromHeaders'

  const { tools: toolsCfg, model, maxToolLoops } = hooks
  const resolveTools = (s: S): ToolCollection =>
    typeof toolsCfg === 'function' ? toolsCfg(s) : toolsCfg
  const resolveSchemas = (s: S): Tool[] => {
    const fromTools = Object.values(resolveTools(s)).map((e: ToolEntry) => e.schema as Tool)
    const extras    = hooks.extraToolSchemas ? hooks.extraToolSchemas(s) : []
    return [...fromTools, ...extras]
  }

  // mutually-recursive handler refs
  let idle:        MessageHandler<M, S>
  let awaitingLlm: MessageHandler<M, S>
  let toolLoop:    MessageHandler<M, S>

  // ── Slice accessors ───────────────────────────────────────────────────────
  const getTurn   = (s: S): ReactTurn => hooks.slice(s).turn
  const withTurn  = (s: S, turn: ReactTurn): S => hooks.setSlice(s, { ...hooks.slice(s), turn })
  const getLlmRef = (s: S): ActorRef<LlmProviderMsg> | null => hooks.slice(s).llmRef

  const materialize = (a: ReactCompletionAction<M, S>): ActorResult<M, S> => {
    const reset = hooks.setSlice(a.state, { ...hooks.slice(a.state), turn: initialReactTurn() })
    return {
      state:      reset,
      become:     a.become ?? idle,
      unstashAll: a.unstashAll ?? true,
      ...(a.events ? { events: a.events } : {}),
    }
  }

  // ── Helper: send `stream` to LLM and return the new llmSpan ───────────────
  const sendStream = (
    state:     S,
    requestId: string,
    messages:  ApiMessage[],
    ctx:       ActorContext<M>,
  ): SpanHandle | null => {
    const turn = getTurn(state)
    const llmSpan = turn.requestSpan
      ? ctx.trace.child(turn.requestSpan.traceId, turn.requestSpan.spanId, 'llm-call', { model })
      : null
    const schemas = resolveSchemas(state)
    getLlmRef(state)!.send({
      type:     'stream',
      requestId,
      model,
      messages,
      tools:    schemas.length > 0 ? schemas : undefined,
      role:     hooks.role,
      clientId: turn.clientId,
      replyTo:  ctx.self as unknown as ActorRef<LlmProviderReply>,
    })
    return llmSpan
  }

  // ── Subscription cases (shared across all three handlers) ─────────────────
  const subscriptionCases = {
    _llmProvider: (state: S, msg: Extract<ReactSubscriptionMsg, { type: '_llmProvider' }>) =>
      ({ state: hooks.setSlice(state, { ...hooks.slice(state), llmRef: msg.ref }) }),
  }

  // ── Helper: drive the next turn (used by toolLoop after a complete batch) ──
  const startNextTurn = (
    state:        S,
    nextMessages: ApiMessage[],
    nextLoopCount: number,
    ctx:          ActorContext<M>,
  ): ActorResult<M, S> => {
    const requestId = crypto.randomUUID()
    let next = withTurn(state, {
      ...getTurn(state),
      requestId,
      turnMessages:  nextMessages,
      pending:       '',
      pendingBatch:  null,
      toolLoopCount: nextLoopCount,
      llmSpan:       null,
    })
    const llmSpan = sendStream(next, requestId, nextMessages, ctx)
    next = withTurn(next, { ...getTurn(next), llmSpan })
    return { state: next, become: awaitingLlm }
  }

  // ── idle ─────────────────────────────────────────────────────────────────
  const idleCases: any = {
    invoke: (state: S, msg: ReactInvokeMsg, ctx: ActorContext<M>) => {
      const inv = msg

      const built = hooks.buildTurn(state, inv, ctx)
      if ('error' in built) {
        inv.replyTo.send({ type: 'toolError', error: built.error })
        return { state }
      }
      if (!getLlmRef(state)) {
        inv.replyTo.send({ type: 'toolError', error: `${log} not ready (no LLM provider).` })
        return { state }
      }

      let requestSpan: SpanHandle | null = null
      if (spansMode === 'fromHeaders') {
        const parent = ctx.trace.fromHeaders()
        requestSpan = parent
          ? ctx.trace.child(parent.traceId, parent.spanId, hooks.spanName, {})
          : null
      } else if (spansMode === 'fromMessage') {
        if (inv.traceId && inv.parentSpanId) {
          requestSpan = ctx.trace.child(inv.traceId, inv.parentSpanId, hooks.spanName, {})
        }
      } else if (spansMode === 'always') {
        requestSpan = ctx.trace.start(hooks.spanName, {})
      }

      const requestId = crypto.randomUUID()
      let next = withTurn(state, {
        ...getTurn(state),
        requestId,
        turnMessages:  built.messages,
        pending:       '',
        pendingBatch:  null,
        toolLoopCount: 0,
        requestSpan,
        llmSpan:       null,
        userId:        inv.userId,
        clientId:      inv.clientId,
        replyTo:       inv.replyTo,
      })
      const llmSpan = sendStream(next, requestId, built.messages, ctx)
      next = withTurn(next, { ...getTurn(next), llmSpan })

      ctx.log.info(`${log}: request started`, { userId: inv.userId })

      return { state: next, become: awaitingLlm }
    },

    ...subscriptionCases,
    ...(hooks.extraCases?.idle ?? {}),
  }

  idle = onMessage<M, S>(idleCases) as MessageHandler<M, S>

  // ── Helpers for new hook return shapes ────────────────────────────────────
  const normalizeChunkResult = (r: ReactChunkResult<S>): { state: S; events?: TypedEvent[] } =>
    (r && typeof r === 'object' && 'state' in (r as object))
      ? r as { state: S; events?: TypedEvent[] }
      : { state: r as S }

  const addUsage = (a: TokenUsage, b: TokenUsage | null | undefined): TokenUsage =>
    b ? { promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens } : a

  // ── awaitingLlm ──────────────────────────────────────────────────────────
  const awaitingLlmCases: any = {
    llmChunk: (state: S, msg: Extract<LlmProviderReply, { type: 'llmChunk' }>, ctx: ActorContext<M>) => {
      const turn = getTurn(state)
      if (msg.requestId !== turn.requestId) return { state }
      let next = withTurn(state, { ...turn, pending: turn.pending + msg.text })
      let events: TypedEvent[] | undefined
      if (hooks.onChunk) {
        const r = normalizeChunkResult(hooks.onChunk(next, msg.text, msg.requestId, ctx))
        next = r.state
        events = r.events
      }
      return events && events.length > 0 ? { state: next, events } : { state: next }
    },

    llmReasoningChunk: (state: S, msg: Extract<LlmProviderReply, { type: 'llmReasoningChunk' }>, ctx: ActorContext<M>) => {
      if (!hooks.onReasoningChunk) return { state }
      const r = normalizeChunkResult(hooks.onReasoningChunk(state, msg.text, msg.requestId, ctx))
      return r.events && r.events.length > 0 ? { state: r.state, events: r.events } : { state: r.state }
    },

    llmToolCalls: (state: S, msg: Extract<LlmProviderReply, { type: 'llmToolCalls' }>, ctx: ActorContext<M>) => {
      const turn = getTurn(state)
      if (msg.requestId !== turn.requestId) return { state }

      turn.llmSpan?.done({ toolCalls: msg.calls.map(c => c.name) })
      ctx.log.info(`${log}: tool calls`, { tools: msg.calls.map(c => c.name) })

      // Aggregate usage on this turn boundary.
      const accumulatedUsage = addUsage(turn.pendingUsage, msg.usage)

      // Allow agents to short-circuit dispatch (e.g. planner control tools)
      // or to emit pre-dispatch events (e.g. chatbot's `searching` notification).
      let advertEvents: TypedEvent[] | undefined
      if (hooks.interceptToolCalls) {
        const intercepted = hooks.interceptToolCalls(
          withTurn(state, { ...turn, llmSpan: null, pendingUsage: accumulatedUsage }),
          msg.calls,
          ctx,
        )
        if (intercepted.handled) return intercepted.result
        advertEvents = intercepted.events
      }

      const tools = resolveTools(state)
      const assistantToolCalls: ToolCall[] = msg.calls.map(c => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments },
      }))

      // Partition calls into known/unknown. Unknown calls generate synthetic
      // toolError feedback so the LLM sees the failure on the next turn.
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
        if (turn.requestSpan) {
          spans[call.id] = ctx.trace.child(
            turn.requestSpan.traceId, turn.requestSpan.spanId,
            'tool-invoke',
            { toolName: call.name, arguments: call.arguments },
          )
        }
      }

      const batch: ReactPendingBatch = {
        remaining:          knownCalls.length + skippedUnknownCalls.length,
        results:            [],
        messagesAtCall:     turn.turnMessages!,
        assistantToolCalls,
        spans,
      }

      const userId   = turn.userId
      const clientId = turn.clientId

      // Real tool invocations
      for (const call of knownCalls) {
        const entry    = tools[call.name]!
        const toolSpan = spans[call.id]
        ctx.pipeToSelf(
          invokeTool(ctx, entry.ref,
            { toolName: call.name, arguments: call.arguments, clientId, userId },
            { headers: toolSpan ? ctx.trace.injectHeaders(toolSpan) : undefined },
          ),
          (reply) => ({
            type:       '_toolResult',
            toolName:   call.name,
            toolCallId: call.id,
            reply,
          } as unknown as M),
          (error) => ({
            type:       '_toolResult',
            toolName:   call.name,
            toolCallId: call.id,
            reply:      { type: 'toolError', error: String(error) },
          } as unknown as M),
        )
      }

      // Synthetic tool-error feedback for skipped unknown calls — keeps the
      // batch counter consistent and surfaces the error to the LLM next turn.
      for (const call of skippedUnknownCalls) {
        const synthetic: M = {
          type:       '_toolResult',
          toolName:   call.name,
          toolCallId: call.id,
          reply:      { type: 'toolError', error: `Tool not available: ${call.name}` },
        } as unknown as M
        ctx.self.send(synthetic)
      }

      const next = withTurn(state, { ...turn, requestId: null, llmSpan: null, pendingBatch: batch, pendingUsage: accumulatedUsage })
      return advertEvents && advertEvents.length > 0
        ? { state: next, become: toolLoop, events: advertEvents }
        : { state: next, become: toolLoop }
    },

    llmDone: (state: S, msg: Extract<LlmProviderReply, { type: 'llmDone' }>, ctx: ActorContext<M>) => {
      const turn = getTurn(state)
      if (msg.requestId !== turn.requestId) return { state }
      turn.llmSpan?.done()
      turn.requestSpan?.done()
      ctx.log.info(`${log}: done`, { chars: turn.pending.length })
      const stateWithUsage = withTurn(state, { ...turn, pendingUsage: addUsage(turn.pendingUsage, msg.usage) })
      return materialize(hooks.onComplete(stateWithUsage, turn.pending, ctx))
    },

    llmError: (state: S, msg: Extract<LlmProviderReply, { type: 'llmError' }>, ctx: ActorContext<M>) => {
      const turn = getTurn(state)
      if (msg.requestId !== turn.requestId) return { state }
      turn.llmSpan?.error(msg.error)
      turn.requestSpan?.error(msg.error)
      ctx.log.error(`${log}: LLM error`, { error: String(msg.error) })
      return materialize(hooks.onLlmError(state, msg.error, ctx))
    },

    ...subscriptionCases,
  }

  if (stash) {
    awaitingLlmCases.invoke = (state: S) => ({ state, stash: true })
  }
  Object.assign(awaitingLlmCases, hooks.extraCases?.awaitingLlm ?? {})

  awaitingLlm = onMessage<M, S>(awaitingLlmCases) as MessageHandler<M, S>

  // ── toolLoop ─────────────────────────────────────────────────────────────
  const toolLoopCases: any = {
    _toolResult: (state: S, msg: ReactToolResultMsg, ctx: ActorContext<M>) => {
      const turn  = getTurn(state)
      const batch = turn.pendingBatch!
      const span  = batch.spans[msg.toolCallId]
      if (msg.reply.type === 'toolResult') {
        span?.done()
        ctx.log.info(`${log}: tool result`, { tool: msg.toolName, ok: true })
      } else {
        span?.error(msg.reply.error)
        ctx.log.warn(`${log}: tool error`, { tool: msg.toolName, error: msg.reply.error })
      }
      const content = msg.reply.type === 'toolResult' ? renderToolResultForLlm(msg.reply.result) : `Tool error: ${msg.reply.error}`
      const updated = [...batch.results, { toolCallId: msg.toolCallId, toolName: msg.toolName, content }]
      const remaining = batch.remaining - 1

      // Per-result hook (e.g. sources event). Lets agents observe results
      // before the loop decides to continue/stop, but never overrides flow.
      let withResultState = state
      let resultEvents: TypedEvent[] | undefined
      if (hooks.onToolResult) {
        const r = hooks.onToolResult(state, { toolName: msg.toolName, toolCallId: msg.toolCallId, reply: msg.reply }, ctx)
        withResultState = r.state
        resultEvents    = r.events
      }

      if (remaining > 0) {
        const next = withTurn(withResultState, { ...turn, pendingBatch: { ...batch, remaining, results: updated } })
        return resultEvents && resultEvents.length > 0 ? { state: next, events: resultEvents } : { state: next }
      }

      const nextLoopCount = turn.toolLoopCount + 1
      if (nextLoopCount >= maxToolLoops) {
        ctx.log.warn(`${log}: tool loop limit reached`, { limit: maxToolLoops })
        turn.requestSpan?.error('Tool loop limit reached')
        const completion = hooks.onLoopLimit(withResultState, turn.pending, ctx)
        const merged = resultEvents && resultEvents.length > 0
          ? { ...completion, events: [...resultEvents, ...(completion.events ?? [])] }
          : completion
        return materialize(merged)
      }

      const toolResultMsgs: ApiMessage[] = updated.map(r => ({
        role: 'tool', content: r.content, tool_call_id: r.toolCallId,
      }))
      const nextMessages: ApiMessage[] = [
        ...batch.messagesAtCall,
        { role: 'assistant', content: null, tool_calls: batch.assistantToolCalls },
        ...toolResultMsgs,
      ]

      const nextResult = startNextTurn(withResultState, nextMessages, nextLoopCount, ctx)
      return resultEvents && resultEvents.length > 0
        ? { ...nextResult, events: [...resultEvents, ...(('events' in nextResult && nextResult.events) || [])] }
        : nextResult
    },

    ...subscriptionCases,
  }

  if (stash) {
    toolLoopCases.invoke = (state: S) => ({ state, stash: true })
  }
  Object.assign(toolLoopCases, hooks.extraCases?.toolLoop ?? {})

  toolLoop = onMessage<M, S>(toolLoopCases) as MessageHandler<M, S>

  return { idle, awaitingLlm, toolLoop }
}
