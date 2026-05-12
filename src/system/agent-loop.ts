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
  remaining:          number
  results:            { toolCallId: string; toolName: string; content: string }[]
  messagesAtCall:     ApiMessage[]
  assistantToolCalls: ToolCall[]
  spans:              Record<string, SpanHandle>
}

export type LoopTurn = {
  requestId:     string | null
  turnMessages:  ApiMessage[] | null
  pending:       string
  pendingBatch:  LoopPendingBatch | null
  toolLoopCount: number
  requestSpan:   SpanHandle | null
  llmSpan:       SpanHandle | null
  userId:        string
  clientId:      string | undefined
  /** Aggregated usage across this turn (chunks + done + toolCalls). Reset on materialize. */
  pendingUsage:  TokenUsage
}

export const initialLoopTurn = (): LoopTurn => ({
  requestId:     null,
  turnMessages:  null,
  pending:       '',
  pendingBatch:  null,
  toolLoopCount: 0,
  requestSpan:   null,
  llmSpan:       null,
  userId:        '',
  clientId:      undefined,
  pendingUsage:  { promptTokens: 0, completionTokens: 0 },
})

// ─── Base message variants the closure dispatches on ───────────────────────

/**
 * Parameters for `triggers.startTurn` — the in-process entry point used by
 * all agents. Callers construct the turn's `ApiMessage[]` themselves and
 * pass them directly.
 */
export type LoopStartTurnParams = {
  messages:      ApiMessage[]
  userId:        string
  clientId?:     string
}

export type LoopToolResultMsg = {
  type:       '_toolResult'
  toolName:   string
  toolCallId: string
  reply:      ToolFinalReply
}

export type LoopSubscriptionMsg =
  | { type: '_llmProvider'; ref: ActorRef<LlmProviderMsg> | null }

export type LoopToolRegistrationMsg =
  | { type: '_toolRegistered';   name: string; schema: ToolSchema; ref: ActorRef<ToolMsg>; mayBeLongRunning?: boolean }
  | { type: '_toolUnregistered'; name: string }

export type LoopBackgroundResultMsg = {
  type:       '_backgroundToolResult'
  toolName:   string
  toolCallId: string
  reply:      ToolFinalReply
}

/**
 * Complete set of message variants the loop dispatches on internally.
 * Agents should use `LoopMsg<Extra>` to include these plus their own
 * agent-specific variants, rather than listing them manually.
 *
 * Agents must still subscribe to the relevant topics (LlmProviderTopic,
 * ToolRegistrationTopic) in their lifecycle `start` handler — the loop
 * does not manage subscriptions.
 *
 * Note: `invoke` is NOT included here. Agents that receive `invoke`
 * messages should union `ToolInvokeMsg` into their message type and add
 * a handler in `extraCases.idle`.
 */
export type LoopBaseMsg =
  | LlmProviderReply
  | LoopToolResultMsg
  | LoopSubscriptionMsg
  | LoopToolRegistrationMsg
  | LoopBackgroundResultMsg

/**
 * Composite message type for agent actors using the loop.
 * Includes all loop-internal message variants. Extend with agent-specific
 * extras via the type parameter.
 *
 * Usage:
 *   type MyAgentMsg = LoopMsg<{ type: 'userMessage'; text: string }>
 *
 * When the agent has no extra messages:
 *   type MyAgentMsg = LoopMsg
 */
export type LoopMsg<Extra extends { type: string } = never> = LoopBaseMsg | Extra

// ─── Hook surface ──────────────────────────────────────────────────────────

export type LoopCompletionAction<M extends { type: string }, S> = {
  state:       S
  unstashAll?: boolean
  /** Override the post-completion handler. Defaults to the loop's idle. */
  become?:     MessageHandler<M, S>
  /** Domain events to emit alongside the transition. */
  events?:     TypedEvent[]
}

/** Result of an `onChunk` / `onReasoningChunk` hook. Either a bare state, or state plus events emitted alongside the chunk. */
export type LoopChunkResult<S> = S | { state: S; events?: TypedEvent[] }

export type AgentLoopHooks<S, M extends { type: string }> = {
  /** Role string sent on every LLM stream message (e.g. 'google', 'memory-recall'). */
  role:         string
  /** Operation name used when creating the per-request root span. */
  spanName:     string
  /** Prefix used in info/warn/error log messages. Defaults to `spanName`. */
  logPrefix?:   string

  // ─── Per-actor config ───
  /** Either a constant tool collection (immutable) or an accessor that reads from state (dynamic — registered/unregistered at runtime). */
  tools:        ToolCollection | ((s: S) => ToolCollection)
  /** Extra schemas to advertise to the LLM that are NOT in `tools` (no dispatch ref). */
  extraToolSchemas?: (s: S) => Tool[]
  model:        string
  maxToolLoops: number

  // ─── Optional initial LLM ref (agents that receive it via constructor rather than subscription) ───
  initialLlmRef?: ActorRef<LlmProviderMsg> | null

  // ─── Completion handlers ───
  /** Called on `llmDone` after the request span is closed. Returned state is applied and the actor becomes idle (or `action.become`). */
  onComplete:    (s: S, finalText: string, turn: LoopTurn, ctx: ActorContext<M>) => LoopCompletionAction<M, S>
  /** Called on `llmError`. Spans are already closed by the closure. */
  onLlmError:    (s: S, error: unknown,  ctx: ActorContext<M>) => LoopCompletionAction<M, S>
  /** Called when the tool-loop ceiling is hit. The current `pending` text is passed in. */
  onLoopLimit:   (s: S, finalText: string, ctx: ActorContext<M>) => LoopCompletionAction<M, S>

  // ─── Optional streaming hooks ───
  /** Per-token text chunk. Return either a new state (no events) or `{ state, events }`. */
  onChunk?:           (s: S, chunkText: string, requestId: string, ctx: ActorContext<M>) => LoopChunkResult<S>
  /** Per-token reasoning chunk. Same return shape as `onChunk`. */
  onReasoningChunk?:  (s: S, chunkText: string, requestId: string, ctx: ActorContext<M>) => LoopChunkResult<S>

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
   * Called once per completed tool batch with the canonical
   * `[assistant{tool_calls}, tool, tool, ...]` sequence — exactly the shape
   * the chat-completions API expects to be appended to history. Agents
   * typically forward this to a HistoryStore. Skip the call (no-op) for
   * agents that maintain their own scratch and don't share to history.
   * Fires whether the loop continues or terminates (loopLimit), so agents
   * can record the batch regardless of how the turn ends.
   */
  onBatchHistoryReady?: (
    s: S,
    messages: ApiMessage[],
    ctx: ActorContext<M>,
  ) => { state: S; events?: TypedEvent[] }

  /**
   * Pre-dispatch observer for `llmToolCalls`. Runs after the requestId guard
   * and after the llmSpan is closed, before the loop partitions and dispatches
   * calls. Returned events are emitted alongside the transition (e.g. a
   * `tooling` notification). The loop always proceeds with normal dispatch.
   */
  onToolCalls?: (
    s:     S,
    calls: Extract<LlmProviderReply, { type: 'llmToolCalls' }>['calls'],
    ctx:   ActorContext<M>,
  ) => { events?: TypedEvent[] } | void

  /**
   * Mutator for the tool collection in state. When provided, the loop handles
   * `_toolRegistered` and `_toolUnregistered` messages internally across all
   * three phase handlers — the consumer does not need to list them in
   * `extraCases`.
   *
   * Only meaningful when `tools` is a `(s: S) => ToolCollection` function
   * (dynamic tools). When `tools` is a static `ToolCollection`, tool
   * registration has no effect and `setTools` should not be provided.
   */
  setTools?: (s: S, tools: ToolCollection) => S

  /**
   * Called when a background (long-running) tool completes while the agent
   * is idle. The loop handles stashing when the agent is busy (awaitingLlm
   * or toolLoop) — the hook is only invoked in the idle phase.
   *
   * Returns a standard `ActorResult<M, S>`, so the agent can call
   * `triggers.startTurn()` from within the hook if desired.
   *
   * When provided, the loop passes `onCompletion` to `invokeTool`, producing
   * `_backgroundToolResult` messages internally. When omitted, `toolPending`
   * replies are converted to `toolError` (existing default behavior).
   *
   * Replaces `onToolPending`. If both are provided, `onBackgroundResult`
   * takes priority.
   */
  onBackgroundResult?: (
    s: S,
    result: { toolName: string; toolCallId: string; reply: ToolFinalReply },
    ctx: ActorContext<M>,
  ) => ActorResult<M, S>

  /**
   * @deprecated Use `onBackgroundResult` instead. If both are provided,
   * `onBackgroundResult` takes priority.
   */
  onToolPending?: (call: { toolName: string; toolCallId: string }, reply: ToolFinalReply) => M

  /**
   * Extra message-type cases to merge into the internal idle/awaitingLlm/toolLoop
   * handlers. Survives `become` transitions because the loop's materialize uses
   * the merged handlers, not the bare ones. Use for shell-specific messages
   * like userMessage, _toolRegistered, _userContext, _planWriteDone, etc.
   */
  extraCases?: {
    all?:         Record<string, (s: S, msg: any, ctx: ActorContext<M>) => ActorResult<M, S>>
    idle?:        Record<string, (s: S, msg: any, ctx: ActorContext<M>) => ActorResult<M, S>>
    awaitingLlm?: Record<string, (s: S, msg: any, ctx: ActorContext<M>) => ActorResult<M, S>>
    toolLoop?:    Record<string, (s: S, msg: any, ctx: ActorContext<M>) => ActorResult<M, S>>
  }

  // ─── Knobs ───
  /**
   * Stash concurrent `_backgroundToolResult` messages while a turn is in
   * flight. Default: true.
   *
   * Agents that receive external triggers (`invoke`, `userMessage`, etc.)
   * must add their own stashing logic in `extraCases` if desired.
   */
  stashConcurrent?:   boolean
}

// ─── Closure result ────────────────────────────────────────────────────────

export type AgentLoopPhases<M extends { type: string }, S> = {
  idle:        MessageHandler<M, S>
  awaitingLlm: MessageHandler<M, S>
  toolLoop:    MessageHandler<M, S>
}

export type AgentLoopTriggers<M extends { type: string }, S> = {
  /**
   * In-process turn entry for all agents. Starts a turn directly from
   * already-built `ApiMessage[]`. Caller must have applied any state
   * mutations (e.g. appending to history) before calling.
   */
  startTurn:   (state: S, params: LoopStartTurnParams, ctx: ActorContext<M>) => ActorResult<M, S>
}

export type AgentLoopHandle<M extends { type: string }, S> = {
  phases: AgentLoopPhases<M, S>
  triggers: AgentLoopTriggers<M, S>
  readonly isReady: boolean
}

/** @deprecated Use the split return `{ phases, triggers }` instead. */
export type AgentLoopHandlers<M extends { type: string }, S> = AgentLoopPhases<M, S> & AgentLoopTriggers<M, S>

// ─── Implementation ────────────────────────────────────────────────────────

export const AgentLoop = <S, M extends { type: string }>(
  hooks: AgentLoopHooks<S, M>,
): AgentLoopHandle<M, S> => {
  const log       = hooks.logPrefix ?? hooks.spanName
  const { tools: toolsCfg, model, maxToolLoops } = hooks

  // ── Closure state (mutable, actor-single-threaded) ────────────────────────
  let turn: LoopTurn = initialLoopTurn()
  let llmRef: ActorRef<LlmProviderMsg> | null = hooks.initialLlmRef ?? null

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

  const materialize = (a: LoopCompletionAction<M, S>): ActorResult<M, S> => {
    turn = initialLoopTurn()
    return {
      state:      a.state,
      become:     a.become ?? idle,
      unstashAll: a.unstashAll ?? true,
      ...(a.events ? { events: a.events } : {}),
    }
  }

  // ── Helper: send `stream` to LLM and return the new llmSpan ───────────────
  const sendStream = (state:S ,requestId:string, messages:ApiMessage[], ctx:ActorContext<M>): SpanHandle | null => {
    const llmSpan = turn.requestSpan
      ? ctx.trace.child(turn.requestSpan.traceId, turn.requestSpan.spanId, 'llm-call', { model })
      : null
    const schemas = resolveSchemas(state)
    llmRef!.send({
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
    _llmProvider: (state: S, msg: Extract<LoopSubscriptionMsg, { type: '_llmProvider' }>) => {
      llmRef = msg.ref
      return { state }
    },
  }

  // ── Tool registration cases (shared across all three handlers) ────────────
  const toolRegistrationCases: Record<
    string, (state: S, msg: any, ctx: ActorContext<M>) => ActorResult<M, S>
  > = hooks.setTools ? {
    _toolRegistered: (state, msg) => ({
      state: hooks.setTools!(state, {
        ...resolveTools(state),
        [msg.name]: { schema: msg.schema, ref: msg.ref, mayBeLongRunning: msg.mayBeLongRunning },
      }),
    }),
    _toolUnregistered: (state, msg) => {
      const { [msg.name]: _, ...rest } = resolveTools(state)
      return { state: hooks.setTools!(state, rest) }
    },
  } : {}

  // ── Background result cases (idle only; busy phases stash below) ──────────
  const backgroundResultCases: Record<string, (state: S, msg: any, ctx: ActorContext<M>) => ActorResult<M, S>> = hooks.onBackgroundResult ? {
    _backgroundToolResult: (state, msg, ctx) =>
      hooks.onBackgroundResult!(state, {
        toolName:   msg.toolName,
        toolCallId: msg.toolCallId,
        reply:      msg.reply,
      }, ctx),
  } : {}

  // ── Helper: drive the next turn (used by toolLoop after a complete batch) ──
  const startNextTurn = (state:S, nextMessages: ApiMessage[], nextLoopCount: number, ctx: ActorContext<M>): ActorResult<M, S> => {
    const requestId = crypto.randomUUID()
    turn = {
      ...turn,
      requestId,
      turnMessages:  nextMessages,
      pending:       '',
      pendingBatch:  null,
      toolLoopCount: nextLoopCount,
      llmSpan:       null,
    }
    const llmSpan = sendStream(state, requestId, nextMessages, ctx)
    turn = { ...turn, llmSpan }
    return { state, become: awaitingLlm }
  }

  // ── startTurn: in-process entry, shared by all agents ──
  const startTurn = (state:S, params: LoopStartTurnParams, ctx: ActorContext<M>): ActorResult<M, S> => {
    let requestSpan: SpanHandle | null = null
    const parent = ctx.trace.fromHeaders()
    if (parent) {
      requestSpan = ctx.trace.child(parent.traceId, parent.spanId, hooks.spanName, {})
    }

    const requestId = crypto.randomUUID()
    turn = {
      ...turn,
      requestId,
      turnMessages:  params.messages,
      pending:       '',
      pendingBatch:  null,
      toolLoopCount: 0,
      requestSpan,
      llmSpan:       null,
      userId:        params.userId,
      clientId:      params.clientId,
      pendingUsage:  { promptTokens: 0, completionTokens: 0 },
    }
    const llmSpan = sendStream(state, requestId, params.messages, ctx)
    turn = { ...turn, llmSpan }
    return { state, become: awaitingLlm }
  }

  // ── idle ─────────────────────────────────────────────────────────────────
  const idleCases: any = {
    ...subscriptionCases,
    ...toolRegistrationCases,
    ...backgroundResultCases,
    ...(hooks.extraCases?.all ?? {}),
    ...(hooks.extraCases?.idle ?? {}),
  }

  idle = onMessage<M, S>(idleCases) as MessageHandler<M, S>

  // ── Helpers for new hook return shapes ────────────────────────────────────
  const normalizeChunkResult = (r: LoopChunkResult<S>): { state: S; events?: TypedEvent[] } =>
    (r && typeof r === 'object' && 'state' in (r as object))
      ? r as { state: S; events?: TypedEvent[] }
      : { state: r as S }

  const addUsage = (a: TokenUsage, b: TokenUsage | null | undefined): TokenUsage =>
    b ? { promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens } : a

  // ── awaitingLlm ──────────────────────────────────────────────────────────
  const awaitingLlmCases: any = {
    llmChunk: (state: S, msg: Extract<LlmProviderReply, { type: 'llmChunk' }>, ctx: ActorContext<M>) => {
      if (msg.requestId !== turn.requestId) return { state }
      let next = state
      turn = { ...turn, pending: turn.pending + msg.text }
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
      if (msg.requestId !== turn.requestId) return { state }

      turn.llmSpan?.done({ toolCalls: msg.calls.map(c => c.name) })
      ctx.log.info(`${log}: tool calls`, { tools: msg.calls.map(c => c.name) })

      // Aggregate usage on this turn boundary.
      const accumulatedUsage = addUsage(turn.pendingUsage, msg.usage)

      // Allow agents to emit pre-dispatch events (e.g. chatbot's `tooling`
      // notification). The hook is observational — the loop always proceeds.
      let advertEvents: TypedEvent[] | undefined
      if (hooks.onToolCalls) {
        const observed = hooks.onToolCalls(
          state,
          msg.calls,
          ctx,
        )
        advertEvents = observed?.events
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

      const batch: LoopPendingBatch = {
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
            {
              headers: toolSpan ? ctx.trace.injectHeaders(toolSpan) : undefined,
              onCompletion: hooks.onBackgroundResult
                ? (reply: ToolFinalReply): M => ({
                    type:       '_backgroundToolResult',
                    toolName:   call.name,
                    toolCallId: call.id,
                    reply,
                  } as unknown as M)
                : hooks.onToolPending
                  ? (reply: ToolFinalReply): M => hooks.onToolPending!({ toolName: call.name, toolCallId: call.id }, reply)
                  : undefined,
            },
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

      turn = { ...turn, requestId: null, llmSpan: null, pendingBatch: batch, pendingUsage: accumulatedUsage }
      return advertEvents && advertEvents.length > 0
        ? { state, become: toolLoop, events: advertEvents }
        : { state, become: toolLoop }
    },

    llmDone: (state: S, msg: Extract<LlmProviderReply, { type: 'llmDone' }>, ctx: ActorContext<M>) => {
      if (msg.requestId !== turn.requestId) return { state }
      turn.llmSpan?.done()
      turn.requestSpan?.done()
      ctx.log.info(`${log}: done`, { chars: turn.pending.length })
      turn = { ...turn, pendingUsage: addUsage(turn.pendingUsage, msg.usage) }
      return materialize(hooks.onComplete(state, turn.pending, turn, ctx))
    },

    llmError: (state: S, msg: Extract<LlmProviderReply, { type: 'llmError' }>, ctx: ActorContext<M>) => {
      if (msg.requestId !== turn.requestId) return { state }
      turn.llmSpan?.error(msg.error)
      turn.requestSpan?.error(msg.error)
      ctx.log.error(`${log}: LLM error`, { error: String(msg.error) })
      return materialize(hooks.onLlmError(state, msg.error, ctx))
    },

    ...subscriptionCases,
  }

  Object.assign(awaitingLlmCases, subscriptionCases)
  Object.assign(awaitingLlmCases, toolRegistrationCases)
  if (hooks.onBackgroundResult) {
    awaitingLlmCases._backgroundToolResult = (state: S) => ({ state, stash: true })
  }
  Object.assign(awaitingLlmCases, hooks.extraCases?.all ?? {})
  Object.assign(awaitingLlmCases, hooks.extraCases?.awaitingLlm ?? {})

  awaitingLlm = onMessage<M, S>(awaitingLlmCases) as MessageHandler<M, S>

  // ── toolLoop ─────────────────────────────────────────────────────────────
  const toolLoopCases: any = {
    _toolResult: (state: S, msg: LoopToolResultMsg, ctx: ActorContext<M>) => {
      const batch = turn.pendingBatch!
      const span  = batch.spans[msg.toolCallId]
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
        turn = { ...turn, pendingBatch: { ...batch, remaining, results: updated } }
        return resultEvents && resultEvents.length > 0 ? { state: withResultState, events: resultEvents } : { state: withResultState }
      }

      // Batch complete — build the canonical [assistant shell, tool*] sequence
      // and let the agent commit it to history (or drop it). Fires regardless
      // of whether the loop continues (next turn) or terminates (loopLimit).
      const toolResultMsgs: ApiMessage[] = updated.map(r => ({
        role: 'tool', content: r.content, tool_call_id: r.toolCallId,
      }))
      const batchHistory: ApiMessage[] = [
        { role: 'assistant', content: null, tool_calls: batch.assistantToolCalls },
        ...toolResultMsgs,
      ]

      let withBatchState = withResultState
      let batchEvents: TypedEvent[] | undefined
      if (hooks.onBatchHistoryReady) {
        const r = hooks.onBatchHistoryReady(withResultState, batchHistory, ctx)
        withBatchState = r.state
        batchEvents    = r.events
      }

      const mergedPriorEvents = (() => {
        const a = resultEvents ?? []
        const b = batchEvents ?? []
        return a.length + b.length > 0 ? [...a, ...b] : undefined
      })()

      const nextLoopCount = turn.toolLoopCount + 1
      if (nextLoopCount >= maxToolLoops) {
        ctx.log.warn(`${log}: tool loop limit reached`, { limit: maxToolLoops })
        turn.requestSpan?.error('Tool loop limit reached')
        const completion = hooks.onLoopLimit(withBatchState, turn.pending, ctx)
        const merged = mergedPriorEvents
          ? { ...completion, events: [...mergedPriorEvents, ...(completion.events ?? [])] }
          : completion
        return materialize(merged)
      }

      const nextMessages: ApiMessage[] = [
        ...batch.messagesAtCall,
        ...batchHistory,
      ]

      const nextResult = startNextTurn(withBatchState, nextMessages, nextLoopCount, ctx)
      return mergedPriorEvents
        ? { ...nextResult, events: [...mergedPriorEvents, ...(('events' in nextResult && nextResult.events) || [])] }
        : nextResult
    },

    ...subscriptionCases,
  }

  Object.assign(toolLoopCases, subscriptionCases)
  Object.assign(toolLoopCases, toolRegistrationCases)
  if (hooks.onBackgroundResult) {
    toolLoopCases._backgroundToolResult = (state: S) => ({ state, stash: true })
  }
  Object.assign(toolLoopCases, hooks.extraCases?.all ?? {})
  Object.assign(toolLoopCases, hooks.extraCases?.toolLoop ?? {})

  toolLoop = onMessage<M, S>(toolLoopCases) as MessageHandler<M, S>

  return { phases: { idle, awaitingLlm, toolLoop }, triggers: { startTurn }, get isReady() { return llmRef !== null } }
}
